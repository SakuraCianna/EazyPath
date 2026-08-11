package com.eazypath.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import com.eazypath.data.network.AiConsentItem

@Composable
fun AiConsentDialog(
    consent: AiConsentItem,
    updating: Boolean,
    onAgree: () -> Unit,
    onRevoke: () -> Unit,
    onDecline: () -> Unit,
    onDismiss: () -> Unit,
) {
    val uriHandler = LocalUriHandler.current
    AlertDialog(
        onDismissRequest = { if (!updating) onDismiss() },
        title = { Text(consent.title) },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("处理者：${consent.processor}", style = MaterialTheme.typography.bodyMedium)
                Text("发送数据：${consent.dataType}")
                Text("用途：${consent.purpose}")
                Text("处理地域：${consent.region}")
                Text(consent.retentionNotice, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("拒绝后的替代方式：${consent.fallback}")
                Text("隐私说明核验日期：${consent.noticeVerifiedAt}", style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { uriHandler.openUri(consent.privacyUrl) }) {
                    Text("查看百炼官方隐私说明")
                }
            }
        },
        confirmButton = {
            if (consent.granted) {
                Button(onClick = onDismiss, enabled = !updating) { Text("保留同意") }
            } else {
                Button(onClick = onAgree, enabled = !updating) { Text(if (updating) "正在保存…" else "同意并继续") }
            }
        },
        dismissButton = {
            if (consent.granted) {
                OutlinedButton(onClick = onRevoke, enabled = !updating) { Text(if (updating) "正在撤回…" else "撤回同意") }
            } else {
                TextButton(
                    onClick = onDecline,
                    enabled = !updating,
                ) { Text("不同意，使用替代方式") }
            }
        },
    )
}
