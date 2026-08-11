package com.eazypath.data.map

import java.net.URI

object ExternalActionPolicy {
    private val trustedHttpsHosts = setOf(
        "uri.amap.com",
        "m.ctrip.com",
        "i.meituan.com",
        "kyfw.12306.cn",
    )

    fun isTrustedUrl(type: String, rawUrl: String): Boolean = runCatching {
        val uri = URI(rawUrl)
        when (type) {
            "app_uri" -> uri.scheme.equals("amapuri", ignoreCase = true) &&
                uri.host.equals("route", ignoreCase = true) && uri.rawUserInfo == null && uri.port == -1
            "web" -> uri.scheme.equals("https", ignoreCase = true) &&
                uri.host?.lowercase() in trustedHttpsHosts && uri.rawUserInfo == null && uri.port in setOf(-1, 443)
            else -> false
        }
    }.getOrDefault(false)
}
