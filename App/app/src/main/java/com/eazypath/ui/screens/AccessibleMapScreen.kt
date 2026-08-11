package com.eazypath.ui.screens

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Route
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.amap.api.location.AMapLocationClient
import com.amap.api.location.AMapLocationClientOption
import com.amap.api.maps.AMap
import com.amap.api.maps.CameraUpdateFactory
import com.amap.api.maps.MapView
import com.amap.api.maps.MapsInitializer
import com.amap.api.maps.model.BitmapDescriptorFactory
import com.amap.api.maps.model.LatLng
import com.amap.api.maps.model.LatLngBounds
import com.amap.api.maps.model.MarkerOptions
import com.amap.api.maps.model.PolylineOptions
import com.amap.api.services.core.ServiceSettings
import com.eazypath.data.map.MapAccessibilityRules
import com.eazypath.data.network.PlaceEvidence
import com.eazypath.data.network.PlaceSearchItem
import com.eazypath.ui.components.executeActionWithFallback
import com.eazypath.ui.components.ExternalActionResult
import com.eazypath.ui.viewmodels.MapRouteEndpoint
import com.eazypath.ui.viewmodels.MapUiState
import com.eazypath.ui.viewmodels.MapViewModel
import com.google.gson.JsonElement

private const val AMAP_PRIVACY_URL = "https://lbs.amap.com/home/privacy/"
private const val AMAP_CONSENT_KEY = "amap_privacy_consent_2025_05_30"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccessibleMapScreen(
    viewModel: MapViewModel,
    onSubmitEvidence: () -> Unit,
    onCommunity: () -> Unit,
    onBack: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val uriHandler = LocalUriHandler.current
    val preferences = remember { context.getSharedPreferences("eazypath_map_consent", Context.MODE_PRIVATE) }
    var consented by remember { mutableStateOf(preferences.getBoolean(AMAP_CONSENT_KEY, false)) }
    var showLocationExplanation by remember { mutableStateOf(false) }
    val locationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) viewModel.useCurrentLocationAsOrigin()
        else viewModel.locationPermissionDenied()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("地图与出行证据") },
                navigationIcon = {
                    IconButton(onClick = { viewModel.releaseMapSession(); onBack() }) {
                        Icon(Icons.Default.ArrowBack, "返回")
                    }
                },
            )
        },
    ) { padding ->
        if (!consented) {
            AmapConsentPanel(
                modifier = Modifier.fillMaxSize().padding(padding),
                onOpenPolicy = { uriHandler.openUri(AMAP_PRIVACY_URL) },
                onAgree = {
                    configureAmapPrivacy(context)
                    preferences.edit().putBoolean(AMAP_CONSENT_KEY, true).apply()
                    consented = true
                },
            )
        } else {
            MapWorkspace(
                state = state,
                modifier = Modifier.fillMaxSize().padding(padding),
                onSearch = viewModel::search,
                onSelect = viewModel::selectPlace,
                onSetOrigin = viewModel::setOrigin,
                onSetDestination = viewModel::setDestination,
                onUseLocation = {
                    showLocationExplanation = true
                },
                onPlanRoute = viewModel::planRoute,
                onSubmitEvidence = { viewModel.releaseMapSession(); onSubmitEvidence() },
                onCommunity = { viewModel.releaseMapSession(); onCommunity() },
            )
        }
    }

    if (showLocationExplanation) {
        AlertDialog(
            onDismissRequest = { showLocationExplanation = false },
            title = { Text("使用一次当前位置作为起点？") },
            text = { Text("高德定位会处理精确位置。坐标只保存在当前地图页面内存中，用于本次路线计算；不会写入 EazyPath 数据库，离开页面即释放。你可以拒绝并手动选择地点。") },
            confirmButton = {
                Button(onClick = {
                    showLocationExplanation = false
                    if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                        viewModel.useCurrentLocationAsOrigin()
                    } else {
                        locationPermission.launch(Manifest.permission.ACCESS_FINE_LOCATION)
                    }
                }) { Text("仅本次使用") }
            },
            dismissButton = { OutlinedButton(onClick = { showLocationExplanation = false }) { Text("手动选择") } },
        )
    }
}

