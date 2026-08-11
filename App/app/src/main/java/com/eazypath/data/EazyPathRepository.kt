package com.eazypath.data

import android.content.Context
import android.graphics.Rect
import android.net.Uri
import android.util.Log
import com.eazypath.BuildConfig
import com.eazypath.data.location.DeviceLocation
import com.eazypath.data.location.OneShotLocationProvider
import com.eazypath.data.map.AmapWalkingRoutePlanner
import com.eazypath.data.map.OrdinaryWalkingRoute
import com.eazypath.data.map.RouteCoordinate
import com.eazypath.data.media.EvidenceImageAnalysis
import com.eazypath.data.media.EvidenceImageRedactor
import com.eazypath.data.media.PreparedEvidence
import com.eazypath.data.media.evidencePartRanges
import com.eazypath.data.network.ApiEnvelope
import com.eazypath.data.network.AiConsentItem
import com.eazypath.data.network.AiConsentUpdateRequest
import com.eazypath.data.network.ChallengeRequest
import com.eazypath.data.network.CreateTaskRequest
import com.eazypath.data.network.EazyPathApiService
import com.eazypath.data.network.FeatureDefinition
import com.eazypath.data.network.InteractionProfile
import com.eazypath.data.network.LinkResolveRequest
import com.eazypath.data.network.LocationProofData
import com.eazypath.data.network.LocationProofRequest
import com.eazypath.data.network.MobilityProfile
import com.eazypath.data.network.NetworkClient
import com.eazypath.data.network.ObservationData
import com.eazypath.data.network.ObservationRequest
import com.eazypath.data.network.PlaceDetails
import com.eazypath.data.network.PlaceSearchItem
import com.eazypath.data.network.ProfileData
import com.eazypath.data.network.RefreshRequest
import com.eazypath.data.network.RegisterRequest
import com.eazypath.data.network.ReviewTask
import com.eazypath.data.network.ReviewTaskPage
import com.eazypath.data.network.ReviewSubmissionData
import com.eazypath.data.network.ServiceAction
import com.eazypath.data.network.TaskDetails
import com.eazypath.data.network.TaskEventAuthenticationRecovery
import com.eazypath.data.network.TaskEventProtocol
import com.eazypath.data.network.TaskEventSignal
import com.eazypath.data.network.UpdateProfileRequest
import com.eazypath.data.network.UploadInitializeRequest
import com.eazypath.data.network.VerificationDetails
import com.eazypath.data.network.VoteRequest
import com.eazypath.data.security.InstallationIdentity
import com.eazypath.data.security.SecureSessionStore
import com.eazypath.data.security.StoredSession
import com.google.gson.JsonElement
import com.google.gson.Gson
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.retryWhen
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import retrofit2.HttpException
class EazyPathRepository(private val context: Context) {
    private val identity = InstallationIdentity(context)
    private val sessionStore = SecureSessionStore(context)
    private val sessionMutex = Mutex()
    private val network = NetworkClient { sessionStore.readSafely()?.accessToken }
    private val locationProvider = OneShotLocationProvider(context)
    private val walkingRoutePlanner = AmapWalkingRoutePlanner(context)
    private val publicApi: EazyPathApiService = network.publicApi
    private val api: EazyPathApiService = network.authenticatedApi

    suspend fun ensureSession() {
        sessionMutex.withLock {
            val current = sessionStore.readSafely()
            if (current != null && current.accessExpiresAtEpochMs > System.currentTimeMillis() + 30_000L) return
            if (current != null) {
                val refreshed = runCatching { publicApi.refresh(RefreshRequest(current.refreshToken)).requireData() }.getOrNull()
                if (refreshed != null) {
                    sessionStore.write(refreshed.accessToken, refreshed.refreshToken, refreshed.accessTokenExpiresIn)
                    return
                }
                sessionStore.clear()
            }
            registerInstallation()
        }
    }

    suspend fun getProfile(): ProfileData {
        ensureSession()
        return api.getProfile().requireData()
    }

    suspend fun updateProfile(mobility: MobilityProfile, interaction: InteractionProfile): ProfileData {
        ensureSession()
        return api.updateProfile(UpdateProfileRequest(mobility, interaction)).requireData()
    }

    suspend fun getAiConsents(): List<AiConsentItem> {
        ensureSession()
        return api.getAiConsents().requireData().consents
    }

