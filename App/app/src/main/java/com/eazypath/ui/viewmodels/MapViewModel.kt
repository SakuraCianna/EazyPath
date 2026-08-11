package com.eazypath.ui.viewmodels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.eazypath.data.EazyPathRepository
import com.eazypath.data.map.OrdinaryWalkingRoute
import com.eazypath.data.map.RouteCoordinate
import com.eazypath.data.network.PlaceDetails
import com.eazypath.data.network.PlaceSearchItem
import com.eazypath.data.network.ServiceAction
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class MapRouteEndpoint(
    val label: String,
    val coordinate: RouteCoordinate,
    val placeId: String? = null,
)

data class MapUiState(
    val searchResults: List<PlaceSearchItem> = emptyList(),
    val searchLoading: Boolean = false,
    val selectedPlace: PlaceSearchItem? = null,
    val selectedDetails: PlaceDetails? = null,
    val detailsLoading: Boolean = false,
    val origin: MapRouteEndpoint? = null,
    val destination: MapRouteEndpoint? = null,
    val destinationActions: List<ServiceAction> = emptyList(),
    val locationLoading: Boolean = false,
    val route: OrdinaryWalkingRoute? = null,
    val routeLoading: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
)

class MapViewModel(private val repository: EazyPathRepository) : ViewModel() {
    private val _state = MutableStateFlow(MapUiState())
    val state: StateFlow<MapUiState> = _state.asStateFlow()

    private var searchJob: Job? = null
    private var detailsJob: Job? = null
    private var locationJob: Job? = null
    private var routeJob: Job? = null
    private var actionsJob: Job? = null
    private var searchGeneration = 0L
    private var detailsGeneration = 0L
    private var routeGeneration = 0L
    private var actionsGeneration = 0L

    fun search(query: String) {
        val normalized = query.trim()
        if (normalized.isBlank()) return
        val requestGeneration = ++searchGeneration
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            _state.value = _state.value.copy(searchLoading = true, error = null, notice = null)
            try {
                val results = repository.searchPlaces(normalized)
                if (requestGeneration == searchGeneration) {
                    _state.value = _state.value.copy(
                        searchResults = results,
                        searchLoading = false,
                        notice = if (results.isEmpty()) "没有找到可用的真实地点，请换一个名称或补充区县后重试。" else null,
                    )
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                if (requestGeneration == searchGeneration) {
                    _state.value = _state.value.copy(searchLoading = false, error = error.userMessage())
                }
            }
        }
    }

    fun selectPlace(place: PlaceSearchItem) {
        val requestGeneration = ++detailsGeneration
        detailsJob?.cancel()
        _state.value = _state.value.copy(
            selectedPlace = place,
            selectedDetails = null,
            detailsLoading = true,
            error = null,
        )
        detailsJob = viewModelScope.launch {
            try {
                val details = repository.getPlaceDetails(place.id)
                if (requestGeneration == detailsGeneration && _state.value.selectedPlace?.id == place.id) {
                    _state.value = _state.value.copy(selectedDetails = details, detailsLoading = false)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                if (requestGeneration == detailsGeneration && _state.value.selectedPlace?.id == place.id) {
                    _state.value = _state.value.copy(detailsLoading = false, error = error.userMessage())
                }
            }
        }
    }

    fun setOrigin(place: PlaceSearchItem) {
        routeGeneration += 1
        locationJob?.cancel()
        routeJob?.cancel()
        _state.value = _state.value.copy(
            origin = place.toEndpoint(),
            locationLoading = false,
            route = null,
            routeLoading = false,
            notice = "已把 ${place.name} 设为起点",
            error = null,
        )
    }

    fun useCurrentLocationAsOrigin() {
        if (locationJob?.isActive == true) return
        routeGeneration += 1
        routeJob?.cancel()
        _state.value = _state.value.copy(route = null, routeLoading = false)
        locationJob = viewModelScope.launch {
            _state.value = _state.value.copy(locationLoading = true, error = null, notice = null)
            try {
                val location = repository.locateOnceForMap()
                _state.value = _state.value.copy(
                    origin = MapRouteEndpoint(
                        label = "我的一次性当前位置",
                        coordinate = RouteCoordinate(location.latitude, location.longitude),
                    ),
                    route = null,
                    routeLoading = false,
                    locationLoading = false,
                    notice = "当前位置仅保存在本页内存中，离开地图即释放",
                )
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                _state.value = _state.value.copy(locationLoading = false, error = error.userMessage())
            }
        }
    }

    fun locationPermissionDenied() {
        _state.value = _state.value.copy(
            locationLoading = false,
            notice = "未授予定位权限。你仍可从真实地点搜索结果手动选择起点。",
        )
    }

    fun setDestination(place: PlaceSearchItem) {
        routeGeneration += 1
        routeJob?.cancel()
        _state.value = _state.value.copy(
            destination = place.toEndpoint(),
            destinationActions = emptyList(),
            route = null,
            routeLoading = false,
            notice = "已把 ${place.name} 设为终点",
            error = null,
        )
        loadActions(place)
    }

    fun planRoute() {
        val origin = _state.value.origin ?: return
        val destination = _state.value.destination ?: return
        if (origin.coordinate == destination.coordinate || routeJob?.isActive == true) return
        val requestGeneration = ++routeGeneration
        routeJob = viewModelScope.launch {
            _state.value = _state.value.copy(route = null, routeLoading = true, error = null, notice = null)
            try {
                val route = repository.planOrdinaryWalkingRoute(origin.coordinate, destination.coordinate)
                if (requestGeneration == routeGeneration) {
                    _state.value = _state.value.copy(route = route, routeLoading = false)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                if (requestGeneration == routeGeneration) {
                    _state.value = _state.value.copy(routeLoading = false, error = error.userMessage())
                }
            }
        }
    }

    fun clearRoute() {
        routeGeneration += 1
        routeJob?.cancel()
        _state.value = _state.value.copy(route = null, routeLoading = false, error = null)
    }

    /**
     * 地图 NavBackStackEntry 可能在跳往反馈或社区页时继续存活，因此不能只依赖 onCleared。
     * 离开地图前主动取消全部请求并清空精确起点、路线折线和地点上下文。
     */
    fun releaseMapSession() {
        searchGeneration += 1
        detailsGeneration += 1
        routeGeneration += 1
        actionsGeneration += 1
        searchJob?.cancel()
        detailsJob?.cancel()
        locationJob?.cancel()
        routeJob?.cancel()
        actionsJob?.cancel()
        _state.value = MapUiState()
    }

    private fun loadActions(place: PlaceSearchItem) {
        val requestGeneration = ++actionsGeneration
        actionsJob?.cancel()
        actionsJob = viewModelScope.launch {
            try {
                val actions = repository.resolveAmapActions(place)
                if (requestGeneration == actionsGeneration && _state.value.destination?.placeId == place.id) {
                    _state.value = _state.value.copy(destinationActions = actions)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                if (requestGeneration == actionsGeneration && _state.value.destination?.placeId == place.id) {
                    _state.value = _state.value.copy(error = error.userMessage())
                }
            }
        }
    }

    override fun onCleared() {
        releaseMapSession()
        super.onCleared()
    }

    companion object {
        fun factory(repository: EazyPathRepository): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = MapViewModel(repository) as T
        }
    }
}

private fun PlaceSearchItem.toEndpoint() = MapRouteEndpoint(
    label = name,
    coordinate = RouteCoordinate(latitude = latitude, longitude = longitude),
    placeId = id,
)

private fun Throwable.userMessage(): String = message?.takeIf { it.isNotBlank() }
    ?: "服务暂时不可用，请检查网络后重试"
