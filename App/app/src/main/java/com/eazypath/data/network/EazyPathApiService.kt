package com.eazypath.data.network

import com.google.gson.JsonElement
import com.google.gson.annotations.SerializedName
import okhttp3.MultipartBody
import okhttp3.RequestBody
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.Multipart
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Part
import retrofit2.http.Path
import retrofit2.http.Query

data class ApiEnvelope<T>(
    val code: String,
    val message: String,
    val data: T?,
)

data class ChallengeRequest(
    @SerializedName("installation_guid") val installationGuid: String,
    val purpose: String = "register",
)

data class ChallengeData(
    @SerializedName("challenge_id") val challengeId: String,
    val challenge: String,
    @SerializedName("signing_payload") val signingPayload: String,
)

data class RegisterRequest(
    @SerializedName("challenge_id") val challengeId: String,
    val challenge: String,
    @SerializedName("installation_guid") val installationGuid: String,
    @SerializedName("public_key_spki") val publicKeySpki: String,
    val signature: String,
)

data class SessionData(
    @SerializedName("installation_id") val installationId: String?,
    @SerializedName("access_token") val accessToken: String,
    @SerializedName("access_token_expires_in") val accessTokenExpiresIn: Long,
    @SerializedName("refresh_token") val refreshToken: String,
)

data class RefreshRequest(@SerializedName("refresh_token") val refreshToken: String)

data class MobilityProfile(
    val mobilityMode: String,
    val requireStepFree: Boolean,
    val minimumDoorWidthCm: Int,
    val maximumObstacleHeightCm: Double,
    val maximumSlopePercent: Double?,
    val requireAccessibleRestroom: Boolean,
    val requireRollInShower: Boolean,
    val avoidUnverifiedSegments: Boolean,
)

data class InteractionProfile(
    val largeText: Boolean,
    val highContrast: Boolean,
    val preferVoiceInput: Boolean,
    val preferVoiceOutput: Boolean,
    val hapticFeedback: Boolean,
)

data class ProfileData(
    val mobility: MobilityProfile,
    val interaction: InteractionProfile,
    val version: Int,
)

data class UpdateProfileRequest(
    val mobility: MobilityProfile,
    val interaction: InteractionProfile,
)

data class AiConsentItem(
    val capability: String,
    val title: String,
    val dataType: String,
    val purpose: String,
    val fallback: String,
    val granted: Boolean,
    val decision: String,
    val policyVersion: String,
    val consentedPolicyVersion: String?,
    val consentedProcessor: String?,
    val consentedRegion: String?,
    val noticeVerifiedAt: String,
    val grantedAt: String?,
    val revokedAt: String?,
    val version: Int?,
    val processor: String,
    val region: String,
    val privacyUrl: String,
    val retentionNotice: String,
)

data class AiConsentListData(
    @SerializedName("policy_version") val policyVersion: String,
    val consents: List<AiConsentItem>,
)

data class AiConsentUpdateRequest(
    val granted: Boolean,
    @SerializedName("policy_version") val policyVersion: String,
    @SerializedName("expected_version") val expectedVersion: Int?,
)

data class CreateTaskRequest(
    @SerializedName("input_type") val inputType: String = "text",
    val content: String,
    @SerializedName("profile_version") val profileVersion: Int,
    @SerializedName("client_timezone") val clientTimezone: String = "Asia/Shanghai",
)

data class TaskAccepted(
    @SerializedName("task_id") val taskId: String,
    val status: String,
)

data class ServiceAction(
    val type: String,
    val label: String,
    val platform: String?,
    val url: String?,
    val content: String?,
)

data class ServiceCard(
    val id: String,
    val category: String,
    val title: String,
    val status: String,
    val riskLevel: String,
    val riskMessage: String,
    val actions: List<ServiceAction>,
    val evidenceSummary: JsonElement?,
)

data class TaskDetails(
    val id: String,
    val status: String,
    val originalContent: String,
    val failureCode: String?,
    val failureMessage: String?,
    val cards: List<ServiceCard>,
)

data class VerificationAccepted(
    @SerializedName("verification_id") val verificationId: String,
    val status: String,
    @SerializedName("privacy_notice") val privacyNotice: String,
)

data class VerificationDetails(
    val id: String,
    val status: String,
    val scene: String,
    val result: JsonElement?,
    val confidence: String?,
    @SerializedName("risk_level") val riskLevel: String,
    @SerializedName("failure_code") val failureCode: String?,
    @SerializedName("temporary_media_deleted_at") val temporaryMediaDeletedAt: String?,
)

