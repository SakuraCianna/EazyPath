package com.eazypath.ui.screens

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.amap.api.maps.AMap
import com.amap.api.maps.CameraUpdateFactory
import com.amap.api.maps.MapView
import com.amap.api.maps.MapsInitializer
import com.amap.api.maps.model.LatLng
import com.amap.api.location.AMapLocationClientOption

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccessibleMapScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val uriHandler = LocalUriHandler.current
    val preferences = remember { context.getSharedPreferences("eazypath_map_consent", Context.MODE_PRIVATE) }
    var consented by remember { mutableStateOf(preferences.getBoolean("amap_privacy_consent", false)) }
    Scaffold(topBar = { TopAppBar(title = { Text("基础地图与证据") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "返回") } }) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            Text("重要：高德没有轮椅路线模式。地图只提供基础地点与普通路线，EazyPath 证据不足的路段必须现场复核。", Modifier.fillMaxWidth().padding(14.dp), color = MaterialTheme.colorScheme.error)
            if (!consented) {
                Column(Modifier.fillMaxSize().padding(24.dp)) {
                    Text("地图与定位由北京高德图强科技有限公司的高德合包 SDK 提供。为展示地图、搜索地点和定位，SDK 可能处理位置信息、设备与应用信息、WLAN/网络和运营商信息、传感器信息及 OAID 等设备标识。本项目不会在你拒绝时初始化 SDK。")
                    Button(
                        onClick = { uriHandler.openUri("https://lbs.amap.com/home/privacy/") },
                        modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                    ) { Text("查看高德地图开放平台隐私权政策") }
                    Button(onClick = {
                        MapsInitializer.updatePrivacyShow(context, true, true)
                        MapsInitializer.updatePrivacyAgree(context, true)
                        AMapLocationClientOption.setLocationProtocol(AMapLocationClientOption.AMapLocationProtocol.HTTPS)
                        preferences.edit().putBoolean("amap_privacy_consent", true).apply()
                        consented = true
                    }, modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) { Text("同意并打开基础地图") }
                }
            } else {
                AMapView()
            }
        }
    }
}

@Composable
private fun AMapView() {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val mapView = remember {
        MapView(context).apply {
            onCreate(null)
            map.mapType = AMap.MAP_TYPE_NORMAL
            map.moveCamera(CameraUpdateFactory.newLatLngZoom(LatLng(28.6820, 115.8579), 11f))
        }
    }
    DisposableEffect(lifecycleOwner, mapView) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> mapView.onResume()
                Lifecycle.Event.ON_PAUSE -> mapView.onPause()
                Lifecycle.Event.ON_DESTROY -> mapView.onDestroy()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer); mapView.onDestroy() }
    }
    AndroidView(factory = { mapView }, modifier = Modifier.fillMaxSize())
}
