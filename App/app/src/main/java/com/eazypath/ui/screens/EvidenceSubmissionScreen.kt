package com.eazypath.ui.screens

import android.graphics.Rect
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AddPhotoAlternate
import androidx.compose.material.icons.filled.PrivacyTip
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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eazypath.data.media.EvidenceImageAnalysis
import com.google.gson.JsonPrimitive
import com.eazypath.ui.components.EvidenceRedactionEditor
import com.eazypath.ui.viewmodels.MainViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EvidenceSubmissionScreen(viewModel: MainViewModel, onBack: () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var query by rememberSaveable { mutableStateOf("") }
    var selectedPlaceId by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedFeatureKey by rememberSaveable { mutableStateOf<String?>(null) }
    var booleanValue by rememberSaveable { mutableStateOf(true) }
    var scalarValue by rememberSaveable { mutableStateOf("") }
    var redactionConfirmed by rememberSaveable { mutableStateOf(false) }
    var appliedAnalysisVersion by rememberSaveable { mutableStateOf(-1) }
    val selectedPlace = state.placeResults.firstOrNull { it.id == selectedPlaceId }
    val feature = state.evidenceFeatureDefinitions.firstOrNull { it.featureKey == selectedFeatureKey }
        ?: state.evidenceFeatureDefinitions.firstOrNull()
    val analysis = state.evidenceAnalysis
    var savedRegionValues by rememberSaveable { mutableStateOf(emptyList<Int>()) }
    val regions = savedRegionValues.chunked(4).map { Rect(it[0], it[1], it[2], it[3]) }
    LaunchedEffect(Unit) { viewModel.loadEvidenceFeatureDefinitions() }
    LaunchedEffect(feature?.featureKey) {
        if (feature != null && selectedFeatureKey != feature.featureKey) selectedFeatureKey = feature.featureKey
    }
    LaunchedEffect(state.evidenceAnalysisVersion) {
        if (appliedAnalysisVersion != state.evidenceAnalysisVersion) {
            savedRegionValues = analysis?.suggestedRegions
                ?.flatMap { listOf(it.left, it.top, it.right, it.bottom) }
                .orEmpty()
            redactionConfirmed = false
            appliedAnalysisVersion = state.evidenceAnalysisVersion
        }
    }
    LaunchedEffect(state.evidenceSubmissionVersion) {
        if (state.evidenceSubmissionVersion > 0) {
            query = ""
            selectedPlaceId = null
            selectedFeatureKey = state.evidenceFeatureDefinitions.firstOrNull()?.featureKey
            booleanValue = true
            scalarValue = ""
            savedRegionValues = emptyList()
            redactionConfirmed = false
        }
    }
    val invalidatePreview = {
        redactionConfirmed = false
        viewModel.clearEvidencePreview()
    }
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) {
            redactionConfirmed = false
            viewModel.analyzeEvidenceImage(uri)
        }
    }
    val leaveScreen = {
        viewModel.discardEvidenceDraft()
        onBack()
    }
    BackHandler(onBack = leaveScreen)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("提交现场无障碍信息") },
                navigationIcon = { IconButton(onClick = leaveScreen) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Card(shape = RoundedCornerShape(18.dp)) {
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("1. 选择真实地点", fontWeight = FontWeight.Black)
                    OutlinedTextField(query, { query = it; selectedPlaceId = null }, Modifier.fillMaxWidth(), label = { Text("地点名称") }, singleLine = true)
                    Button(onClick = { viewModel.searchEvidencePlaces(query) }, enabled = query.isNotBlank() && !state.placeSearchLoading) { Text("搜索江西地点") }
                    state.placeResults.forEach { place ->
                        FilterChip(
                            selected = selectedPlaceId == place.id,
                            onClick = { selectedPlaceId = place.id },
                            label = { Column { Text(place.name, fontWeight = FontWeight.Bold); Text(place.address ?: "地址未知") } },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }

            Card(shape = RoundedCornerShape(18.dp)) {
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("2. 描述你现场看到的情况", fontWeight = FontWeight.Black)
                    if (state.evidenceFeaturesLoading) Text("正在读取可提交字段…")
                    state.evidenceFeatureDefinitions.forEach { option ->
                        FilterChip(
                            selected = feature?.featureKey == option.featureKey,
                            onClick = {
                                selectedFeatureKey = option.featureKey
                                booleanValue = true
                                scalarValue = ""
                            },
                            label = { Text(option.displayName + option.unit?.let { "（$it）" }.orEmpty()) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    when (feature?.valueType) {
                        "boolean" -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilterChip(selected = booleanValue, onClick = { booleanValue = true }, label = { Text("现场确认存在") })
                            FilterChip(selected = !booleanValue, onClick = { booleanValue = false }, label = { Text("现场确认不存在") })
                        }
                        "number" -> OutlinedTextField(
                            value = scalarValue,
                            onValueChange = { scalarValue = it },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("测量值${feature.unit?.let { "（$it）" }.orEmpty()}") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            singleLine = true,
                        )
                        "string" -> OutlinedTextField(
                            value = scalarValue,
                            onValueChange = { scalarValue = it.take(1000) },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("现场描述") },
                        )
                        null -> Text("暂无可提交字段", color = MaterialTheme.colorScheme.error)
                        else -> Text("该字段类型需要更新 App 后才能提交", color = MaterialTheme.colorScheme.error)
                    }
                }
            }

            Card(shape = RoundedCornerShape(18.dp)) {
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("3. 可选脱敏照片", fontWeight = FontWeight.Black)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(Icons.Default.PrivacyTip, null, tint = MaterialTheme.colorScheme.primary)
                        Text("检测在设备上完成。只上传生成后的脱敏副本，原图不会发送到 EazyPath。")
                    }
                    OutlinedButton(onClick = { imagePicker.launch("image/*") }, enabled = !state.evidenceImageLoading, modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.Default.AddPhotoAlternate, null)
                        Text(if (analysis == null) "选择并检测图片" else "更换图片")
                    }
                    if (analysis != null) {
                        OutlinedButton(
                            onClick = {
                                redactionConfirmed = false
                                savedRegionValues = emptyList()
                                viewModel.removeEvidenceImage()
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("移除照片，仅提交现场描述") }
                        Text("检测到 ${analysis.faceCount} 个人脸区域、${analysis.sensitiveTextCount} 个疑似敏感文字区域。请检查建议框，并拖动补充遗漏区域。")
                        EvidenceRedactionEditor(analysis, regions) { newRegion ->
                            invalidatePreview()
                            savedRegionValues = savedRegionValues + listOf(newRegion.left, newRegion.top, newRegion.right, newRegion.bottom)
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = {
                                if (savedRegionValues.isNotEmpty()) {
                                    invalidatePreview()
                                    savedRegionValues = savedRegionValues.dropLast(4)
                                }
                            }) { Text("撤销最后一框") }
                            OutlinedButton(onClick = {
                                invalidatePreview()
                                savedRegionValues = analysis.suggestedRegions
                                    .flatMap { listOf(it.left, it.top, it.right, it.bottom) }
                            }) { Text("恢复检测建议") }
                        }
                        OutlinedButton(
                            onClick = {
                                invalidatePreview()
                                savedRegionValues = listOf(0, 0, analysis.bitmap.width, analysis.bitmap.height)
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("无法拖动时：遮挡整张照片") }
                        Text("拖动操作不便时，可以遮挡整张照片，或不附照片直接提交现场描述。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Button(onClick = { viewModel.prepareEvidencePreview(regions) }, enabled = !state.evidenceImageLoading, modifier = Modifier.fillMaxWidth()) {
                            Text("生成最终脱敏预览")
                        }
                        state.evidencePreview?.let { preview ->
                            Text("以下是实际待上传 JPEG，请仔细检查敏感信息是否完全遮挡。", fontWeight = FontWeight.Bold)
                            Image(
                                bitmap = preview.asImageBitmap(),
                                contentDescription = "实际待上传的脱敏图片预览",
                                contentScale = ContentScale.Fit,
                                modifier = Modifier.fillMaxWidth().height(300.dp),
                            )
                            Row {
                                Checkbox(redactionConfirmed, { redactionConfirmed = it })
                                Text("我已检查最终图片，确认人脸、车牌、手机号和身份信息已遮挡", Modifier.padding(top = 12.dp))
                            }
                        }
                    }
                }
            }

            if (state.placeSearchLoading || state.evidenceImageLoading || state.evidenceSubmitting) Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) { CircularProgressIndicator(); Text("正在处理，请勿关闭页面…") }
            state.evidenceError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            state.evidenceNotice?.let { Text(it, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold) }
            val observationValue = when (feature?.valueType) {
                "boolean" -> JsonPrimitive(booleanValue)
                "number" -> scalarValue.toDoubleOrNull()?.takeIf { it.isFinite() }?.let(::JsonPrimitive)
                "string" -> scalarValue.trim().takeIf { it.isNotEmpty() }?.let(::JsonPrimitive)
                else -> null
            }
            Button(
                onClick = {
                    if (selectedPlace != null && feature != null && observationValue != null) {
                        viewModel.submitObservation(selectedPlace.id, feature.featureKey, observationValue, analysis != null)
                    }
                },
                enabled = selectedPlace != null && feature != null && observationValue != null && !state.evidenceSubmitting && !state.evidenceImageLoading && (analysis == null || (state.preparedEvidence != null && redactionConfirmed)),
                modifier = Modifier.fillMaxWidth(),
            ) { Text("提交待审核信息") }
            Text("提交不等于认证。管理员审核或社区复核通过前，其他用户只会看到待审核状态。", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