data class ReviewTask(
    val id: String,
    val reason: String,
    @SerializedName("target_type") val targetType: String,
    @SerializedName("target_id") val targetId: String,
    @SerializedName("location_radius_meters") val locationRadiusMeters: Int,
    @SerializedName("feature_key") val featureKey: String,
    @SerializedName("feature_unit") val featureUnit: String?,
    @SerializedName("place_id") val placeId: String,
    @SerializedName("place_name") val placeName: String,
    @SerializedName("feature_name") val featureName: String,
    val address: String?,
    val status: String,
    @SerializedName("historical_value") val historicalValue: JsonElement?,
    @SerializedName("historical_source") val historicalSource: String?,
    @SerializedName("historical_grade") val historicalGrade: String?,
    @SerializedName("historical_freshness_status") val historicalFreshnessStatus: String?,
    @SerializedName("historical_moderation_status") val historicalModerationStatus: String?,
    @SerializedName("historical_observed_at") val historicalObservedAt: String?,
    @SerializedName("historical_expires_at") val historicalExpiresAt: String?,
    @SerializedName("historical_has_redacted_media") val historicalHasRedactedMedia: Boolean,
    @SerializedName("created_at") val createdAt: String,
)

data class ReviewTaskPage(
    val items: List<ReviewTask>,
    @SerializedName("next_cursor") val nextCursor: String?,
)

data class VoteRequest(
    @SerializedName("submission_id") val submissionId: String,
    val answer: String,
    @SerializedName("media_id") val mediaId: String? = null,
    @SerializedName("location_proof_id") val locationProofId: String? = null,
)

data class LocationProofRequest(
    @SerializedName("place_id") val placeId: String,
    @SerializedName("review_task_id") val reviewTaskId: String,
    val latitude: Double,
    val longitude: Double,
    @SerializedName("accuracy_meters") val accuracyMeters: Double,
)

data class LocationProofData(
    @SerializedName("proof_id") val proofId: String?,
    @SerializedName("canonical_place_id") val canonicalPlaceId: String,
    @SerializedName("review_task_id") val reviewTaskId: String?,
    val passed: Boolean,
    @SerializedName("distance_bucket") val distanceBucket: String,
    @SerializedName("radius_meters") val radiusMeters: Int,
    @SerializedName("expires_at") val expiresAt: String,
    @SerializedName("privacy_notice") val privacyNotice: String,
)

data class ConsensusSummary(
    val status: String,
    val outcome: String?,
    val presentWeight: Double,
    val absentWeight: Double,
    val directionalWeight: Double,
    val dominantRatio: Double,
    val distinctInstallations: Int,
)

data class ReviewSubmissionData(
    @SerializedName("vote_weight") val voteWeight: Double,
    val consensus: ConsensusSummary,
)

data class PlaceAccessibility(
    val status: String,
    @SerializedName("verified_feature_count") val verifiedFeatureCount: Int = 0,
    val disclosure: String? = null,
)

data class PlaceSearchItem(
    val id: String,
    val name: String,
    val address: String?,
    @SerializedName("category_code") val categoryCode: String,
    val longitude: Double,
    val latitude: Double,
    val accessibility: PlaceAccessibility,
)

data class PlaceRecord(
    val id: String,
    val name: String,
    val address: String?,
    @SerializedName("category_code") val categoryCode: String,
    val longitude: Double,
    val latitude: Double,
    @SerializedName("external_source") val externalSource: String?,
    val status: String,
)

data class PlaceEvidence(
    val id: String,
    @SerializedName("feature_key") val featureKey: String,
    @SerializedName("display_name") val displayName: String,
    val value: JsonElement,
    val source: String,
    val grade: String,
    @SerializedName("moderation_status") val moderationStatus: String,
    @SerializedName("freshness_status") val freshnessStatus: String,
    @SerializedName("observed_at") val observedAt: String?,
    @SerializedName("expires_at") val expiresAt: String?,
    @SerializedName("created_at") val createdAt: String,
)

data class PlaceDetails(
    val place: PlaceRecord,
    @SerializedName("canonical_place_id") val canonicalPlaceId: String,
    @SerializedName("requested_place_id") val requestedPlaceId: String,
    val units: List<JsonElement>,
    val facilities: List<JsonElement>,
    @SerializedName("evidence_timeline") val evidenceTimeline: List<PlaceEvidence>,
    @SerializedName("evidence_timeline_has_more") val evidenceTimelineHasMore: Boolean,
)

data class LinkResolveRequest(
    val platform: String = "amap",
    @SerializedName("destination_name") val destinationName: String,
    val longitude: Double,
    val latitude: Double,
    @SerializedName("accessibility_notes") val accessibilityNotes: String,
)

data class LinkActionsData(val actions: List<ServiceAction>)

data class FeatureDefinition(
    @SerializedName("feature_key") val featureKey: String,
    @SerializedName("display_name") val displayName: String,
    @SerializedName("value_type") val valueType: String,
    val unit: String?,
    @SerializedName("target_types") val targetTypes: List<String>,
    @SerializedName("schema_version") val schemaVersion: Int,
)

data class UploadInitializeRequest(
    @SerializedName("file_name") val fileName: String,
    @SerializedName("mime_type") val mimeType: String,
    @SerializedName("total_bytes") val totalBytes: Int,
    @SerializedName("total_parts") val totalParts: Int,
    val sha256: String,
    @SerializedName("redaction_confirmed") val redactionConfirmed: Boolean = true,
)