@Composable
private fun AmapConsentPanel(
    modifier: Modifier,
    onOpenPolicy: () -> Unit,
    onAgree: () -> Unit,
) {
    LazyColumn(
        modifier = modifier.padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Text("打开地图前，请先了解第三方处理", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        }
        item {
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer),
                shape = RoundedCornerShape(24.dp),
            ) {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("服务提供者", fontWeight = FontWeight.Bold)
                    Text("北京高德图强科技有限公司提供高德地图、搜索、普通步行路线和按需定位 SDK。")
                    Text("可能处理的信息", fontWeight = FontWeight.Bold)
                    Text("位置信息、设备与应用信息、WLAN/网络与运营商信息、传感器信息及 OAID 等设备标识，用于地图展示、地点搜索、路线计算和你主动发起的一次定位。")
                    Text("拒绝不会影响手动地点搜索以外的 EazyPath 功能；未同意前不会初始化高德 SDK。")
                }
            }
        }
        item { OutlinedButton(onClick = onOpenPolicy, modifier = Modifier.fillMaxWidth()) { Text("查看高德开放平台隐私权政策") } }
        item { Button(onClick = onAgree, modifier = Modifier.fillMaxWidth()) { Text("同意并打开地图") } }
    }
}

@Composable
private fun MapWorkspace(
    state: MapUiState,
    modifier: Modifier,
    onSearch: (String) -> Unit,
    onSelect: (PlaceSearchItem) -> Unit,
    onSetOrigin: (PlaceSearchItem) -> Unit,
    onSetDestination: (PlaceSearchItem) -> Unit,
    onUseLocation: () -> Unit,
    onPlanRoute: () -> Unit,
    onSubmitEvidence: () -> Unit,
    onCommunity: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var query by remember { mutableStateOf("") }
    var evidenceOnly by remember { mutableStateOf(false) }
    var externalPending by remember { mutableStateOf(false) }
    var externalPaused by remember { mutableStateOf(false) }
    var showExternalResult by remember { mutableStateOf(false) }
    val visibleResults = if (evidenceOnly) state.searchResults.filter { it.accessibility.status == "evidence_available" } else state.searchResults
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_PAUSE -> if (externalPending) externalPaused = true
                Lifecycle.Event.ON_RESUME -> if (externalPending && externalPaused) {
                    externalPending = false
                    externalPaused = false
                    showExternalResult = true
                }
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    LazyColumn(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Card(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
                shape = RoundedCornerShape(18.dp),
            ) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("高德没有轮椅路线模式", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onErrorContainer)
                    Text("所有路线均为普通步行路线；地点证据不能证明地点之间的整段道路可通行。", fontSize = 13.sp)
                }
            }
        }
        item {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.weight(1f),
                    label = { Text("搜索江西真实地点") },
                    singleLine = true,
                    leadingIcon = { Icon(Icons.Default.Search, null) },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { onSearch(query) }),
                )
                Button(onClick = { onSearch(query) }, enabled = query.isNotBlank() && !state.searchLoading) { Text("搜索") }
            }
        }
        item {
            RouteMap(state = state.copy(searchResults = visibleResults), onSelect = onSelect, modifier = Modifier.fillMaxWidth().height(320.dp))
        }
        item {
            Text(
                "地图标记：蓝色表示有审核证据，橙色表示无障碍情况未知。下方列表提供相同的文字状态和操作，不需要依赖颜色或地图手势。",
                modifier = Modifier.padding(horizontal = 16.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 12.sp,
            )
        }
        if (state.searchLoading || state.detailsLoading || state.locationLoading || state.routeLoading) {
            item {
                Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    CircularProgressIndicator(Modifier.height(22.dp))
                    Text(
                        when {
                            state.routeLoading -> "正在请求普通步行路线"
                            state.locationLoading -> "正在获取一次性当前位置"
                            state.detailsLoading -> "正在读取地点证据"
                            else -> "正在搜索真实地点"
                        },
                    )
                }
            }
        }
        state.error?.let { item { MessageCard(it, true) } }
        state.notice?.let { item { MessageCard(it, false) } }
        item {
            EndpointCard(
                origin = state.origin,
                destination = state.destination,
                locationLoading = state.locationLoading,
                routeLoading = state.routeLoading,
                onUseLocation = onUseLocation,
                onPlanRoute = onPlanRoute,
            )
        }
        state.selectedDetails?.let { details ->
            item { SectionTitle("${details.place.name} · 审核证据") }
            if (details.evidenceTimeline.isEmpty()) {
                item { MessageCard("暂无审核通过且未撤回的无障碍证据，不能据此判断可通行。", false) }
            } else {
                items(details.evidenceTimeline, key = { "selected-${it.id}" }) { EvidenceCard(it) }
                if (details.evidenceTimelineHasMore) item { MessageCard("这里只展示最新 200 条证据。", false) }
            }
            item {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Button(onClick = onSubmitEvidence, modifier = Modifier.weight(1f)) { Text("提交现场信息") }
                    OutlinedButton(onClick = onCommunity, modifier = Modifier.weight(1f)) { Text("参与社区复核") }
                }
            }
        }
        state.route?.let { route ->
            item { RouteSummaryCard(route.distanceMeters, route.durationSeconds, route.notices.map { it.label to it.instruction }) }
            if (state.destinationActions.isNotEmpty()) {
                item {
                    Card(Modifier.padding(horizontal = 16.dp), shape = RoundedCornerShape(20.dp)) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("继续使用平台", fontWeight = FontWeight.Bold)
                            state.destinationActions.forEach { action ->
                                val click = {
                                    externalPending = action.type != "clipboard"
                                    val result = executeActionWithFallback(context, state.destinationActions, action)
                                    if (result != ExternalActionResult.LAUNCHED) externalPending = false
                                }
                                if (action.type == "app_uri") Button(onClick = click, modifier = Modifier.fillMaxWidth()) { Text(action.label) }
                                else OutlinedButton(onClick = click, modifier = Modifier.fillMaxWidth()) { Text(action.label) }
                            }
                        }
                    }
                }
            }
        }
        if (state.searchResults.isNotEmpty()) {
            item { SectionTitle("搜索结果") }
            item {
                FilterChip(
                    selected = evidenceOnly,
                    onClick = { evidenceOnly = !evidenceOnly },
                    label = { Text("只看有审核证据的地点") },
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }
            if (visibleResults.isEmpty()) item { MessageCard("当前结果中没有审核证据，可关闭筛选查看未知地点。", false) }
            items(visibleResults, key = { it.id }) { place ->
                PlaceResultCard(place, onSelect, onSetOrigin, onSetDestination)
            }
        }
        item { Box(Modifier.height(24.dp)) }
    }
    if (showExternalResult) {
        AlertDialog(
            onDismissRequest = { showExternalResult = false },
            title = { Text("平台操作完成了吗？") },
            text = { Text("第三方平台的结果不会自动回写 EazyPath。请确认是否已查看路线；若未完成，可再次打开或使用复制沟通卡。") },
            confirmButton = { Button(onClick = { showExternalResult = false }) { Text("已完成") } },
            dismissButton = { OutlinedButton(onClick = { showExternalResult = false }) { Text("尚未完成") } },
        )
    }
}

