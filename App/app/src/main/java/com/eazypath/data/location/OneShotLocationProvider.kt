package com.eazypath.data.location

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.amap.api.location.AMapLocationClient
import com.amap.api.location.AMapLocationClientOption
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

data class DeviceLocation(
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Double,
)

class OneShotLocationProvider(context: Context) {
    private val applicationContext = context.applicationContext

    /**
     * 只在用户已阅读并同意本次定位说明后调用。精确坐标仅作为返回值短暂驻留内存，
     * 本类不写日志、不缓存，也不请求后台定位。
     */
    suspend fun locateAfterPrivacyConsent(): DeviceLocation = withTimeout(25_000L) {
        withContext(Dispatchers.Main.immediate) {
        AMapLocationClient.updatePrivacyShow(applicationContext, true, true)
        AMapLocationClient.updatePrivacyAgree(applicationContext, true)
        AMapLocationClientOption.setLocationProtocol(AMapLocationClientOption.AMapLocationProtocol.HTTPS)
        suspendCancellableCoroutine { continuation ->
            val client = AMapLocationClient(applicationContext)
            val finished = AtomicBoolean(false)
            val mainHandler = Handler(Looper.getMainLooper())
            val releaseClient = {
                client.stopLocation()
                client.onDestroy()
            }
            client.setLocationOption(
                AMapLocationClientOption().apply {
                    locationMode = AMapLocationClientOption.AMapLocationMode.Hight_Accuracy
                    isOnceLocation = true
                    isOnceLocationLatest = true
                    isNeedAddress = false
                    isMockEnable = false
                    isLocationCacheEnable = false
                    httpTimeOut = 15_000L
                },
            )
            client.setLocationListener { location ->
                if (!finished.compareAndSet(false, true)) return@setLocationListener
                releaseClient()
                val latitude = location?.latitude
                val longitude = location?.longitude
                val accuracy = location?.accuracy?.toDouble()
                if (
                    location != null && location.errorCode == 0 &&
                    latitude != null && latitude.isFinite() && latitude in -90.0..90.0 &&
                    longitude != null && longitude.isFinite() && longitude in -180.0..180.0 &&
                    accuracy != null && accuracy.isFinite() && accuracy > 0.0 && accuracy <= 500.0
                ) {
                    continuation.resume(DeviceLocation(latitude, longitude, accuracy))
                } else {
                    continuation.resumeWithException(
                        IllegalStateException("暂时无法获取满足精度要求的位置，请到开阔处重试"),
                    )
                }
            }
            continuation.invokeOnCancellation {
                if (finished.compareAndSet(false, true)) {
                    if (Looper.myLooper() == Looper.getMainLooper()) releaseClient() else mainHandler.post(releaseClient)
                }
            }
            client.startLocation()
        }
        }
    }
}
