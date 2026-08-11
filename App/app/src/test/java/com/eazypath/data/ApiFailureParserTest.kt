package com.eazypath.data

import org.junit.Assert.assertEquals
import org.junit.Test

class ApiFailureParserTest {
    @Test
    fun `preserves Hono error code for consent recovery`() {
        val error = parseApiFailure(403, """{"code":"AI_CONSENT_REQUIRED","message":"请重新同意"}""")

        assertEquals("AI_CONSENT_REQUIRED", error.code)
        assertEquals("请重新同意", error.message)
    }

    @Test
    fun `falls back safely for malformed non-2xx body`() {
        val error = parseApiFailure(503, "not-json")

        assertEquals("HTTP_503", error.code)
        assertEquals("服务请求失败（503）", error.message)
    }
}