@Composable
private fun RouteMap(state: MapUiState, onSelect: (PlaceSearchItem) -> Unit, modifier: Modifier) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val currentSelect by rememberUpdatedState(onSelect)
    val currentResults by rememberUpdatedState(state.searchResults)
    var lastSignature by remember { mutableStateOf("") }
    val mapView = remember {
        configureAmapPrivacy(context)
        MapView(context).apply {
            onCreate(null)
            map.mapType = AMap.MAP_TYPE_NORMAL
            map.uiSettings.isZoomControlsEnabled = true
            map.moveCamera(CameraUpdateFactory.newLatLngZoom(LatLng(28.6820, 115.8579), 9.5f))
        }
    }
    DisposableEffect(lifecycleOwner, mapView) {
        var mapResumed = false
        val resumeMap = {
            if (!mapResumed) {
                mapView.onResume()
                mapResumed = true
            }
        }
        val pauseMap = {
            if (mapResumed) {
                mapView.onPause()
                mapResumed = false
            }
        }
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> resumeMap()
                Lifecycle.Event.ON_PAUSE -> pauseMap()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        if (lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) resumeMap()
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            pauseMap()
            mapView.onDestroy()
        }
    }
    AndroidView(
        factory = {
            mapView.apply {
                map.setOnMarkerClickListener { marker ->
                    val placeId = marker.`object` as? String
                    currentResults.firstOrNull { it.id == placeId }?.let(currentSelect)
                    false
                }
            }
        },
        modifier = modifier,
        update = { view ->
            view.contentDescription = buildString {
                append("高德地图，显示 ${state.searchResults.size} 个地点")
                if (state.route != null) append("和一条普通步行路线，路线未经无障碍验证")
                append("。可使用下方文字列表完成相同操作。")
            }
            val signature = buildString {
                append(state.searchResults.hashCode())
                append(':').append(state.selectedPlace.hashCode())
                append(':').append(state.origin.hashCode())
                append(':').append(state.destination.hashCode())
                append(':').append(state.route.hashCode())
            }
            if (signature != lastSignature) {
                lastSignature = signature
                renderMap(view.map, state)
            }
        },
    )
}

