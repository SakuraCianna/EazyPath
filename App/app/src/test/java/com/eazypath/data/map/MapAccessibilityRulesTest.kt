package com.eazypath.data.map

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MapAccessibilityRulesTest {
    @Test
    fun `普通步行路线始终明确未验证无障碍`() {
        assertEquals("普通步行路线（未验证无障碍）", MapAccessibilityRules.ROUTE_TITLE)
        assertTrue(MapAccessibilityRules.ROUTE_DISCLOSURE.contains("没有轮椅路线模式"))
        assertTrue(MapAccessibilityRules.ROUTE_DISCLOSURE.contains("现场复核"))
    }

    @Test
    fun `路线结构只生成风险提示而非友好结论`() {
        assertEquals("阶梯", MapAccessibilityRules.roadTypeNotice(20))
        assertEquals("斜坡", MapAccessibilityRules.roadTypeNotice(21))
        assertEquals("扶梯", MapAccessibilityRules.roadTypeNotice(8))
        assertNull(MapAccessibilityRules.roadTypeNotice(0))
    }

    @Test
    fun `无审核证据时必须显示未知`() {
        assertEquals("无障碍情况未知", MapAccessibilityRules.evidenceLabel("unknown", 0))
        assertEquals("有 3 项审核证据", MapAccessibilityRules.evidenceLabel("evidence_available", 3))
    }
}
