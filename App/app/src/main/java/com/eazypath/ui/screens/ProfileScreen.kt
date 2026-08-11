package com.eazypath.ui.screens

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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eazypath.data.network.InteractionProfile
import com.eazypath.data.network.MobilityProfile
import com.eazypath.ui.components.AiConsentDialog
import com.eazypath.ui.viewmodels.MainViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileScreen(viewModel: MainViewModel, onBack: () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val profile = state.profile
    var stepFree by remember(profile?.version) { mutableStateOf(profile?.mobility?.requireStepFree ?: true) }
    var doorWidth by remember(profile?.version) { mutableFloatStateOf((profile?.mobility?.minimumDoorWidthCm ?: 80).toFloat()) }
    var obstacleHeight by remember(profile?.version) { mutableFloatStateOf((profile?.mobility?.maximumObstacleHeightCm ?: 2.0).toFloat()) }
    var restroom by remember(profile?.version) { mutableStateOf(profile?.mobility?.requireAccessibleRestroom ?: true) }
    var shower by remember(profile?.version) { mutableStateOf(profile?.mobility?.requireRollInShower ?: false) }
    var avoidUnknown by remember(profile?.version) { mutableStateOf(profile?.mobility?.avoidUnverifiedSegments ?: true) }
    var largeText by remember(profile?.version) { mutableStateOf(profile?.interaction?.largeText ?: true) }
    var voiceOutput by remember(profile?.version) { mutableStateOf(profile?.interaction?.preferVoiceOutput ?: true) }
    var selectedConsentCapability by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        if (profile == null) viewModel.loadProfile()
        if (state.aiConsents.isEmpty()) viewModel.loadAiConsents()
    }

    Scaffold(topBar = { TopAppBar(title = { Text("我的无障碍偏好") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "返回") } }) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("这些偏好会作为每次规划的硬约束快照保存。P0 先服务轮椅或行动不便用户。", color = MaterialTheme.colorScheme.onSurfaceVariant)
            PreferenceCard("通行参数") {
                ToggleRow("要求无台阶入口", stepFree) { stepFree = it }
                Text("最小净门宽 ${doorWidth.toInt()} cm", fontWeight = FontWeight.Bold); Slider(doorWidth, { doorWidth = it }, valueRange = 60f..120f, steps = 11)
                Text("可接受障碍高度 ${"%.1f".format(obstacleHeight)} cm", fontWeight = FontWeight.Bold); Slider(obstacleHeight, { obstacleHeight = it }, valueRange = 0f..10f, steps = 19)
                ToggleRow("要求无障碍卫生间", restroom) { restroom = it }
                ToggleRow("住宿要求平地淋浴", shower) { shower = it }
                ToggleRow("避开无证据路段", avoidUnknown) { avoidUnknown = it }
            }
            PreferenceCard("交互与播报") {
                ToggleRow("大字模式", largeText) { largeText = it }
                ToggleRow("自动语音播报结果", voiceOutput) { voiceOutput = it }
            }
            PreferenceCard("AI 处理与隐私") {
                Text("四类能力分别管理。撤回某一项不会影响其他功能。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                state.aiConsents.forEach { consent ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Column(Modifier.weight(1f)) {
                            Text(consent.title, fontWeight = FontWeight.Bold)
                            Text(
                                when (consent.decision) {
                                    "granted" -> "已同意 · 可随时撤回"
                                    "denied" -> "已拒绝 · 使用替代方式"
                                    "revoked" -> "已撤回 · 使用替代方式"
                                    "expired" -> "说明已更新 · 需要重新选择"
                                    else -> "尚未选择"
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = if (consent.granted) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        OutlinedButton(onClick = { selectedConsentCapability = consent.capability }) { Text("查看与管理") }
                    }
                }
                if (state.aiConsentsLoading) Text("正在读取隐私选择…")
                state.aiConsentError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
            state.sessionError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(
                onClick = {
                    val current = profile ?: return@Button
                    viewModel.saveProfile(
                        MobilityProfile(
                            mobilityMode = current.mobility.mobilityMode,
                            requireStepFree = stepFree,
                            minimumDoorWidthCm = doorWidth.toInt(),
                            maximumObstacleHeightCm = obstacleHeight.toDouble(),
                            maximumSlopePercent = current.mobility.maximumSlopePercent,
                            requireAccessibleRestroom = restroom,
                            requireRollInShower = shower,
                            avoidUnverifiedSegments = avoidUnknown,
                        ),
                        InteractionProfile(
                            largeText = largeText,
                            highContrast = current.interaction.highContrast,
                            preferVoiceInput = current.interaction.preferVoiceInput,
                            preferVoiceOutput = voiceOutput,
                            hapticFeedback = current.interaction.hapticFeedback,
                        ),
                    )
                },
                enabled = profile != null && !state.profileSaving,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (state.profileSaving) "保存中…" else "保存偏好") }
        }
    }
    val selectedConsent = state.aiConsents.firstOrNull { it.capability == selectedConsentCapability }
    if (selectedConsent != null) {
        AiConsentDialog(
            consent = selectedConsent,
            updating = state.aiConsentUpdatingCapability == selectedConsent.capability,
            onAgree = { viewModel.setAiConsent(selectedConsent.capability, true) },
            onRevoke = { viewModel.setAiConsent(selectedConsent.capability, false) },
            onDecline = {
                viewModel.setAiConsent(selectedConsent.capability, false) {
                    selectedConsentCapability = null
                }
            },
            onDismiss = { selectedConsentCapability = null },
        )
    }
}

@Composable
private fun PreferenceCard(title: String, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Card(shape = RoundedCornerShape(18.dp)) { Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Black); content() } }
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(label, Modifier.weight(1f)); Switch(checked, onChange) }
}