private fun renderMap(amap: AMap, state: MapUiState) {
    amap.clear()
    val bounds = LatLngBounds.builder()
    var pointCount = 0
    val hasRoute = state.route != null
    state.searchResults.forEach { place ->
        val position = LatLng(place.latitude, place.longitude)
        val hue = if (place.accessibility.status == "evidence_available") BitmapDescriptorFactory.HUE_AZURE else BitmapDescriptorFactory.HUE_ORANGE
        amap.addMarker(
            MarkerOptions().position(position).title(place.name)
                .snippet(MapAccessibilityRules.evidenceLabel(place.accessibility.status, place.accessibility.verifiedFeatureCount))
                .icon(BitmapDescriptorFactory.defaultMarker(hue)),
        ).`object` = place.id
        if (!hasRoute) {
            bounds.include(position)
            pointCount += 1
        }
    }
    state.route?.points?.map { LatLng(it.latitude, it.longitude) }?.takeIf { it.size >= 2 }?.let { points ->
        amap.addPolyline(
            PolylineOptions().addAll(points).width(14f).color(0xff365ca8.toInt()).geodesic(false),
        )
        points.forEach(bounds::include)
        pointCount += points.size
    }
    state.origin?.let {
        val position = LatLng(it.coordinate.latitude, it.coordinate.longitude)
        amap.addMarker(MarkerOptions().position(position).title("起点：${it.label}").icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_GREEN)))
        bounds.include(position)
        pointCount += 1
    }
    state.destination?.let {
        val position = LatLng(it.coordinate.latitude, it.coordinate.longitude)
        amap.addMarker(MarkerOptions().position(position).title("终点：${it.label}").icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_RED)))
        bounds.include(position)
        pointCount += 1
    }
    when {
        pointCount >= 2 -> runCatching { amap.animateCamera(CameraUpdateFactory.newLatLngBounds(bounds.build(), 90)) }
        pointCount == 1 -> {
            val target = state.selectedPlace?.let { LatLng(it.latitude, it.longitude) }
                ?: state.destination?.let { LatLng(it.coordinate.latitude, it.coordinate.longitude) }
                ?: state.origin?.let { LatLng(it.coordinate.latitude, it.coordinate.longitude) }
            if (target != null) amap.animateCamera(CameraUpdateFactory.newLatLngZoom(target, 16f))
        }
    }
}

@Composable
private fun PlaceResultCard(
    place: PlaceSearchItem,
    onSelect: (PlaceSearchItem) -> Unit,
    onSetOrigin: (PlaceSearchItem) -> Unit,
    onSetDestination: (PlaceSearchItem) -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        shape = RoundedCornerShape(20.dp),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(place.name, fontWeight = FontWeight.Bold, fontSize = 17.sp)
            Text(place.address ?: "地址未提供", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
            Text(
                MapAccessibilityRules.evidenceLabel(place.accessibility.status, place.accessibility.verifiedFeatureCount),
                color = if (place.accessibility.status == "evidence_available") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                fontWeight = FontWeight.Medium,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { onSetOrigin(place) }) { Text("设为起点") }
                Button(onClick = { onSetDestination(place) }) { Text("设为终点") }
            }
            FilledTonalButton(onClick = { onSelect(place) }, modifier = Modifier.fillMaxWidth()) { Text("查看审核证据") }
        }
    }
}

