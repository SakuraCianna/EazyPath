package com.eazypath.data.map

data class RouteCoordinate(
    val latitude: Double,
    val longitude: Double,
)

data class WalkingRouteNotice(
    val roadType: Int,
    val label: String,
    val instruction: String,
)

data class OrdinaryWalkingRoute(
    val distanceMeters: Int,
    val durationSeconds: Int,
    val points: List<RouteCoordinate>,
    val notices: List<WalkingRouteNotice>,
)

object MapAccessibilityRules {
    const val ROUTE_TITLE = "普通步行路线（未验证无障碍）"
    const val ROUTE_DISCLOSURE = "高德没有轮椅路线模式。路线结构提示不是无障碍认证，未覆盖路段需要现场复核。"

    fun roadTypeNotice(roadType: Int): String? = when (roadType) {
        3 -> "地下通道"
        4 -> "过街天桥"
        8 -> "扶梯"
        9 -> "直梯"
        20 -> "阶梯"
        21 -> "斜坡"
        22 -> "桥"
        23 -> "隧道"
        30 -> "轮渡"
        else -> null
    }

    fun evidenceLabel(status: String, count: Int): String = when {
        status == "evidence_available" && count > 0 -> "有 $count 项审核证据"
        else -> "无障碍情况未知"
    }
}
