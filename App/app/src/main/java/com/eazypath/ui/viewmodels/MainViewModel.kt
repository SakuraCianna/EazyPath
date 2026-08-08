package com.eazypath.ui.viewmodels

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.eazypath.data.EazyPathRepository
import com.eazypath.data.network.InteractionProfile
import com.eazypath.data.network.MobilityProfile
import com.eazypath.data.network.ProfileData
import com.eazypath.data.network.ReviewTask
import com.eazypath.data.network.TaskDetails
import com.eazypath.data.network.VerificationDetails
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch

data class MainUiState(
    val sessionReady: Boolean = false,
    val sessionLoading: Boolean = true,
    val sessionError: String? = null,
    val profile: ProfileData? = null,
    val profileSaving: Boolean = false,
    val task: TaskDetails? = null,
    val taskLoading: Boolean = false,
    val taskError: String? = null,
    val verification: VerificationDetails? = null,
    val verificationLoading: Boolean = false,
    val verificationNotice: String? = null,
    val verificationError: String? = null,
    val reviewTasks: List<ReviewTask> = emptyList(),
    val reviewsLoading: Boolean = false,
    val reviewsError: String? = null,
)

class MainViewModel(private val repository: EazyPathRepository) : ViewModel() {
    private val _state = MutableStateFlow(MainUiState())
    val state: StateFlow<MainUiState> = _state.asStateFlow()
    private var taskEventsJob: Job? = null
    private var activePrompt: String? = null

    init {
        bootstrap()
    }

    fun retryBootstrap() = bootstrap()

    fun loadProfile() {
        viewModelScope.launch {
            runCatching { repository.getProfile() }
                .onSuccess { _state.value = _state.value.copy(profile = it, sessionReady = true) }
                .onFailure { _state.value = _state.value.copy(sessionError = it.userMessage()) }
        }
    }

    fun saveProfile(mobility: MobilityProfile, interaction: InteractionProfile) {
        viewModelScope.launch {
            _state.value = _state.value.copy(profileSaving = true, sessionError = null)
            runCatching { repository.updateProfile(mobility, interaction) }
                .onSuccess { _state.value = _state.value.copy(profile = it, profileSaving = false) }
                .onFailure { _state.value = _state.value.copy(profileSaving = false, sessionError = it.userMessage()) }
        }
    }

    fun createTravelTask(prompt: String) {
        if (activePrompt == prompt && (_state.value.taskLoading || _state.value.task != null)) return
        activePrompt = prompt
        taskEventsJob?.cancel()
        viewModelScope.launch {
            _state.value = _state.value.copy(task = null, taskLoading = true, taskError = null)
            runCatching {
                val profile = _state.value.profile ?: repository.getProfile().also {
                    _state.value = _state.value.copy(profile = it)
                }
                repository.createTask(prompt, profile.version)
            }.onSuccess { taskId ->
                refreshTask(taskId)
                observeTask(taskId)
            }.onFailure {
                _state.value = _state.value.copy(taskLoading = false, taskError = it.userMessage())
            }
        }
    }

    fun retryCurrentTask() {
        val prompt = activePrompt ?: return
        activePrompt = null
        createTravelTask(prompt)
    }

    fun submitVerification(uri: Uri, scene: String) {
        viewModelScope.launch {
            _state.value = _state.value.copy(verification = null, verificationLoading = true, verificationError = null)
            runCatching { repository.createVerification(uri, scene) }
                .onSuccess { (id, notice) ->
                    _state.value = _state.value.copy(verificationNotice = notice)
                    pollVerification(id)
                }
                .onFailure { _state.value = _state.value.copy(verificationLoading = false, verificationError = it.userMessage()) }
        }
    }

    fun loadReviewTasks() {
        viewModelScope.launch {
            _state.value = _state.value.copy(reviewsLoading = true, reviewsError = null)
            runCatching { repository.getReviewTasks() }
                .onSuccess { _state.value = _state.value.copy(reviewTasks = it, reviewsLoading = false) }
                .onFailure { _state.value = _state.value.copy(reviewsLoading = false, reviewsError = it.userMessage()) }
        }
    }

    fun submitReview(id: String, answer: String) {
        viewModelScope.launch {
            runCatching { repository.submitReview(id, answer) }
                .onSuccess { loadReviewTasks() }
                .onFailure { _state.value = _state.value.copy(reviewsError = it.userMessage()) }
        }
    }

    private fun bootstrap() {
        viewModelScope.launch {
            _state.value = _state.value.copy(sessionLoading = true, sessionError = null)
            runCatching {
                repository.ensureSession()
                repository.getProfile()
            }.onSuccess {
                _state.value = _state.value.copy(sessionReady = true, sessionLoading = false, profile = it)
            }.onFailure {
                _state.value = _state.value.copy(sessionReady = false, sessionLoading = false, sessionError = it.userMessage())
            }
        }
    }

    private suspend fun refreshTask(taskId: String) {
        runCatching { repository.getTask(taskId) }
            .onSuccess { _state.value = _state.value.copy(task = it, taskLoading = !it.isTerminal(), taskError = null) }
            .onFailure { _state.value = _state.value.copy(taskLoading = false, taskError = it.userMessage()) }
    }

    private fun observeTask(taskId: String) {
        taskEventsJob = viewModelScope.launch {
            repository.observeTaskEvents(taskId)
                .catch { refreshTask(taskId) }
                .collect { refreshTask(taskId) }
        }
    }

    private suspend fun pollVerification(id: String) {
        repeat(45) {
            val details = runCatching { repository.getVerification(id) }.getOrElse {
                _state.value = _state.value.copy(verificationLoading = false, verificationError = it.userMessage())
                return
            }
            _state.value = _state.value.copy(verification = details, verificationLoading = !details.isTerminal())
            if (details.isTerminal()) return
            delay(2_000)
        }
        _state.value = _state.value.copy(verificationLoading = false, verificationError = "验真仍在处理中，请稍后重新查询")
    }

    companion object {
        fun factory(repository: EazyPathRepository): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = MainViewModel(repository) as T
        }
    }
}

private fun TaskDetails.isTerminal(): Boolean = status in setOf("completed", "failed", "cancelled")
private fun VerificationDetails.isTerminal(): Boolean = status in setOf("completed", "failed")
private fun Throwable.userMessage(): String = message?.takeIf { it.isNotBlank() } ?: "服务暂时不可用，请检查网络后重试"
