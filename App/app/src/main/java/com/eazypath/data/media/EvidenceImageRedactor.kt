package com.eazypath.data.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ImageDecoder
import android.graphics.Paint
import android.graphics.Rect
import android.net.Uri
import com.google.android.gms.tasks.Task
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import java.io.ByteArrayOutputStream
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CancellationException

data class EvidenceImageAnalysis(
    val bitmap: Bitmap,
    val suggestedRegions: List<Rect>,
    val faceCount: Int,
    val sensitiveTextCount: Int,
)

data class PreparedEvidence(
    val bytes: ByteArray,
    val mimeType: String = "image/jpeg",
    val fileName: String = "eazypath-redacted-evidence.jpg",
    val uploadDraftId: String = UUID.randomUUID().toString(),
)

object EvidenceImageRedactor {
    private const val MAX_DIMENSION = 2048

    suspend fun analyze(context: Context, uri: Uri): EvidenceImageAnalysis {
        val source = ImageDecoder.createSource(context.contentResolver, uri)
        val bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
            val longest = maxOf(info.size.width, info.size.height)
            if (longest > MAX_DIMENSION) {
                val scale = MAX_DIMENSION.toFloat() / longest
                decoder.setTargetSize((info.size.width * scale).toInt(), (info.size.height * scale).toInt())
            }
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        val image = InputImage.fromBitmap(bitmap, 0)
        val faceDetector = FaceDetection.getClient(
            FaceDetectorOptions.Builder()
                .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_ACCURATE)
                .setMinFaceSize(0.08f)
                .build(),
        )
        val textRecognizer = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
        val faceTask = faceDetector.process(image)
        val textTask = textRecognizer.process(image)
        var completed = false
        return try {
            val facesResult = faceTask.awaitCompletion()
            val textResult = textTask.awaitCompletion()
            val faces = facesResult.getOrThrow()
            val text = textResult.getOrThrow()
            val faceRegions = faces.map { expand(it.boundingBox, bitmap.width, bitmap.height, 0.18f) }
            val textRegions = text.textBlocks.flatMap { block ->
                block.lines.mapNotNull { line ->
                    val compact = line.text.replace(" ", "")
                    line.boundingBox?.takeIf { isSensitiveEvidenceText(compact) }
                }
            }.map { expand(it, bitmap.width, bitmap.height, 0.10f) }
            EvidenceImageAnalysis(
                bitmap = bitmap,
                suggestedRegions = (faceRegions + textRegions).distinctBy { listOf(it.left, it.top, it.right, it.bottom) },
                faceCount = faceRegions.size,
                sensitiveTextCount = textRegions.size,
            ).also { completed = true }
        } finally {
            faceDetector.close()
            textRecognizer.close()
            if (!completed && !bitmap.isRecycled) bitmap.recycle()
        }
    }

    fun prepare(analysis: EvidenceImageAnalysis, regions: List<Rect>): PreparedEvidence {
        val redacted = analysis.bitmap.copy(Bitmap.Config.ARGB_8888, true)
        val canvas = Canvas(redacted)
        for (region in regions) redactRegion(redacted, canvas, region)
        return try {
            val output = ByteArrayOutputStream()
            check(redacted.compress(Bitmap.CompressFormat.JPEG, 88, output)) { "脱敏图片编码失败" }
            PreparedEvidence(output.toByteArray())
        } finally {
            redacted.recycle()
        }
    }

    private fun redactRegion(bitmap: Bitmap, canvas: Canvas, input: Rect) {
        val region = Rect(
            input.left.coerceIn(0, bitmap.width - 1),
            input.top.coerceIn(0, bitmap.height - 1),
            input.right.coerceIn(1, bitmap.width),
            input.bottom.coerceIn(1, bitmap.height),
        )
        if (region.width() < 2 || region.height() < 2) return
        canvas.drawRect(region, Paint().apply { color = android.graphics.Color.BLACK })
    }

    private fun expand(rect: Rect, width: Int, height: Int, ratio: Float): Rect {
        val dx = (rect.width() * ratio).toInt()
        val dy = (rect.height() * ratio).toInt()
        return Rect(
            (rect.left - dx).coerceAtLeast(0),
            (rect.top - dy).coerceAtLeast(0),
            (rect.right + dx).coerceAtMost(width),
            (rect.bottom + dy).coerceAtMost(height),
        )
    }
}

private suspend fun <T> Task<T>.awaitCompletion(): Result<T> = suspendCoroutine { continuation ->
    addOnSuccessListener { result -> continuation.resume(Result.success(result)) }
    addOnFailureListener { error -> continuation.resume(Result.failure(error)) }
    addOnCanceledListener {
        continuation.resume(Result.failure(CancellationException("ML Kit 任务已取消")))
    }
}
