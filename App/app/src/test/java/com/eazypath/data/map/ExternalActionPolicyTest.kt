package com.eazypath.data.map

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExternalActionPolicyTest {
    @Test
    fun `仅允许高德 app uri 与白名单 https`() {
        assertTrue(ExternalActionPolicy.isTrustedUrl("app_uri", "amapuri://route/plan/?dlat=28.6&dlon=115.9"))
        assertTrue(ExternalActionPolicy.isTrustedUrl("web", "https://uri.amap.com/navigation?mode=walk"))
        assertFalse(ExternalActionPolicy.isTrustedUrl("web", "http://uri.amap.com/navigation"))
        assertFalse(ExternalActionPolicy.isTrustedUrl("web", "https://uri.amap.com.attacker.example/navigation"))
        assertFalse(ExternalActionPolicy.isTrustedUrl("web", "https://uri.amap.com:444/navigation"))
        assertFalse(ExternalActionPolicy.isTrustedUrl("app_uri", "amapuri://share/route"))
        assertFalse(ExternalActionPolicy.isTrustedUrl("app_uri", "amapuri://route:444/plan"))
        assertFalse(ExternalActionPolicy.isTrustedUrl("app_uri", "intent://route/plan"))
    }
}
