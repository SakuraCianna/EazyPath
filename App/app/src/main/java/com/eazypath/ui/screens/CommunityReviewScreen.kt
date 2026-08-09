package com.eazypath.ui.screens

import android.Manifest
import android.graphics.Rect
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AddPhotoAlternate
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.MyLocation
import androidx.compose.material.icons.filled.PrivacyTip
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
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
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eazypath.data.reviewEvidenceBaseWeight
import com.eazypath.data.network.ReviewTask
import com.eazypath.ui.components.EvidenceRedactionEditor
import com.eazypath.ui.viewmodels.MainViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CommunityReviewScreen(viewModel: MainViewModel, onBack: () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val uriHandler = LocalUriHandler.current
    val selectedTask = state.reviewTasks.firstOrNull { it.id == state.reviewDraftTaskId }
    val submitting = state.reviewSubmittingTaskId != null
    val submissionPendingConfirmation = state.reviewPendingSubmissionId != null
    var answer by rememberSaveable { mutableStateOf<String?>(null) }
    var showLocationNotice by rememberSaveable { mutableStateOf(false) }
    var showSubmitConfirmation by rememberSaveable { mutableStateOf(false) }
    var showAbandonConfirmation by rememberSaveable { mutableStateOf(false) }
    var locationPermissionDenied by rememberSaveable { mutableStateOf(false) }
    var redactionConfirmed by rememberSaveable { mutableStateOf(false) }
    var publicationTermsConfirmed by rememberSaveable { mutableStateOf(false) }
    var appliedAnalysisVersion by rememberSaveable { mutableStateOf(-1) }
    var savedRegionValues by rememberSaveable { mutableStateOf(emptyList<Int>()) }
    val analysis = state.evidenceAnalysis
    val regions = savedRegionValues.chunked(4).map { Rect(it[0], it[1], it[2], it[3]) }

    LaunchedEffect(Unit) { viewModel.loadReviewTasks() }
    LaunchedEffect(state.reviewDraftTaskId) {
        answer = null
        locationPermissionDenied = false
        savedRegionValues = emptyList()
        redactionConfirmed = false
        publicationTermsConfirmed = false
        appliedAnalysisVersion = -1
    }
    LaunchedEffect(state.evidenceAnalysisVersion) {
        if (appliedAnalysisVersion != state.evidenceAnalysisVersion) {
            savedRegionValues = analysis?.suggestedRegions
                ?.flatMap { listOf(it.left, it.top, it.right, it.bottom) }
                .orEmpty()
            redactionConfirmed = false
            publicationTermsConfirmed = false
            appliedAnalysisVersion = state.evidenceAnalysisVersion
        }
    }

    val locationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { grants ->
        val granted = grants[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            grants[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        locationPermissionDenied = !granted
        if (granted) selectedTask?.let { viewModel.verifyReviewLocation(it.id, it.placeId) }
    }
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) {
            redactionConfirmed = false
            publicationTermsConfirmed = false
            viewModel.analyzeEvidenceImage(uri)
        }
    }
    val leave = {
        if (!submitting) {
            if (submissionPendingConfirmation) {
                showAbandonConfirmation = true
            } else if (selectedTask != null) {
                viewModel.discardReviewDraft()
            } else {
                onBack()
            }
        }
    }
    BackHandler(onBack = leave)

    if (showLocationNotice && selectedTask != null) {
        AlertDialog(
            onDismissRequest = { showLocationNotice = false },
            icon = { Icon(Icons.Default.PrivacyTip, null) },
            title = { Text("仅本次使用位置") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("定位由北京高德图强科技有限公司的高德合包 SDK 提供。为提供网络/卫星定位，SDK 可能处理精确或粗略位置、设备与应用信息、WLAN/网络和运营商信息、传感器信息及 OAID 等设备标识。")
                    Text("同意后只获取一次当前位置，用于判断你是否在“${selectedTask.placeName}”约 ${selectedTask.locationRadiusMeters} 米范围内。精确坐标只随本次校验短暂传输，不写入 EazyPath 数据库；服务端仅保留是否通过、粗粒度距离区间和校验时间。拒绝定位仍可提交基础复核。")
                    TextButton(onClick = { uriHandler.openUri("https://lbs.amap.com/home/privacy/") }) {
                        Text("查看高德地图开放平台隐私权政策")
                    }
                }
            },
            confirmButton = {
                Button(onClick = {
                    showLocationNotice = false
                    locationPermissionLauncher.launch(
                        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                    )
                }) { Text("同意并获取一次位置") }
            },
            dismissButton = { TextButton(onClick = { showLocationNotice = false }) { Text("暂不使用位置") } },
        )
    }
    if (showAbandonConfirmation) {
        AlertDialog(
            onDismissRequest = { showAbandonConfirmation = false },
            title = { Text("放弃确认并离开？") },
            text = { Text("当前提交结果尚未确认，服务端可能已经记录。离开后不要立即换一个答案重复提交；任务列表会刷新，但已进入终态的任务可能不再显示。") },
            confirmButton = {
                Button(onClick = {
                    showAbandonConfirmation = false
                    viewModel.abandonReviewConfirmation()
                }) { Text("放弃本地确认并离开") }
            },
            dismissButton = { TextButton(onClick = { showAbandonConfirmation = false }) { Text("继续确认原提交") } },
        )
    }
    if (showSubmitConfirmation && selectedTask != null && answer != null) {
        val includeImage = analysis != null
        AlertDialog(
            onDismissRequest = { showSubmitConfirmation = false },
            title = { Text("确认提交独立复核？") },
            text = {
                Text(
                    "你的选择是“${answerLabel(answer!!)}”。${if (includeImage) "将上传已确认的脱敏副本，最多保存 180 天；普通用户不会直接看到图片，具媒体审核权限的管理员可查看。" else "不会上传图片。"}${if (state.reviewLocationProof != null) "一次性位置证明会随本票使用。" else "本票不含位置证明。"} 提交后会进入社区共识计算，不等于立即认证。",
                )
            },
            confirmButton = {
                Button(onClick = {
                    showSubmitConfirmation = false
                    viewModel.submitReview(selectedTask.id, answer!!, includeImage)
                }) { Text("确认提交") }
            },
            dismissButton = { TextButton(onClick = { showSubmitConfirmation = false }) { Text("继续检查") } },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (selectedTask == null) "社区复核" else "检查复核证据") },
                navigationIcon = {
                    IconButton(onClick = leave, enabled = !submitting) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回")
                    }
                },
            )
        },
    ) { padding ->
        if (selectedTask == null) {
            ReviewTaskList(
                modifier = Modifier.fillMaxSize().padding(padding),
                tasks = state.reviewTasks,
                loading = state.reviewsLoading,
                loadingMore = state.reviewsLoadingMore,
                hasMore = state.reviewTasksNextCursor != null,
                error = state.reviewsError,
                notice = state.reviewNotice,
                onOpen = viewModel::beginReviewTask,
                onLoadMore = { viewModel.loadReviewTasks(loadMore = true) },
            )
        } else {
            Column(
                Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                TaskSummaryCard(selectedTask)
                HistoricalEvidenceCard(selectedTask)
                if (submissionPendingConfirmation) {
                    Card(
                        shape = RoundedCornerShape(20.dp),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
                    ) {
                        Text(
                            "上一笔提交结果尚未确认。答案、图片和位置已冻结；请用页面底部按钮查询或重试同一笔提交。",
                            Modifier.fillMaxWidth().padding(16.dp),
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }

                Card(shape = RoundedCornerShape(20.dp)) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("1. 你现场看到什么？", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Black)
                        Text("无法确认时请选择“不确定”，不要猜测。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        listOf("present" to "存在", "absent" to "不存在", "unknown" to "不确定").forEach { (value, label) ->
                            FilterChip(
                                selected = answer == value,
                                onClick = { answer = value },
                                enabled = !submissionPendingConfirmation,
                                label = { Text(label) },
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }

                Card(
                    shape = RoundedCornerShape(20.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
                ) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Icon(Icons.Default.MyLocation, null)
                            Text("2. 可选的一次性位置证明", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Black)
                        }
                        Text("拒绝定位不影响提交；有脱敏图片且位置通过时，证据基础权重最高。")
                        state.reviewLocationProof?.let { proof ->
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Icon(Icons.Default.CheckCircle, null, tint = MaterialTheme.colorScheme.primary)
                                Text(
                                    if (proof.passed) "位置校验通过（${distanceBucketLabel(proof.distanceBucket)}）" else "位置未通过，本票不会获得定位加权",
                                    fontWeight = FontWeight.Bold,
                                )
                            }
                            Text(proof.privacyNotice, style = MaterialTheme.typography.bodySmall)
                        }
                        if (state.reviewLocationLoadingTaskId == selectedTask.id) {
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                CircularProgressIndicator()
                                Text("正在获取并校验一次位置…")
                            }
                        } else {
                            OutlinedButton(
                                onClick = { showLocationNotice = true },
                                enabled = !submissionPendingConfirmation,
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(if (state.reviewLocationProof == null) "了解隐私说明并验证位置" else "重新验证位置")
                            }
                        }
                        if (locationPermissionDenied) Text("你未授予定位权限，可以继续提交不含位置的复核。", color = MaterialTheme.colorScheme.onSecondaryContainer)
                    }
                }

                Card(shape = RoundedCornerShape(20.dp)) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("3. 可选脱敏照片", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Black)
                        Text("检测在设备上完成，只上传你最终确认的实色遮挡副本；原图不会发送到 EazyPath。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        OutlinedButton(
                            onClick = { imagePicker.launch("image/*") },
                            enabled = !state.evidenceImageLoading && !submissionPendingConfirmation,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Icon(Icons.Default.AddPhotoAlternate, null)
                            Text(if (analysis == null) "选择并检测图片" else "更换图片")
                        }
                        if (analysis != null) {
                            OutlinedButton(onClick = {
                                savedRegionValues = emptyList()
                                redactionConfirmed = false
                                publicationTermsConfirmed = false
                                viewModel.removeEvidenceImage()
                            }, enabled = !submissionPendingConfirmation, modifier = Modifier.fillMaxWidth()) { Text("移除照片，仅提交文字复核") }
                            Text("检测到 ${analysis.faceCount} 个人脸区域、${analysis.sensitiveTextCount} 个疑似敏感文字区域。请检查并补充遗漏区域。")
                            EvidenceRedactionEditor(analysis, regions, enabled = !submissionPendingConfirmation) { rect ->
                                redactionConfirmed = false
                                publicationTermsConfirmed = false
                                viewModel.clearEvidencePreview()
                                savedRegionValues += listOf(rect.left, rect.top, rect.right, rect.bottom)
                            }
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedButton(onClick = {
                                    if (savedRegionValues.isNotEmpty()) {
                                        redactionConfirmed = false
                                        publicationTermsConfirmed = false
                                        viewModel.clearEvidencePreview()
                                        savedRegionValues = savedRegionValues.dropLast(4)
                                    }
                                }, enabled = !submissionPendingConfirmation) { Text("撤销一框") }
                                OutlinedButton(onClick = {
                                    redactionConfirmed = false
                                    publicationTermsConfirmed = false
                                    viewModel.clearEvidencePreview()
                                    savedRegionValues = analysis.suggestedRegions.flatMap { listOf(it.left, it.top, it.right, it.bottom) }
                                }, enabled = !submissionPendingConfirmation) { Text("恢复建议") }
                            }
                            OutlinedButton(onClick = {
                                redactionConfirmed = false
                                publicationTermsConfirmed = false
                                viewModel.clearEvidencePreview()
                                savedRegionValues = listOf(0, 0, analysis.bitmap.width, analysis.bitmap.height)
                            }, enabled = !submissionPendingConfirmation, modifier = Modifier.fillMaxWidth()) { Text("操作不便：遮挡整张照片") }
                            Button(
                                onClick = { viewModel.prepareEvidencePreview(regions) },
                                enabled = !state.evidenceImageLoading && !submissionPendingConfirmation,
                                modifier = Modifier.fillMaxWidth(),
                            ) { Text("生成最终脱敏预览") }
                            state.evidencePreview?.let { preview ->
                                Text("以下是实际待上传图片，请确认敏感信息已完全遮挡。", fontWeight = FontWeight.Bold)
                                Image(
                                    bitmap = preview.asImageBitmap(),
                                    contentDescription = "实际待上传的脱敏图片预览",
                                    contentScale = ContentScale.Fit,
                                    modifier = Modifier.fillMaxWidth().height(300.dp),
                                )
                                Row(
                                    Modifier.fillMaxWidth()
                                        .toggleable(redactionConfirmed, enabled = !submissionPendingConfirmation, role = Role.Checkbox) { redactionConfirmed = it }
                                        .semantics(mergeDescendants = true) {},
                                ) {
                                    Checkbox(redactionConfirmed, null, enabled = !submissionPendingConfirmation)
                                    Text("我已检查最终脱敏图片", Modifier.padding(top = 12.dp))
                                }
                                Text(
                                    "公开范围：普通用户只看到结构化历史证据和聚合结论，复核图片仅具媒体审核权限的管理员可查看。保存周期：关联后最多 180 天。撤回方式：任务开放时重新提交不附图的复核可撤回旧图；匿名账户数据删除也会删除所属图片。",
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    style = MaterialTheme.typography.bodySmall,
                                )
                                Row(
                                    Modifier.fillMaxWidth()
                                        .toggleable(publicationTermsConfirmed, enabled = !submissionPendingConfirmation, role = Role.Checkbox) { publicationTermsConfirmed = it }
                                        .semantics(mergeDescendants = true) {},
                                ) {
                                    Checkbox(publicationTermsConfirmed, null, enabled = !submissionPendingConfirmation)
                                    Text("我已了解图片的查看范围、保存周期和撤回方式", Modifier.padding(top = 12.dp))
                                }
                            }
                        }
                    }
                }

                val includeImage = analysis != null
                val baseWeight = reviewEvidenceBaseWeight(includeImage, state.reviewLocationProof?.passed == true)
                Card(
                    shape = RoundedCornerShape(20.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
                ) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("预计证据基础权重：$baseWeight", fontWeight = FontWeight.Black)
                        Text("新安装账户或风控命中的票可能被限制为 0.5；最终权重由服务端规则计算。", style = MaterialTheme.typography.bodySmall)
                    }
                }
                if (state.evidenceImageLoading || state.reviewSubmittingTaskId == selectedTask.id) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        CircularProgressIndicator()
                        Text(if (state.reviewSubmittingTaskId == selectedTask.id) "正在安全提交…" else "正在设备上处理图片…")
                    }
                }
                state.reviewsError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                state.evidenceError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Button(
                    onClick = {
                        if (submissionPendingConfirmation && answer != null) {
                            viewModel.submitReview(selectedTask.id, answer!!, includeImage)
                        } else {
                            showSubmitConfirmation = true
                        }
                    },
                    enabled = answer != null && state.reviewSubmittingTaskId == null && !state.evidenceImageLoading &&
                        (!includeImage || (state.preparedEvidence != null && redactionConfirmed && publicationTermsConfirmed)),
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(if (submissionPendingConfirmation) "查询或重试原提交" else "检查并提交复核") }
                Text("一张票不会直接改变结论；系统还会检查人数、方向权重、账户历史、定位图片证据和异常重复。", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun ReviewTaskList(
    modifier: Modifier,
    tasks: List<ReviewTask>,
    loading: Boolean,
    loadingMore: Boolean,
    hasMore: Boolean,
    error: String?,
    notice: String?,
    onOpen: (String) -> Unit,
    onLoadMore: () -> Unit,
) {
    LazyColumn(modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("帮助其他行动不便用户确认真实现场", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Black)
            Text("请选择你确实了解的地点；位置和图片都可拒绝。系统不会生成演示任务。", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        notice?.let { item { Text(it, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold) } }
        if (loading) item { Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) { CircularProgressIndicator(); Text("读取复核任务…") } }
        error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
        if (!loading && tasks.isEmpty()) item {
            Card(shape = RoundedCornerShape(20.dp)) { Text("当前没有待复核任务，感谢你愿意帮忙。", Modifier.padding(24.dp)) }
        }
        items(tasks, key = { it.id }) { task ->
            Card(shape = RoundedCornerShape(20.dp)) {
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(task.placeName, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Black)
                    Text(task.featureName, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
                    Text(task.address ?: "地址待补充", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(reasonLabel(task.reason), style = MaterialTheme.typography.bodySmall)
                    Button(onClick = { onOpen(task.id) }, modifier = Modifier.fillMaxWidth()) { Text("开始独立复核") }
                }
            }
        }
        if (hasMore) item {
            OutlinedButton(onClick = onLoadMore, enabled = !loadingMore, modifier = Modifier.fillMaxWidth()) {
                if (loadingMore) Text("正在加载更多…") else Text("加载更多复核任务")
            }
        }
        item { Text("为了避免跟随多数，任务列表不会展示其他用户当前投票。", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 20.dp)) }
    }
}

@Composable
private fun TaskSummaryCard(task: ReviewTask) {
    Card(
        shape = RoundedCornerShape(22.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
    ) {
        Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(task.placeName, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Black)
            Text(task.featureName, style = MaterialTheme.typography.titleMedium)
            Text(task.address ?: "地址待补充")
            Text(reasonLabel(task.reason), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun HistoricalEvidenceCard(task: ReviewTask) {
    Card(
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Text("需要你复核的历史证据", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Black)
            if (task.historicalValue == null || task.historicalValue.isJsonNull) {
                Text("关联历史记录已不可用，请只根据当前现场作答。", color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Text(
                    "原记录：${task.featureName} ${historicalValueLabel(task)}",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    "来源：${historicalSourceLabel(task.historicalSource)} · 证据等级 ${task.historicalGrade ?: "U"} · ${freshnessLabel(task.historicalFreshnessStatus)}",
                )
                Text(
                    "记录时间：${task.historicalObservedAt?.take(10) ?: "未知"}${if (task.historicalHasRedactedMedia) " · 原记录附有脱敏图片" else " · 原记录未附图片"}",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Text(
                if (task.reason == "conflicting_votes") "冲突提示：已有独立用户给出了相反答案，请不要跟随原记录，只报告你当前看到的情况。" else "历史记录可能已经过期或现场已变化，只用于说明复核对象，不能证明现在仍可用。",
                color = MaterialTheme.colorScheme.error,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

private fun answerLabel(answer: String): String = when (answer) {
    "present" -> "存在"
    "absent" -> "不存在"
    else -> "不确定"
}

private fun reasonLabel(reason: String): String = when (reason) {
    "evidence_expired" -> "原证据已过有效期，需要重新确认"
    "conflicting_votes" -> "不同用户的现场信息存在冲突"
    else -> "需要独立用户补充现场确认"
}

private fun historicalValueLabel(task: ReviewTask): String {
    val value = task.historicalValue ?: return "未知"
    if (value.isJsonNull || !value.isJsonPrimitive) return "已记录结构化值"
    val primitive = value.asJsonPrimitive
    return when {
        primitive.isBoolean -> if (primitive.asBoolean) "存在" else "不存在"
        primitive.isNumber -> "${primitive.asString}${task.featureUnit?.let { " $it" }.orEmpty()}"
        else -> primitive.asString.take(80)
    }
}

private fun historicalSourceLabel(source: String?): String = when (source) {
    "community" -> "社区现场反馈"
    "merchant" -> "商户自报"
    "official" -> "官方资料"
    "ai" -> "AI 图片验真"
    "admin" -> "管理员核对"
    else -> "来源未知"
}

private fun freshnessLabel(status: String?): String = when (status) {
    "current" -> "仍在有效期"
    "expired" -> "已过期"
    else -> "时效未知"
}

private fun distanceBucketLabel(bucket: String): String = when (bucket) {
    "within_50m" -> "50 米内"
    "within_200m" -> "200 米内"
    "within_1km" -> "1 公里内"
    else -> "超过 1 公里"
}
