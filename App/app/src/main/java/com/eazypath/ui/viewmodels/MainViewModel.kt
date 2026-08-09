package com.eazypath.ui.viewmodels

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Rect
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.eazypath.data.EazyPathRepository
import com.eazypath.data.ApiException
import com.eazypath.data.media.EvidenceImageAnalysis
import com.eazypath.data.media.PreparedEvidence
import com.eazypath.data.network.FeatureDefinition
import com.eazypath.data.network.InteractionProfile
import com.eazypath.data.network.LocationProofData
import com.eazypath.data.network.MobilityProfile
import com.eazypath.data.network.PlaceSearchItem
import com.eazypath.data.network.ProfileData
import com.eazypath.data.network.ReviewTask
import com.eazypath.data.network.ReviewSubmissionData
import com.eazypath.data.network.TaskDetails
import com.eazypath.data.network.VerificationDetails
import com.google.gson.JsonElement
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

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
    val reviewsLoadingMore: Boolean = false,
    val reviewTasksNextCursor: String? = null,
    val reviewsError: String? = null,
    val reviewDraftTaskId: String? = null,
    val reviewLocationProof: LocationProofData? = null,
    val reviewLocationLoadingTaskId: String? = null,
    val reviewSubmittingTaskId: String? = null,
    val reviewNotice: String? = null,
    val reviewSubmission: ReviewSubmissionData? = null,
    val reviewPendingSubmissionId: String? = null,
    val reviewSubmissionVersion: Int = 0,
    val placeResults: List<PlaceSearchItem> = emptyList(),
    val evidenceFeatureDefinitions: List<FeatureDefinition> = emptyList(),
    val evidenceFeaturesLoading: Boolean = false,
    val placeSearchLoading: Boolean = false,
    val evidenceAnalysis: EvidenceImageAnalysis? = null,
    val evidenceAnalysisVersion: Int = 0,
    val evidencePreview: Bitmap? = null,
    val preparedEvidence: PreparedEvidence? = null,
    val evidenceImageLoading: Boolean = false,
    val evidenceSubmitting: Boolean = false,
    val evidenceError: String? = null,
    val evidenceNotice: String? = null,
    val evidenceSubmissionVersion: Int = 0,
)

class MainViewModel(private val repository: EazyPathRepository) : ViewModel() {
    private val _state = MutableStateFlow(MainUiState())
    val state: StateFlow<MainUiState> = _state.asStateFlow()
    private var taskEventsJob: Job? = null
    private var placeSearchJob: Job? = null
    private var reviewLocationJob: Job? = null
    private var reviewSubmitJob: Job? = null
    private var evidenceImageJob: Job? = null
    private var evidenceSubmitJob: Job? = null
    private var evidenceImageGeneration: Long = 0
    private var evidenceSubmitGeneration: Long = 0
    private var reviewGeneration: Long = 0
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

