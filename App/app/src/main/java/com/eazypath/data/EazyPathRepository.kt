package com.eazypath.data

import android.content.Context
import android.graphics.Rect
import android.net.Uri
import com.eazypath.BuildConfig
import com.eazypath.data.media.EvidenceImageAnalysis
import com.eazypath.data.media.EvidenceImageRedactor
import com.eazypath.data.media.PreparedEvidence
import com.eazypath.data.media.evidencePartRanges
import com.eazypath.data.network.ApiEnvelope
import com.eazypath.data.network.ChallengeRequest
import com.eazypath.data.network.CreateTaskRequest
import com.eazypath.data.network.EazyPathApiService
import com.eazypath.data.network.FeatureDefinition
import com.eazypath.data.network.InteractionProfile
import com.eazypath.data.network.MobilityProfile
import com.eazypath.data.network.NetworkClient
import com.eazypath.data.network.ObservationData
import com.eazypath.data.network.ObservationRequest
import com.eazypath.data.network.PlaceSearchItem
import com.eazypath.data.network.ProfileData
import com.eazypath.data.network.RefreshRequest
import com.eazypath.data.network.RegisterRequest
import com.eazypath.data.network.ReviewTask
import com.eazypath.data.network.TaskDetails
import com.eazypath.data.network.UpdateProfileRequest
import com.eazypath.data.network.UploadInitializeRequest
import com.eazypath.data.network.VerificationDetails
import com.eazypath.data.network.VoteRequest
import com.eazypath.data.security.InstallationIdentity
import com.eazypath.data.security.SecureSessionStore
import com.eazypath.data.security.StoredSession
import com.google.gson.JsonElement
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
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
class EazyPathRepository(private val context: Context) {
    private val identity = InstallationIdentity(context)
    private val sessionStore = SecureSessionStore(context)
    private val sessionMutex = Mutex()
    private val network = NetworkClient { sessionStore.readSafely()?.accessToken }
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

    suspend fun createTask(content: String, profileVersion: Int): String {
        ensureSession()
        return api.createTask(
            idempotencyKey = UUID.randomUUID().toString(),
            request = CreateTaskRequest(content = content, profileVersion = profileVersion),
        ).requireData().taskId
    }

    suspend fun getTask(taskId: String): TaskDetails {
        ensureSession()
        return api.getTask(taskId).requireData()
    }

    fun observeTaskEvents(taskId: String): Flow<Unit> = callbackFlow {
        val request = Request.Builder()
            .url("${BuildConfig.API_BASE_URL.ensureTrailingSlash()}api/v1/tasks/$taskId/events")
            .header("Accept", "text/event-stream")
            .apply { sessionStore.readSafely()?.accessToken?.let { header("Authorization", "Bearer $it") } }
            .build()
        val source = EventSources.createFactory(network.eventClient).newEventSource(
            request,
            object : EventSourceListener() {
                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    trySend(Unit)
                }

                override fun onFailure(eventSource: EventSource, throwable: Throwable?, response: Response?) {
                    close(throwable ?: IllegalStateException("任务事件连接已断开"))
                }

                override fun onClosed(eventSource: EventSource) {
                    close()
                }
            },
        )
        awaitClose { source.cancel() }
    }

    suspend fun createVerification(uri: Uri, scene: String): Pair<String, String> {
        ensureSession()
        val resolver = context.contentResolver
        val mimeType = resolver.getType(uri) ?: "application/octet-stream"
        require(mimeType in setOf("image/jpeg", "image/png", "image/webp")) { "仅支持 JPEG、PNG 或 WebP 图片" }
        val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: error("无法读取所选图片")
        require(bytes.size <= 10 * 1024 * 1024) { "图片不能超过 10MB" }
        val image = MultipartBody.Part.createFormData("image", "verification-image", bytes.toRequestBody(mimeType.toMediaType()))
        val result = api.createVerification(image, scene.toRequestBody("text/plain".toMediaType())).requireData()
        return result.verificationId to result.privacyNotice
    }

    suspend fun getVerification(id: String): VerificationDetails {
        ensureSession()
        return api.getVerification(id).requireData()
    }

    suspend fun getReviewTasks(): List<ReviewTask> {
        ensureSession()
        return api.getReviewTasks().requireData()
    }

    suspend fun submitReview(id: String, answer: String) {
        ensureSession()
        api.submitReview(id, VoteRequest(answer)).requireData()
    }

    suspend fun searchPlaces(query: String): List<PlaceSearchItem> {
        ensureSession()
        return api.searchPlaces(query.trim()).requireData()
    }

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

private fun ByteArray.sha256Hex(): String = MessageDigest.getInstance("SHA-256")
    .digest(this)
    .joinToString("") { byte -> "%02x".format(byte) }

internal fun evidenceUploadIdempotencyKey(uploadDraftId: String, wholeHash: String): String =
    "android-evidence-$uploadDraftId-$wholeHash"

class ApiException(val code: String, message: String) : IllegalStateException(message)

private fun <T> ApiEnvelope<T>.requireData(): T {
    if (code != "OK" || data == null) throw ApiException(code, message)
    return data
}