    suspend fun updateAiConsent(capability: String, granted: Boolean, current: AiConsentItem): AiConsentItem {
        ensureSession()
        return apiCall {
            api.updateAiConsent(
                capability,
                AiConsentUpdateRequest(
                    granted = granted,
                    policyVersion = current.policyVersion,
                    expectedVersion = current.version,
                ),
            )
        }
    }

    suspend fun createTask(content: String, profileVersion: Int): String {
        ensureSession()
        return apiCall {
            api.createTask(
                idempotencyKey = UUID.randomUUID().toString(),
                request = CreateTaskRequest(content = content, profileVersion = profileVersion),
            )
        }.taskId
    }

    suspend fun getTask(taskId: String): TaskDetails {
        ensureSession()
        return try {
            api.getTask(taskId).requireData()
        } catch (error: HttpException) {
            if (error.code() != 401) throw error
            refreshSessionAfterUnauthorized()
            api.getTask(taskId).requireData()
        }
    }

    fun observeTaskEvents(taskId: String): Flow<TaskEventSignal> {
        val cursor = AtomicLong(0)
        val authenticationRecovery = TaskEventAuthenticationRecovery()
        return flow {
            ensureSession()
            emitAll(openTaskEventStream(taskId, cursor, authenticationRecovery))
        }.retryWhen { cause, attempt ->
            if (cause is CancellationException) return@retryWhen false
            if (cause is TaskEventStreamException && !cause.isRetryable()) return@retryWhen false
            if (cause is TaskEventStreamException && cause.statusCode == 401) {
                if (!authenticationRecovery.tryStartRecovery()) return@retryWhen false
                refreshSessionAfterUnauthorized()
            }
            delay(TaskEventProtocol.retryDelayMillis(attempt))
            true
        }
    }

