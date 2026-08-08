package com.eazypath.ui.screens

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccessibilityNew
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Map
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eazypath.ui.viewmodels.MainViewModel
import java.util.Locale

@Composable
fun HomeScreen(
    viewModel: MainViewModel,
    onCreateTask: (String) -> Unit,
    onProfile: () -> Unit,
    onVerification: () -> Unit,
    onCommunity: () -> Unit,
    onMap: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var prompt by remember { mutableStateOf("") }
    val voiceLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            prompt = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull().orEmpty()
        }
    }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            voiceLauncher.launch(
                Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.SIMPLIFIED_CHINESE.toLanguageTag())
                    putExtra(RecognizerIntent.EXTRA_PROMPT, "请说出完整出行需求")
                },
            )
        }
    }

    Scaffold { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Icons.Default.AccessibilityNew, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Column {
                    Text("EazyPath", fontWeight = FontWeight.Black, fontSize = 24.sp)
                    Text("江西轮椅与行动不便用户出行助手", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            when {
                state.sessionLoading -> CardBlock { CircularProgressIndicator(); Text("正在建立免注册安全会话…") }
                state.sessionError != null -> CardBlock {
                    Text("服务暂时不可用", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.error)
                    Text(state.sessionError.orEmpty())
                    Button(onClick = viewModel::retryBootstrap) { Text("重试") }
                }
                else -> {
                    Text("你准备去哪里？", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Black)
                    Text("可以一次说清出发地、目的地、日期、轮椅尺寸和住宿/就餐要求。所有未知条件都会明确标注。")
                    OutlinedTextField(
                        value = prompt,
                        onValueChange = { prompt = it },
                        modifier = Modifier.fillMaxWidth(),
                        minLines = 5,
                        label = { Text("完整出行需求") },
                        placeholder = { Text("例如：下周五从赣州去南昌两天，需要全程无台阶，找红谷滩附近可复核的酒店…") },
                        shape = RoundedCornerShape(18.dp),
                    )
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedButton(onClick = { permissionLauncher.launch(Manifest.permission.RECORD_AUDIO) }, modifier = Modifier.weight(1f)) {
                            Icon(Icons.Default.Mic, contentDescription = null); Text("语音输入")
                        }
                        Button(onClick = { onCreateTask(prompt.trim()) }, enabled = prompt.trim().length >= 2, modifier = Modifier.weight(1f)) { Text("开始规划") }
                    }
                }
            }

            Spacer(Modifier.height(4.dp))
            Text("现场工具", fontWeight = FontWeight.Bold, fontSize = 18.sp)
            Shortcut("基础地图与证据提示", "高德没有轮椅路线模式，未验证路段需现场复核。", Icons.Default.Map, onMap)
            Shortcut("AI 图片验真", "原图仅用于本次识别，处理完成后服务端立即删除。", Icons.Default.PhotoCamera, onVerification)
            Shortcut("社区复核", "帮助其他用户确认过期或冲突的无障碍信息。", Icons.Default.Groups, onCommunity)
            Shortcut("我的无障碍偏好", "门宽、台阶、卫生间、语音与大字设置。", Icons.Default.Person, onProfile)
        }
    }
}

@Composable
private fun Shortcut(title: String, description: String, icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp)) {
        Icon(icon, contentDescription = null)
        Column(Modifier.padding(start = 12.dp).weight(1f)) {
            Text(title, fontWeight = FontWeight.Bold, modifier = Modifier.fillMaxWidth())
            Text(description, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun CardBlock(content: @Composable ColumnScope.() -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant), shape = RoundedCornerShape(18.dp)) {
        Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
    }
}