    fun loadReviewTasks(loadMore: Boolean = false) {
        if (loadMore && (_state.value.reviewsLoadingMore || _state.value.reviewTasksNextCursor == null)) return
        if (!loadMore && _state.value.reviewsLoading) return
        viewModelScope.launch {
            _state.value = _state.value.copy(
                reviewsLoading = !loadMore,
                reviewsLoadingMore = loadMore,
                reviewsError = null,
            )
            val cursor = if (loadMore) _state.value.reviewTasksNextCursor else null
            runCatching { repository.getReviewTasks(cursor) }
                .onSuccess { page ->
                    val tasks = if (loadMore) (_state.value.reviewTasks + page.items).distinctBy { it.id } else page.items
                    _state.value = _state.value.copy(
                        reviewTasks = tasks,
                        reviewTasksNextCursor = page.nextCursor,
                        reviewsLoading = false,
                        reviewsLoadingMore = false,
                    )
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        reviewsLoading = false,
                        reviewsLoadingMore = false,
                        reviewsError = it.userMessage(),
                    )
                }
        }
    }

    fun beginReviewTask(taskId: String) {
        if (_state.value.reviewDraftTaskId == taskId) return
        reviewGeneration += 1
        reviewLocationJob?.cancel()
        reviewSubmitJob?.cancel()
        clearEvidenceDraft(clearPlaceResults = false)
        _state.value = _state.value.copy(
            reviewDraftTaskId = taskId,
            reviewLocationProof = null,
            reviewLocationLoadingTaskId = null,
            reviewSubmittingTaskId = null,
            reviewNotice = null,
            reviewSubmission = null,
            reviewPendingSubmissionId = null,
            reviewsError = null,
        )
    }

    fun verifyReviewLocation(taskId: String, placeId: String) {
        if (_state.value.reviewSubmittingTaskId != null) return
        beginReviewTask(taskId)
        val generation = ++reviewGeneration
        reviewLocationJob?.cancel()
        reviewLocationJob = viewModelScope.launch {
            _state.value = _state.value.copy(
                reviewLocationLoadingTaskId = taskId,
                reviewLocationProof = null,
                reviewsError = null,
                reviewNotice = null,
            )
            try {
                val proof = repository.verifyReviewLocation(taskId, placeId)
                if (generation == reviewGeneration && _state.value.reviewDraftTaskId == taskId) {
                    _state.value = _state.value.copy(reviewLocationProof = proof, reviewLocationLoadingTaskId = null)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                if (generation == reviewGeneration && _state.value.reviewDraftTaskId == taskId) {
                    _state.value = _state.value.copy(reviewLocationLoadingTaskId = null, reviewsError = error.userMessage())
                }
            }
        }
    }

    fun clearReviewLocationProof() {
        reviewGeneration += 1
        reviewLocationJob?.cancel()
        _state.value = _state.value.copy(reviewLocationProof = null, reviewLocationLoadingTaskId = null)
    }

    fun submitReview(id: String, answer: String, includeImage: Boolean) {
        if (reviewSubmitJob?.isActive == true || answer !in setOf("present", "absent", "unknown")) return
        if (_state.value.reviewDraftTaskId != id) beginReviewTask(id)
        val generation = ++reviewGeneration
        val submissionId = _state.value.reviewPendingSubmissionId ?: UUID.randomUUID().toString()
        _state.value = _state.value.copy(reviewPendingSubmissionId = submissionId)
        reviewSubmitJob = viewModelScope.launch {
            _state.value = _state.value.copy(reviewSubmittingTaskId = id, reviewsError = null, reviewNotice = null)
            try {
                val evidence = if (includeImage) {
                    _state.value.preparedEvidence ?: error("请先生成并确认最终脱敏预览")
                } else {
                    null
                }
                val proofId = _state.value.reviewLocationProof
                    ?.takeIf { it.reviewTaskId == id }
                    ?.proofId
                val result = repository.submitReview(id, submissionId, answer, proofId, evidence)
                if (generation != reviewGeneration || _state.value.reviewDraftTaskId != id) return@launch
                completeReviewSubmission(result)
                runCatching { repository.getReviewTasks() }.onSuccess { refreshedPage ->
                    if (generation == reviewGeneration) {
                        _state.value = _state.value.copy(
                            reviewTasks = refreshedPage.items,
                            reviewTasksNextCursor = refreshedPage.nextCursor,
                        )
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                if (generation == reviewGeneration && _state.value.reviewDraftTaskId == id) {
                    val recovered = if (error is ApiException) null else {
                        runCatching { repository.getMyReviewSubmission(id, submissionId) }.getOrNull()
                    }
                    if (recovered != null && generation == reviewGeneration) {
                        completeReviewSubmission(recovered)
                    } else {
                        _state.value = _state.value.copy(
                            reviewLocationProof = if (error is ApiException) null else _state.value.reviewLocationProof,
                            reviewLocationLoadingTaskId = null,
                            reviewSubmittingTaskId = null,
                            reviewPendingSubmissionId = if (error is ApiException) null else submissionId,
                            reviewsError = if (error is ApiException) error.userMessage() else {
                                "提交结果未能确认：${error.userMessage()}。请保持在此页面并重试，系统会复用同一提交编号。"
                            },
                        )
                    }
                }
            }
        }
    }

    fun discardReviewDraft() {
        reviewGeneration += 1
        reviewLocationJob?.cancel()
        reviewSubmitJob?.cancel()
        clearEvidenceDraft(clearPlaceResults = false)
        _state.value = _state.value.copy(
            reviewDraftTaskId = null,
            reviewLocationProof = null,
            reviewLocationLoadingTaskId = null,
            reviewSubmittingTaskId = null,
            reviewNotice = null,
            reviewSubmission = null,
            reviewPendingSubmissionId = null,
            reviewsError = null,
        )
    }

    fun abandonReviewConfirmation() {
        reviewGeneration += 1
        reviewLocationJob?.cancel()
        reviewSubmitJob?.cancel()
        clearEvidenceDraft(clearPlaceResults = false)
        _state.value = _state.value.copy(
            reviewDraftTaskId = null,
            reviewLocationProof = null,
            reviewLocationLoadingTaskId = null,
            reviewSubmittingTaskId = null,
            reviewPendingSubmissionId = null,
            reviewSubmission = null,
            reviewsError = null,
            reviewNotice = "已停止本地确认。先前复核可能已被服务端记录；任务列表已刷新，请不要据此重复提交不同答案。",
        )
        loadReviewTasks()
    }

    private fun completeReviewSubmission(result: ReviewSubmissionData) {
        releaseEvidenceImages()
        _state.value = _state.value.copy(
            reviewDraftTaskId = null,
            reviewLocationProof = null,
            reviewLocationLoadingTaskId = null,
            reviewSubmittingTaskId = null,
            reviewSubmission = result,
            reviewPendingSubmissionId = null,
            reviewNotice = "复核已记录，本票权重为 ${result.voteWeight}。社区结论会在满足人数和证据门槛后更新。",
            reviewSubmissionVersion = _state.value.reviewSubmissionVersion + 1,
        )
    }

    fun searchEvidencePlaces(query: String) {
        if (query.isBlank()) return
        placeSearchJob?.cancel()
        placeSearchJob = viewModelScope.launch {
            _state.value = _state.value.copy(placeSearchLoading = true, evidenceError = null, evidenceNotice = null)
            try {
                val places = repository.searchPlaces(query)
                _state.value = _state.value.copy(placeResults = places, placeSearchLoading = false)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                _state.value = _state.value.copy(placeSearchLoading = false, evidenceError = error.userMessage())
            }
        }
    }

    fun loadEvidenceFeatureDefinitions() {
        if (_state.value.evidenceFeatureDefinitions.isNotEmpty() || _state.value.evidenceFeaturesLoading) return
        viewModelScope.launch {
            _state.value = _state.value.copy(evidenceFeaturesLoading = true, evidenceError = null)
            runCatching { repository.getEvidenceFeatureDefinitions() }
                .onSuccess { definitions ->
                    _state.value = _state.value.copy(
                        evidenceFeatureDefinitions = definitions,
                        evidenceFeaturesLoading = false,
                    )
                }
                .onFailure { error ->
                    _state.value = _state.value.copy(evidenceFeaturesLoading = false, evidenceError = error.userMessage())
                }
        }
    }

    fun analyzeEvidenceImage(uri: Uri) {
        val previousJob = evidenceImageJob
        val generation = ++evidenceImageGeneration
        previousJob?.cancel()
        evidenceImageJob = viewModelScope.launch(Dispatchers.Default) {
            previousJob?.cancelAndJoin()
            if (generation != evidenceImageGeneration) return@launch
            val shouldAnalyze = withContext(Dispatchers.Main.immediate) {
                if (generation != evidenceImageGeneration) false else {
                    releaseEvidenceImages()
                    _state.value = _state.value.copy(evidenceImageLoading = true, evidenceError = null, evidenceNotice = null)
                    true
                }
            }
            if (!shouldAnalyze) return@launch
            var unpublishedAnalysis: EvidenceImageAnalysis? = null
            try {
                val analysis = repository.analyzeEvidenceImage(uri)
                unpublishedAnalysis = analysis
                if (generation != evidenceImageGeneration) {
                    analysis.bitmap.recycle()
                    unpublishedAnalysis = null
                    return@launch
                }
                withContext(Dispatchers.Main.immediate) {
                    if (generation != evidenceImageGeneration) {
                        analysis.bitmap.recycle()
                        unpublishedAnalysis = null
                        return@withContext
                    }
                    _state.value = _state.value.copy(
                        evidenceAnalysis = analysis,
                        evidenceAnalysisVersion = _state.value.evidenceAnalysisVersion + 1,
                        evidenceImageLoading = false,
                    )
                    unpublishedAnalysis = null
                }
            } catch (error: CancellationException) {
                unpublishedAnalysis?.bitmap?.takeUnless { it.isRecycled }?.recycle()
                throw error
            } catch (error: Throwable) {
                unpublishedAnalysis?.bitmap?.takeUnless { it.isRecycled }?.recycle()
                if (generation == evidenceImageGeneration) {
                    withContext(Dispatchers.Main.immediate) {
                        if (generation == evidenceImageGeneration) {
                            _state.value = _state.value.copy(evidenceImageLoading = false, evidenceError = error.userMessage())
                        }
                    }
                }
            }
        }
    }

    fun prepareEvidencePreview(redactionRegions: List<Rect>) {
        val analysis = _state.value.evidenceAnalysis ?: return
        val previousJob = evidenceImageJob
        previousJob?.cancel()
        clearEvidencePreview()
        val generation = ++evidenceImageGeneration
        evidenceImageJob = viewModelScope.launch(Dispatchers.Default) {
            previousJob?.cancelAndJoin()
            if (generation != evidenceImageGeneration) return@launch
            val shouldPrepare = withContext(Dispatchers.Main.immediate) {
                if (generation == evidenceImageGeneration) {
                    _state.value = _state.value.copy(evidenceImageLoading = true, evidenceError = null)
                    true
                } else {
                    false
                }
            }
            if (!shouldPrepare) return@launch
            var unpublishedPreview: Bitmap? = null
            try {
                val prepared = repository.prepareEvidence(analysis, redactionRegions)
                val preview = BitmapFactory.decodeByteArray(prepared.bytes, 0, prepared.bytes.size)
                    ?: error("无法生成脱敏预览")
                unpublishedPreview = preview
                if (generation != evidenceImageGeneration) {
                    preview.recycle()
                    unpublishedPreview = null
                    return@launch
                }
                withContext(Dispatchers.Main.immediate) {
                    if (generation == evidenceImageGeneration) {
                        _state.value = _state.value.copy(preparedEvidence = prepared, evidencePreview = preview, evidenceImageLoading = false)
                        unpublishedPreview = null
                    }
                }
                unpublishedPreview?.takeUnless { it.isRecycled }?.recycle()
                unpublishedPreview = null
            } catch (error: CancellationException) {
                unpublishedPreview?.takeUnless { it.isRecycled }?.recycle()
                throw error
            } catch (error: Throwable) {
                unpublishedPreview?.takeUnless { it.isRecycled }?.recycle()
                if (generation == evidenceImageGeneration) {
                    withContext(Dispatchers.Main.immediate) {
                        if (generation == evidenceImageGeneration) {
                            _state.value = _state.value.copy(evidenceImageLoading = false, evidenceError = error.userMessage())
                        }
                    }
                }
            }
        }
    }

    fun clearEvidencePreview() {
        evidenceImageGeneration += 1
        evidenceImageJob?.cancel()
        _state.value = _state.value.copy(
            evidencePreview = null,
            preparedEvidence = null,
            evidenceImageLoading = false,
        )
    }

    fun submitObservation(
        placeId: String,
        featureKey: String,
        value: JsonElement,
        includeImage: Boolean,
    ) {
        if (evidenceSubmitJob?.isActive == true) return
        val submitGeneration = ++evidenceSubmitGeneration
        evidenceSubmitJob = viewModelScope.launch {
            _state.value = _state.value.copy(evidenceSubmitting = true, evidenceError = null, evidenceNotice = null)
            runCatching {
                val evidence = if (includeImage) _state.value.preparedEvidence ?: error("请先生成并确认最终脱敏预览") else null
                repository.submitObservation(placeId, featureKey, value, evidence)
            }.onSuccess {
                if (submitGeneration != evidenceSubmitGeneration) return@onSuccess
                releaseEvidenceImages()
                _state.value = _state.value.copy(
                    evidenceSubmitting = false,
                    evidenceAnalysis = null,
                    evidencePreview = null,
                    preparedEvidence = null,
                    placeResults = emptyList(),
                    evidenceNotice = "现场信息已提交，当前状态为待审核，不会立即作为无障碍结论展示。",
                    evidenceSubmissionVersion = _state.value.evidenceSubmissionVersion + 1,
                )
            }.onFailure {
                if (submitGeneration == evidenceSubmitGeneration) {
                    _state.value = _state.value.copy(evidenceSubmitting = false, evidenceError = it.userMessage())
                }
            }
        }
    }

    private fun releaseEvidenceImages() {
        _state.value = _state.value.copy(evidenceAnalysis = null, evidencePreview = null, preparedEvidence = null)
    }

    fun removeEvidenceImage() {
        clearEvidenceDraft(clearPlaceResults = false)
    }

    fun discardEvidenceDraft() {
        clearEvidenceDraft(clearPlaceResults = true)
    }

    private fun clearEvidenceDraft(clearPlaceResults: Boolean) {
        val imageJob = evidenceImageJob
        val submitJob = evidenceSubmitJob
        evidenceImageGeneration += 1
        evidenceSubmitGeneration += 1
        imageJob?.cancel()
        submitJob?.cancel()
        if (clearPlaceResults) placeSearchJob?.cancel()
        _state.value = _state.value.copy(
            placeResults = if (clearPlaceResults) emptyList() else _state.value.placeResults,
            evidenceAnalysis = null,
            evidencePreview = null,
            preparedEvidence = null,
            evidenceImageLoading = false,
            evidenceSubmitting = false,
            placeSearchLoading = false,
            evidenceError = null,
            evidenceNotice = null,
        )
        viewModelScope.launch {
            imageJob?.cancelAndJoin()
            submitJob?.cancelAndJoin()
        }
    }

    override fun onCleared() {
        reviewGeneration += 1
        reviewLocationJob?.cancel()
        reviewSubmitJob?.cancel()
        evidenceImageGeneration += 1
        evidenceSubmitGeneration += 1
        evidenceImageJob?.cancel()
        evidenceSubmitJob?.cancel()
        placeSearchJob?.cancel()
        super.onCleared()
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
