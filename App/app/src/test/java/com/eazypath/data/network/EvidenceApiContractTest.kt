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
}
