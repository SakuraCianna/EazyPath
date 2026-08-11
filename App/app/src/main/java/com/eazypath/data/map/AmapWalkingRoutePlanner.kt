package com.eazypath.data.map

import android.content.Context
import com.amap.api.services.core.LatLonPoint
import com.amap.api.services.core.ServiceSettings
import com.amap.api.services.route.BusRouteResultV2
import com.amap.api.services.route.DriveRouteResultV2
import com.amap.api.services.route.RideRouteResultV2
import com.amap.api.services.route.RouteSearchV2
import com.amap.api.services.route.WalkRouteResultV2
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

class AmapWalkingRoutePlanner(context: Context) {
    private val applicationContext = context.applicationContext

    suspend fun plan(origin: RouteCoordinate, destination: RouteCoordinate): OrdinaryWalkingRoute =
        withTimeout(25_000L) {
            withContext(Dispatchers.Main.immediate) {
                configureSearchPrivacy()
                suspendCancellableCoroutine { continuation ->
                    val completed = AtomicBoolean(false)
                    val search = RouteSearchV2(applicationContext)
                    search.setRouteSearchListener(object : RouteSearchV2.OnRouteSearchListener {
                        override fun onWalkRouteSearched(result: WalkRouteResultV2?, errorCode: Int) {
                            if (!completed.compareAndSet(false, true) || !continuation.isActive) return
                            search.setRouteSearchListener(null)
                            val path = result?.paths?.firstOrNull()
                            if (errorCode != AMAP_SUCCESS || path == null) {
                                continuation.resumeWithException(
                                    IllegalStateException("普通步行路线暂时不可用（高德错误码 $errorCode）"),
                                )
                                return
                            }
                            val points = path.polyline.orEmpty().map {
                                RouteCoordinate(latitude = it.latitude, longitude = it.longitude)
                            }
                            if (points.size < 2) {
                                continuation.resumeWithException(IllegalStateException("高德未返回可绘制的步行路线"))
                                return
                            }
                            val notices = path.steps.orEmpty().mapNotNull { step ->
                                val label = MapAccessibilityRules.roadTypeNotice(step.roadType) ?: return@mapNotNull null
                                WalkingRouteNotice(step.roadType, label, step.instruction.orEmpty())
                            }.distinctBy { it.roadType to it.instruction }
                            continuation.resume(
                                OrdinaryWalkingRoute(
                                    distanceMeters = path.distance.toInt().coerceAtLeast(0),
                                    durationSeconds = path.duration.toInt().coerceAtLeast(0),
                                    points = points,
                                    notices = notices,
                                ),
                            )
                        }

                        override fun onBusRouteSearched(result: BusRouteResultV2?, errorCode: Int) = Unit
                        override fun onDriveRouteSearched(result: DriveRouteResultV2?, errorCode: Int) = Unit
                        override fun onRideRouteSearched(result: RideRouteResultV2?, errorCode: Int) = Unit
                    })
                    continuation.invokeOnCancellation {
                        completed.set(true)
                        search.setRouteSearchListener(null)
                    }
                    val fromAndTo = RouteSearchV2.FromAndTo(
                        LatLonPoint(origin.latitude, origin.longitude),
                        LatLonPoint(destination.latitude, destination.longitude),
                    )
                    search.calculateWalkRouteAsyn(
                        RouteSearchV2.WalkRouteQuery(fromAndTo).apply {
                            alternativeRoute = RouteSearchV2.AlternativeRoute.ALTERNATIVE_ROUTE_ONE
                            isIndoor = false
                        },
                    )
                }
            }
        }

    private fun configureSearchPrivacy() {
        ServiceSettings.updatePrivacyShow(applicationContext, true, true)
        ServiceSettings.updatePrivacyAgree(applicationContext, true)
        ServiceSettings.getInstance().protocol = ServiceSettings.HTTPS
        ServiceSettings.getInstance().connectionTimeOut = 15_000
        ServiceSettings.getInstance().soTimeOut = 15_000
    }

    private companion object {
        const val AMAP_SUCCESS = 1000
    }
}
