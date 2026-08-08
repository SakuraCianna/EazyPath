package com.eazypath.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.speech.tts.TextToSpeech
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eazypath.data.network.ServiceAction
import com.eazypath.data.network.ServiceCard
import com.eazypath.ui.viewmodels.MainViewModel
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TravelChainScreen(prompt: String, viewModel: MainViewModel, onBack: () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var tts by remember { mutableStateOf<TextToSpeech?>(null) }
    DisposableEffect(Unit) {
        tts = TextToSpeech(context) { status -> if (status == TextToSpeech.SUCCESS) tts?.language = Locale.SIMPLIFIED_CHINESE }
        onDispose { tts?.shutdown() }
    }
    LaunchedEffect(prompt) { viewModel.createTravelTask(prompt) }

    Scaffold(topBar = { TopAppBar(title = { Text("无障碍出行链") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "返回") } }) }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("原始需求", fontWeight = FontWeight.Bold); Text(prompt)
                        Text("系统不会把高德 POI 当作无障碍认证，也不会在失败时填入演示行程。", fontSize = 12.sp)
                    }
                }
            }
            if (state.taskLoading) item { Row(Modifier.fillMaxWidth().padding(20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) { CircularProgressIndicator(); Column { Text("Agent 正在处理", fontWeight = FontWeight.Bold); Text(state.task?.status ?: "queued") } } }
            state.taskError?.let { error -> item { ErrorCard(error) { viewModel.retryCurrentTask() } } }
            state.task?.let { task ->
                item {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Column { Text("任务状态", fontSize = 12.sp); Text(task.status, fontWeight = FontWeight.Bold) }
                        OutlinedButton(onClick = { tts?.speak(taskSummary(task), TextToSpeech.QUEUE_FLUSH, null, "task-summary") }) { Icon(Icons.Default.RecordVoiceOver, null); Text("播报") }
                    }
                }
                items(task.cards, key = { it.id }) { card -> ServiceCardView(card, context) }
                if (task.cards.isEmpty() && task.status == "completed") item { ErrorCard("任务已完成，但没有可展示的真实候选。请修改地点或条件后重试。") { viewModel.retryCurrentTask() } }
            }
        }
    }
}

@Composable
private fun ServiceCardView(card: ServiceCard, context: Context) {
    Card(shape = RoundedCornerShape(18.dp), elevation = CardDefaults.cardElevation(1.dp)) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(card.category.uppercase(), color = MaterialTheme.colorScheme.primary, fontSize = 11.sp, fontWeight = FontWeight.Black)
            Text(card.title, fontWeight = FontWeight.Bold, fontSize = 18.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { StatusPill(card.status); StatusPill("风险 ${card.riskLevel}") }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { Icon(Icons.Default.Info, null, tint = MaterialTheme.colorScheme.primary); Text(card.riskMessage, fontSize = 13.sp) }
            card.actions.forEach { action ->
                if (action.type == "app_uri" || action.type == "web") Button(onClick = { executeAction(context, action) }, modifier = Modifier.fillMaxWidth()) { Text(action.label) }
                else OutlinedButton(onClick = { executeAction(context, action) }, modifier = Modifier.fillMaxWidth()) { Text(action.label) }
            }
        }
    }
}

@Composable
private fun StatusPill(text: String) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant), shape = RoundedCornerShape(8.dp)) { Text(text, Modifier.padding(horizontal = 8.dp, vertical = 4.dp), fontSize = 11.sp) }
}

@Composable
private fun ErrorCard(message: String, retry: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer), shape = RoundedCornerShape(16.dp)) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { Text(message, color = MaterialTheme.colorScheme.onErrorContainer); Button(onClick = retry) { Text("重试") } }
    }
}

private fun executeAction(context: Context, action: ServiceAction) {
    when (action.type) {
        "app_uri", "web" -> {
            val url = action.url ?: return
            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                .onFailure { Toast.makeText(context, "无法打开目标平台，请使用沟通卡", Toast.LENGTH_LONG).show() }
        }
        "clipboard" -> {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("EazyPath 无障碍沟通卡", action.content.orEmpty()))
            Toast.makeText(context, "沟通卡已复制", Toast.LENGTH_SHORT).show()
        }
    }
}

private fun taskSummary(task: com.eazypath.data.network.TaskDetails): String = buildString {
    append("任务状态${task.status}。")
    task.cards.forEach { append("${it.title}。风险${it.riskLevel}。${it.riskMessage}。") }
}
