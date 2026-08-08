package com.eazypath.data.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EvidencePrivacyRulesTest {
    @Test
    fun detectsPhoneIdentityAndPlateWithoutHidingAccessibilitySigns() {
        assertTrue(isSensitiveEvidenceText("联系电话 138 0013 8000"))
        assertTrue(isSensitiveEvidenceText("身份证 36010219900101123X"))
        assertTrue(isSensitiveEvidenceText("赣A12345"))
        assertFalse(isSensitiveEvidenceText("无障碍卫生间 电梯 坡道入口"))
    }

    @Test
    fun createsContiguousPartRangesAtOneMegabyteBoundary() {
        val partSize = 1024 * 1024
        assertEquals(listOf(0 until partSize), evidencePartRanges(partSize))
        assertEquals(
            listOf(0 until partSize, partSize until partSize * 2, partSize * 2 until partSize * 2 + 7),
            evidencePartRanges(partSize * 2 + 7),
        )
    }
}
