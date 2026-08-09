package com.eazypath.data

import org.junit.Assert.assertEquals
import org.junit.Test

class ReviewEvidenceRulesTest {
    @Test
    fun matchesServerBaseWeightPolicy() {
        assertEquals(0.5, reviewEvidenceBaseWeight(hasConfirmedRedactedImage = false, locationProofPassed = false), 0.0)
        assertEquals(0.5, reviewEvidenceBaseWeight(hasConfirmedRedactedImage = false, locationProofPassed = true), 0.0)
        assertEquals(0.8, reviewEvidenceBaseWeight(hasConfirmedRedactedImage = true, locationProofPassed = false), 0.0)
        assertEquals(1.0, reviewEvidenceBaseWeight(hasConfirmedRedactedImage = true, locationProofPassed = true), 0.0)
    }
}