data class UploadSessionData(
    @SerializedName("upload_id") val uploadId: String,
    val status: String,
    @SerializedName("part_size") val partSize: Int,
    @SerializedName("total_parts") val totalParts: Int,
    @SerializedName("completed_media_id") val completedMediaId: String? = null,
    @SerializedName("received_parts") val receivedParts: List<ReceivedUploadPart> = emptyList(),
)

data class ReceivedUploadPart(@SerializedName("part_number") val partNumber: Int)

data class CompletedMedia(
    @SerializedName("media_id") val mediaId: String,
    val status: String,
)

data class ObservationRequest(
    @SerializedName("place_id") val placeId: String,
    @SerializedName("feature_key") val featureKey: String,
    val value: JsonElement,
    @SerializedName("media_ids") val mediaIds: List<String>,
)

data class ObservationData(
    val id: String,
    val moderationStatus: String,
)

interface EazyPathApiService {
    @POST("api/v1/installations/challenges")
    suspend fun createChallenge(@Body request: ChallengeRequest): ApiEnvelope<ChallengeData>

    @POST("api/v1/installations/register")
    suspend fun register(@Body request: RegisterRequest): ApiEnvelope<SessionData>

    @POST("api/v1/sessions/refresh")
    suspend fun refresh(@Body request: RefreshRequest): ApiEnvelope<SessionData>

    @GET("api/v1/profile")
    suspend fun getProfile(): ApiEnvelope<ProfileData>

    @PUT("api/v1/profile")
    suspend fun updateProfile(@Body request: UpdateProfileRequest): ApiEnvelope<ProfileData>

    @GET("api/v1/privacy/ai-consents")
    suspend fun getAiConsents(): ApiEnvelope<AiConsentListData>

    @PUT("api/v1/privacy/ai-consents/{capability}")
    suspend fun updateAiConsent(
        @Path("capability") capability: String,
        @Body request: AiConsentUpdateRequest,
    ): ApiEnvelope<AiConsentItem>

    @POST("api/v1/tasks")
    suspend fun createTask(
        @Header("Idempotency-Key") idempotencyKey: String,
        @Body request: CreateTaskRequest,
    ): ApiEnvelope<TaskAccepted>

    @GET("api/v1/tasks/{taskId}")
    suspend fun getTask(@Path("taskId") taskId: String): ApiEnvelope<TaskDetails>

    @Multipart
    @POST("api/v1/verifications/images")
    suspend fun createVerification(
        @Part image: MultipartBody.Part,
        @Part("scene") scene: RequestBody,
    ): ApiEnvelope<VerificationAccepted>

    @GET("api/v1/verifications/{id}")
    suspend fun getVerification(@Path("id") id: String): ApiEnvelope<VerificationDetails>

    @GET("api/v1/review-tasks")
    suspend fun getReviewTasks(@Query("cursor") cursor: String? = null): ApiEnvelope<ReviewTaskPage>

    @GET("api/v1/review-tasks/{id}/my-submission")
    suspend fun getMyReviewSubmission(
        @Path("id") id: String,
        @Query("submission_id") submissionId: String,
    ): ApiEnvelope<ReviewSubmissionData>

    @POST("api/v1/location-proofs/verify")
    suspend fun verifyLocationProof(@Body request: LocationProofRequest): ApiEnvelope<LocationProofData>

    @POST("api/v1/review-tasks/{id}/submissions")
    suspend fun submitReview(@Path("id") id: String, @Body request: VoteRequest): ApiEnvelope<ReviewSubmissionData>

    @GET("api/v1/places/search")
    suspend fun searchPlaces(@Query("q") query: String, @Query("region") region: String = "江西省"): ApiEnvelope<List<PlaceSearchItem>>

    @GET("api/v1/places/feature-definitions")
    suspend fun getFeatureDefinitions(): ApiEnvelope<List<FeatureDefinition>>

    @GET("api/v1/places/{placeId}")
    suspend fun getPlaceDetails(@Path("placeId") placeId: String): ApiEnvelope<PlaceDetails>

    @POST("api/v1/links/resolve")
    suspend fun resolveLinkActions(@Body request: LinkResolveRequest): ApiEnvelope<LinkActionsData>

    @POST("api/v1/media/uploads")
    suspend fun initializeUpload(
        @Header("Idempotency-Key") idempotencyKey: String,
        @Body request: UploadInitializeRequest,
    ): ApiEnvelope<UploadSessionData>

    @GET("api/v1/media/uploads/{uploadId}")
    suspend fun getUpload(@Path("uploadId") uploadId: String): ApiEnvelope<UploadSessionData>

    @PUT("api/v1/media/uploads/{uploadId}/parts/{partNumber}")
    suspend fun uploadPart(
        @Path("uploadId") uploadId: String,
        @Path("partNumber") partNumber: Int,
        @Header("X-Part-SHA256") sha256: String,
        @Body body: RequestBody,
    ): ApiEnvelope<JsonElement>

    @POST("api/v1/media/uploads/{uploadId}/complete")
    suspend fun completeUpload(@Path("uploadId") uploadId: String): ApiEnvelope<CompletedMedia>

    @POST("api/v1/observations")
    suspend fun createObservation(@Body request: ObservationRequest): ApiEnvelope<ObservationData>
}