@Composable
private fun EndpointCard(
    origin: MapRouteEndpoint?,
    destination: MapRouteEndpoint?,
    locationLoading: Boolean,
    routeLoading: Boolean,
    onUseLocation: () -> Unit,
    onPlanRoute: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
        shape = RoundedCornerShape(22.dp),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("路线起终点", fontWeight = FontWeight.Bold, modifier = Modifier.semantics { heading() })
            Text("起点：${origin?.label ?: "请从搜索结果选择，或按需使用当前位置"}")
            Text("终点：${destination?.label ?: "请从搜索结果选择"}")
            OutlinedButton(onClick = onUseLocation, enabled = !locationLoading, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Default.LocationOn, null)
                Text(if (locationLoading) "正在定位" else "使用一次当前位置作为起点")
            }
            Button(
                onClick = onPlanRoute,
                enabled = origin != null && destination != null && origin.coordinate != destination.coordinate && !routeLoading,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Default.Route, null)
                Text(if (routeLoading) "正在计算" else "计算普通步行路线")
            }
        }
    }
}

@Composable
private fun RouteSummaryCard(distanceMeters: Int, durationSeconds: Int, notices: List<Pair<String, String>>) {
    Card(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer),
        shape = RoundedCornerShape(22.dp),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(MapAccessibilityRules.ROUTE_TITLE, fontWeight = FontWeight.Bold, fontSize = 18.sp)
            Text("约 ${formatDistance(distanceMeters)} · ${formatDuration(durationSeconds)}")
            Text(MapAccessibilityRules.ROUTE_DISCLOSURE, color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.Medium)
            HorizontalDivider()
            Text("路段结构提示", fontWeight = FontWeight.Bold)
            if (notices.isEmpty()) Text("高德未返回阶梯、扶梯等特殊结构；这不等于全程无障碍。")
            notices.forEach { (label, instruction) -> Text("• $label${instruction.takeIf { it.isNotBlank() }?.let { "：$it" }.orEmpty()}") }
        }
    }
}

@Composable
private fun EvidenceCard(evidence: PlaceEvidence) {
    Card(Modifier.fillMaxWidth().padding(horizontal = 16.dp), shape = RoundedCornerShape(18.dp)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(evidence.displayName, fontWeight = FontWeight.Bold)
                Text("${evidence.grade} 级", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
            }
            Text(formatEvidenceValue(evidence.value), fontSize = 16.sp)
            Text("来源 ${evidence.source} · ${freshnessLabel(evidence.freshnessStatus)}", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
            evidence.observedAt?.let { Text("观测时间 ${it.take(10)}", fontSize = 12.sp) }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp).semantics { heading() },
        style = MaterialTheme.typography.titleLarge,
        fontWeight = FontWeight.Bold,
    )
}

@Composable
private fun MessageCard(message: String, error: Boolean) {
    Card(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceVariant,
        ),
        shape = RoundedCornerShape(16.dp),
    ) { Text(message, Modifier.padding(14.dp)) }
}

private fun configureAmapPrivacy(context: Context) {
    MapsInitializer.updatePrivacyShow(context, true, true)
    MapsInitializer.updatePrivacyAgree(context, true)
    AMapLocationClient.updatePrivacyShow(context, true, true)
    AMapLocationClient.updatePrivacyAgree(context, true)
    ServiceSettings.updatePrivacyShow(context, true, true)
    ServiceSettings.updatePrivacyAgree(context, true)
    MapsInitializer.setProtocol(MapsInitializer.HTTPS)
    ServiceSettings.getInstance().protocol = ServiceSettings.HTTPS
    AMapLocationClientOption.setLocationProtocol(AMapLocationClientOption.AMapLocationProtocol.HTTPS)
}

private fun formatEvidenceValue(value: JsonElement): String = when {
    value.isJsonNull -> "未知"
    value.isJsonPrimitive && value.asJsonPrimitive.isBoolean -> if (value.asBoolean) "存在 / 可用" else "不存在 / 不可用"
    value.isJsonPrimitive -> value.asString
    else -> value.toString()
}

private fun freshnessLabel(status: String): String = when (status) {
    "fresh" -> "有效期内"
    "stale" -> "可能已过期"
    "expired" -> "已过期"
    else -> "时效未知"
}

private fun formatDistance(meters: Int): String = if (meters < 1_000) "$meters 米" else String.format("%.1f 公里", meters / 1_000.0)

private fun formatDuration(seconds: Int): String {
    val minutes = (seconds / 60).coerceAtLeast(1)
    return if (minutes < 60) "约 $minutes 分钟" else "约 ${minutes / 60} 小时 ${minutes % 60} 分钟"
}