    private fun openTaskEventStream(
        taskId: String,
        cursor: AtomicLong,
        authenticationRecovery: TaskEventAuthenticationRecovery,
    ): Flow<TaskEventSignal> = callbackFlow {
        val request = Request.Builder()
            .url("${BuildConfig.API_BASE_URL.ensureTrailingSlash()}api/v1/tasks/$taskId/events?after=${cursor.get()}")
            .header("Accept", "text/event-stream")
            .apply { if (cursor.get() > 0) header("Last-Event-ID", cursor.get().toString()) }
            .apply { sessionStore.readSafely()?.accessToken?.let { header("Authorization", "Bearer $it") } }
            .build()
        var terminalSeen = false
        val source = EventSources.createFactory(network.eventClient).newEventSource(
            request,
            object : EventSourceListener() {
                override fun onOpen(eventSource: EventSource, response: Response) {
                    authenticationRecovery.markStreamHealthy()
                }

                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    val signal = TaskEventProtocol.parse(taskId, cursor.get(), id, type, data)
                    if (signal == null) {
                        if (type != "heartbeat") Log.w("TaskEventProtocol", "忽略不兼容任务事件: ${type?.take(64) ?: "missing-type"}")
                        return
                    }
                    val delivered = trySend(signal)
                    if (delivered.isFailure) {
                        close(TaskEventStreamException(null, delivered.exceptionOrNull()))
                        return
                    }
                    if (signal.type == "stream.reset") cursor.set(signal.id)
                    else cursor.updateAndGet { previous -> maxOf(previous, signal.id) }
                    authenticationRecovery.markStreamHealthy()
                    terminalSeen = signal.terminal
                    if (terminalSeen) close()
                }

                override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                    close(TaskEventStreamException(response?.code, t))
                }

                override fun onClosed(eventSource: EventSource) {
                    if (terminalSeen) close() else close(TaskEventStreamException(null, null))
                }
            },
        )
        awaitClose { source.cancel() }
    }

    private suspend fun refreshSessionAfterUnauthorized() {
        sessionMutex.withLock {
            val current = sessionStore.readSafely()
            val refreshed = current?.let {
                runCatching { publicApi.refresh(RefreshRequest(it.refreshToken)).requireData() }.getOrNull()
            }
            if (refreshed != null) {
                sessionStore.write(refreshed.accessToken, refreshed.refreshToken, refreshed.accessTokenExpiresIn)
            } else {
                sessionStore.clear()
                registerInstallation()
            }
        }
    }

    suspend fun createVerification(uri: Uri, scene: String): Pair<String, String> {
        ensureSession()
        val resolver = context.contentResolver
        val mimeType = resolver.getType(uri) ?: "application/octet-stream"
        require(mimeType in setOf("image/jpeg", "image/png", "image/webp")) { "仅支持 JPEG、PNG 或 WebP 图片" }
        val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: error("无法读取所选图片")
        require(bytes.size <= 10 * 1024 * 1024) { "图片不能超过 10MB" }
        val image = MultipartBody.Part.createFormData("image", "verification-image", bytes.toRequestBody(mimeType.toMediaType()))
        val result = apiCall { api.createVerification(image, scene.toRequestBody("text/plain".toMediaType())) }
        return result.verificationId to result.privacyNotice
    }

    suspend fun getVerification(id: String): VerificationDetails {
        ensureSession()
        return api.getVerification(id).requireData()
    }

    suspend fun getReviewTasks(cursor: String? = null): ReviewTaskPage {
        ensureSession()
        return api.getReviewTasks(cursor).requireData()
    }

    suspend fun getMyReviewSubmission(id: String, submissionId: String): ReviewSubmissionData {
        ensureSession()
        return api.getMyReviewSubmission(id, submissionId).requireData()
    }

    suspend fun verifyReviewLocation(reviewTaskId: String, placeId: String): LocationProofData {
        ensureSession()
        val location = locationProvider.locateAfterPrivacyConsent()
        return api.verifyLocationProof(
            LocationProofRequest(
                placeId = placeId,
                reviewTaskId = reviewTaskId,
                latitude = location.latitude,
                longitude = location.longitude,
                accuracyMeters = location.accuracyMeters,
            ),
        ).requireData().also { require(it.proofId != null) { "服务端未返回有效的位置证明" } }
    }

    suspend fun submitReview(
        id: String,
        submissionId: String,
        answer: String,
        locationProofId: String?,
        evidence: PreparedEvidence?,
    ): ReviewSubmissionData {
        ensureSession()
        val mediaId = evidence?.let { uploadEvidence(it) }
        return api.submitReview(id, VoteRequest(submissionId, answer, mediaId, locationProofId)).requireData()
    }

    suspend fun searchPlaces(query: String): List<PlaceSearchItem> {
        ensureSession()
        return api.searchPlaces(query.trim()).requireData()
    }

    suspend fun getPlaceDetails(placeId: String): PlaceDetails {
        ensureSession()
        return api.getPlaceDetails(placeId).requireData()
    }

    suspend fun resolveAmapActions(place: PlaceSearchItem): List<ServiceAction> {
        ensureSession()
        return api.resolveLinkActions(
            LinkResolveRequest(
                destinationName = place.name,
                longitude = place.longitude,
                latitude = place.latitude,
                accessibilityNotes = "高德未提供轮椅路线模式，请结合 EazyPath 地点证据和现场情况复核",
            ),
        ).requireData().actions
    }

    suspend fun locateOnceForMap(): DeviceLocation = locationProvider.locateAfterPrivacyConsent()

    suspend fun planOrdinaryWalkingRoute(
        origin: RouteCoordinate,
        destination: RouteCoordinate,
    ): OrdinaryWalkingRoute = walkingRoutePlanner.plan(origin, destination)

    suspend fun getEvidenceFeatureDefinitions(): List<FeatureDefinition> {
        ensureSession()
        return api.getFeatureDefinitions().requireData()
    }

    suspend fun analyzeEvidenceImage(uri: Uri): EvidenceImageAnalysis = EvidenceImageRedactor.analyze(context, uri)

    fun prepareEvidence(analysis: EvidenceImageAnalysis, regions: List<Rect>): PreparedEvidence =
        EvidenceImageRedactor.prepare(analysis, regions)

    suspend fun submitObservation(
        placeId: String,
        featureKey: String,
        value: JsonElement,
        evidence: PreparedEvidence?,
    ): ObservationData {
        ensureSession()
        val mediaIds = evidence?.let { listOf(uploadEvidence(it)) }.orEmpty()
        return api.createObservation(
            ObservationRequest(
                placeId = placeId,
                featureKey = featureKey,
                value = value,
                mediaIds = mediaIds,
            ),
        ).requireData()
    }

    private suspend fun uploadEvidence(evidence: PreparedEvidence): String {
        require(evidence.bytes.isNotEmpty()) { "脱敏图片不能为空" }
        require(evidence.bytes.size <= 10 * 1024 * 1024) { "脱敏图片不能超过 10MB" }
        val partSize = 1024 * 1024
        val ranges = evidencePartRanges(evidence.bytes.size, partSize)
        val totalParts = ranges.size
        val wholeHash = evidence.bytes.sha256Hex()
        val upload = api.initializeUpload(
            idempotencyKey = evidenceUploadIdempotencyKey(evidence.uploadDraftId, wholeHash),
            request = UploadInitializeRequest(
                fileName = evidence.fileName,
                mimeType = evidence.mimeType,
                totalBytes = evidence.bytes.size,
                totalParts = totalParts,
                sha256 = wholeHash,
            ),
        ).requireData()
        upload.completedMediaId?.let { return it }
        require(upload.partSize == partSize && upload.totalParts == totalParts) { "服务端分片协议不兼容" }
        val receivedParts = api.getUpload(upload.uploadId).requireData().receivedParts.map { it.partNumber }.toSet()
        ranges.forEachIndexed { index, range ->
            if (index + 1 in receivedParts) return@forEachIndexed
            val part = evidence.bytes.copyOfRange(range.first, range.last + 1)
            api.uploadPart(
                uploadId = upload.uploadId,
                partNumber = index + 1,
                sha256 = part.sha256Hex(),
                body = part.toRequestBody("application/octet-stream".toMediaType()),
            ).requireData()
        }
        return api.completeUpload(upload.uploadId).requireData().mediaId
    }

    private suspend fun registerInstallation() {
        val guid = identity.installationGuid
        val challenge = publicApi.createChallenge(ChallengeRequest(guid)).requireData()
        val registered = publicApi.register(
            RegisterRequest(
                challengeId = challenge.challengeId,
                challenge = challenge.challenge,
                installationGuid = guid,
                publicKeySpki = identity.publicKeySpkiBase64(),
                signature = identity.sign(challenge.signingPayload),
            ),
        ).requireData()
        sessionStore.write(registered.accessToken, registered.refreshToken, registered.accessTokenExpiresIn)
    }

    private fun SecureSessionStore.readSafely(): StoredSession? = runCatching { read() }.getOrElse {
        clear()
        null
    }

    private fun String.ensureTrailingSlash(): String = if (endsWith('/')) this else "$this/"
}

