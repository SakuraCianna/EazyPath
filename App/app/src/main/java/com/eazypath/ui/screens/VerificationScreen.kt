package com.eazypath.ui.screens

import android.net.Uri
import android.speech.tts.TextToSpeech
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.DeleteForever
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eazypath.ui.viewmodels.MainViewModel
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VerificationScreen(viewModel: MainViewModel, onBack: () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var selectedUri by remember { mutableStateOf<Uri?>(null) }
    var redactionConfirmed by remember { mutableStateOf(false) }
    var scene by remember { mutableStateOf("general_accessibility") }
    var tts by remember { mutableStateOf<TextToSpeech?>(null) }
    DisposableEffect(Unit) { tts = TextToSpeech(context) { if (it == TextToSpeech.SUCCESS) tts?.language = Locale.SIMPLIFIED_CHINESE }; onDispose { tts?.shutdown() } }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { selectedUri = it; redactionConfirmed = false }
    val scenes = listOf("general_accessibility" to "通用无障碍", "entrance" to "入口", "hotel_bathroom" to "酒店浴室", "accessible_restroom" to "无障碍卫生间", "sidewalk_ramp" to "人行道缘石坡道")

    Scaffold(topBar = { TopAppBar(title = { Text("AI 图片验真") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "返回") } }) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Card(shape = RoundedCornerShape(18.dp)) { Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) { Icon(Icons.Default.DeleteForever, null, tint = MaterialTheme.colorScheme.primary); Column { Text("用完即删", fontWeight = FontWeight.Black); Text("图片只进入非持久临时目录，AI 处理完成后立即删除，并返回删除时间。") } }
                OutlinedButton(onClick = { picker.launch("image/*") }, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Default.Image, null); Text(if (selectedUri == null) "从相册选择图片" else "重新选择图片") }
                selectedUri?.let { Text("已选择本地图片", color = MaterialTheme.colorScheme.primary) }
                Text("识别场景", style = MaterialTheme.typography.labelLarge)
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    scenes.forEach { option ->
                        FilterChip(
                            selected = scene == option.first,
                            onClick = { scene = option.first },
                            label = { Text(option.second) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                Row { Checkbox(redactionConfirmed, { redactionConfirmed = it }); Text("我已检查预览并确认没有清晰人脸、车牌或身份信息", Modifier.padding(top = 12.dp)) }
                Button(onClick = { selectedUri?.let { viewModel.submitVerification(it, scene) } }, enabled = selectedUri != null && redactionConfirmed && !state.verificationLoading, modifier = Modifier.fillMaxWidth()) { Text("开始验真") }
            } }
            if (state.verificationLoading) Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) { CircularProgressIndicator(); Text("正在验真并等待原图删除…") }
            state.verificationNotice?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
            state.verificationError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            state.verification?.let { result -> Card(shape = RoundedCornerShape(18.dp)) { Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("验真结果", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Black)
                Text("状态 ${result.status} · 风险 ${result.riskLevel} · 置信度 ${result.confidence ?: "未知"}")
                Text(result.result?.toString() ?: "模型未返回可用的结构化结果")
                Text("临时图片删除时间：${result.temporaryMediaDeletedAt ?: "等待删除确认"}", color = MaterialTheme.colorScheme.primary)
                OutlinedButton(onClick = { tts?.speak("验真状态${result.status}，风险${result.riskLevel}。${result.result}", TextToSpeech.QUEUE_FLUSH, null, "verification") }) { Icon(Icons.Default.RecordVoiceOver, null); Text("播报结果") }
            } }
            }
        }
    }
}
