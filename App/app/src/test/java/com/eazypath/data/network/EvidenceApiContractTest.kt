package com.eazypath.data.network

import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Test

class EvidenceApiContractTest {
    private val gson = Gson()

    @Test
    fun parsesBackendObservationAndUploadContracts() {
        val observation = gson.fromJson(
            """{"id":"obs-1","moderationStatus":"pending"}""",
            ObservationData::class.java,
        )
        val upload = gson.fromJson(
            """{"upload_id":"upload-1","status":"uploading","part_size":1048576,"total_parts":2,"completed_media_id":null,"received_parts":[{"part_number":1}]}""",
            UploadSessionData::class.java,
        )
        val feature = gson.fromJson(
            """{"feature_key":"entrance.door_clear_width_cm","display_name":"入口净门宽","value_type":"number","unit":"cm","target_types":["place","place_unit"],"schema_version":1}""",
            FeatureDefinition::class.java,
        )
        assertEquals("pending", observation.moderationStatus)
        assertEquals("upload-1", upload.uploadId)
        assertEquals(1_048_576, upload.partSize)
        assertEquals(2, upload.totalParts)
        assertEquals(listOf(1), upload.receivedParts.map { it.partNumber })
        assertEquals("number", feature.valueType)
        assertEquals("cm", feature.unit)
        assertEquals(listOf("place", "place_unit"), feature.targetTypes)
    }

    @Test
    fun parsesCommunityReviewAndOneShotLocationContracts() {
        val task = gson.fromJson(
            """{"id":"task-1","status":"pending_review","reason":"evidence_expired","target_type":"observation","target_id":"obs-1","location_radius_meters":120,"feature_key":"entrance.door_clear_width_cm","feature_name":"入口净门宽","feature_unit":"cm","place_id":"place-1","place_name":"南昌站","address":"江西省南昌市","historical_value":78,"historical_source":"community","historical_grade":"C","historical_freshness_status":"expired","historical_moderation_status":"approved","historical_observed_at":"2026-05-01T01:00:00.000Z","historical_expires_at":"2026-08-01T01:00:00.000Z","historical_has_redacted_media":true,"created_at":"2026-08-09T01:00:00.000Z"}""",
            ReviewTask::class.java,
        )
        val proof = gson.fromJson(
            """{"proof_id":"proof-1","canonical_place_id":"place-1","review_task_id":"task-1","passed":true,"distance_bucket":"within_50m","radius_meters":120,"expires_at":"2026-08-09T01:15:00.000Z","privacy_notice":"精确坐标未保存"}""",
            LocationProofData::class.java,
        )
        val submission = gson.fromJson(
            """{"vote_weight":1,"consensus":{"status":"pending_review","outcome":null,"presentWeight":1,"absentWeight":0,"directionalWeight":1,"dominantRatio":1,"distinctInstallations":1}}""",
            ReviewSubmissionData::class.java,
        )
        val page = gson.fromJson(
            """{"items":[],"next_cursor":"opaque-next-page"}""",
            ReviewTaskPage::class.java,
        )
        val voteJson = gson.toJson(
            VoteRequest(
                submissionId = "00000000-0000-4000-8000-000000000013",
                answer = "present",
                mediaId = "media-1",
                locationProofId = "proof-1",
            ),
        )

        assertEquals("place-1", task.placeId)
        assertEquals(120, task.locationRadiusMeters)
        assertEquals(78, task.historicalValue?.asInt)
        assertEquals("expired", task.historicalFreshnessStatus)
        assertEquals(true, task.historicalHasRedactedMedia)
        assertEquals("task-1", proof.reviewTaskId)
        assertEquals(true, proof.passed)
        assertEquals(1.0, submission.voteWeight, 0.0)
        assertEquals("pending_review", submission.consensus.status)
        assertEquals(1, submission.consensus.distinctInstallations)
        assertEquals("opaque-next-page", page.nextCursor)
        assertEquals("00000000-0000-4000-8000-000000000013", gson.fromJson(voteJson, com.google.gson.JsonObject::class.java)["submission_id"].asString)
    }
}