private class TaskEventStreamException(
    val statusCode: Int?,
    cause: Throwable?,
) : IllegalStateException("任务事件连接已断开", cause) {
    fun isRetryable(): Boolean = statusCode == null || statusCode == 401 || statusCode == 408 ||
        statusCode == 429 || (statusCode in 500..599)
}

private fun ByteArray.sha256Hex(): String = MessageDigest.getInstance("SHA-256")
    .digest(this)
    .joinToString("") { byte -> "%02x".format(byte) }

internal fun evidenceUploadIdempotencyKey(uploadDraftId: String, wholeHash: String): String =
    "android-evidence-$uploadDraftId-$wholeHash"

class ApiException(val code: String, message: String) : IllegalStateException(message)

private data class ApiFailureEnvelope(val code: String?, val message: String?)

internal fun parseApiFailure(statusCode: Int, body: String?): ApiException {
    val parsed = body?.let { runCatching { Gson().fromJson(it, ApiFailureEnvelope::class.java) }.getOrNull() }
    return ApiException(
        code = parsed?.code?.takeIf { it.isNotBlank() } ?: "HTTP_$statusCode",
        message = parsed?.message?.takeIf { it.isNotBlank() } ?: "服务请求失败（$statusCode）",
    )
}

private suspend fun <T> apiCall(call: suspend () -> ApiEnvelope<T>): T = try {
    call().requireData()
} catch (error: HttpException) {
    throw parseApiFailure(error.code(), error.response()?.errorBody()?.string())
}

internal fun isRetryableTaskSnapshotError(error: Throwable): Boolean = when (error) {
    is IOException -> true
    is HttpException -> error.code() == 408 || error.code() == 429 || error.code() in 500..599
    else -> false
}

private fun <T> ApiEnvelope<T>.requireData(): T {
    if (code != "OK" || data == null) throw ApiException(code, message)
    return data
}
