package com.eazypath.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class EvidenceUploadIdempotencyTest {
    @Test
    fun retriesSameDraftButDoesNotReuseMediaAcrossDrafts() {
        val wholeHash = "same-redacted-image-hash"
        val firstAttempt = evidenceUploadIdempotencyKey("draft-1", wholeHash)

        assertEquals(firstAttempt, evidenceUploadIdempotencyKey("draft-1", wholeHash))
        assertNotEquals(firstAttempt, evidenceUploadIdempotencyKey("draft-2", wholeHash))
    }
}
