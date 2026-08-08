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
    @SerializedName("place_name") val placeName: String,
    @SerializedName("feature_name") val featureName: String,
    val address: String?,
    val status: String,
)

data class VoteRequest(
    val answer: String,
    @SerializedName("media_id") val mediaId: String? = null,
    @SerializedName("location_proof_id") val locationProofId: String? = null,
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
    suspend fun getReviewTasks(): ApiEnvelope<List<ReviewTask>>

    @POST("api/v1/review-tasks/{id}/submissions")
    suspend fun submitReview(@Path("id") id: String, @Body request: VoteRequest): ApiEnvelope<JsonElement>
}
