package com.eazypath.ui.components

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import com.eazypath.data.map.ExternalActionPolicy
import com.eazypath.data.network.ServiceAction

enum class ExternalActionResult { LAUNCHED, COPIED, UNAVAILABLE }

fun executeActionWithFallback(
    context: Context,
    actions: List<ServiceAction>,
    selected: ServiceAction,
): ExternalActionResult {
    val startIndex = actions.indexOf(selected).coerceAtLeast(0)
    for (action in actions.drop(startIndex)) {
        when (action.type) {
            "app_uri", "web" -> {
                val url = action.url ?: continue
                if (!ExternalActionPolicy.isTrustedUrl(action.type, url)) continue
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (intent.resolveActivity(context.packageManager) == null) continue
                if (runCatching { context.startActivity(intent) }.isSuccess) return ExternalActionResult.LAUNCHED
            }
            "clipboard" -> {
                if (selected.type != "clipboard") continue
                val content = action.content?.takeIf { it.isNotBlank() } ?: continue
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("EazyPath 无障碍沟通卡", content))
                Toast.makeText(context, "沟通卡已复制", Toast.LENGTH_SHORT).show()
                return ExternalActionResult.COPIED
            }
        }
    }
    Toast.makeText(context, "无法打开目标平台，请点击复制沟通卡", Toast.LENGTH_LONG).show()
    return ExternalActionResult.UNAVAILABLE
}
