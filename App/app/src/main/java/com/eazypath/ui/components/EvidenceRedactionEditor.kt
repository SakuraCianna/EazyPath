package com.eazypath.ui.components

import android.graphics.Rect
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.eazypath.data.media.EvidenceImageAnalysis
import kotlin.math.max
import kotlin.math.min

@Composable
fun EvidenceRedactionEditor(
    analysis: EvidenceImageAnalysis,
    regions: List<Rect>,
    enabled: Boolean = true,
    onRegionAdded: (Rect) -> Unit,
) {
    var canvasSize by remember { mutableStateOf(IntSize.Zero) }
    var dragStart by remember { mutableStateOf<Offset?>(null) }
    var activeRect by remember { mutableStateOf<Rect?>(null) }
    val bitmap = analysis.bitmap
    Canvas(
        Modifier.fillMaxWidth().height(300.dp)
            .semantics { contentDescription = "脱敏区域编辑器，黑色区域会被实色遮挡，可在图片上拖动补充遮挡框" }
            .onSizeChanged { canvasSize = it }
            .pointerInput(analysis, enabled) {
                if (enabled) detectDragGestures(
                    onDragStart = { offset -> dragStart = canvasToBitmap(offset, canvasSize, bitmap.width, bitmap.height) },
                    onDrag = { change, _ ->
                        val start = dragStart ?: return@detectDragGestures
                        val end = canvasToBitmap(change.position, canvasSize, bitmap.width, bitmap.height)
                        activeRect = Rect(
                            min(start.x, end.x).toInt(),
                            min(start.y, end.y).toInt(),
                            max(start.x, end.x).toInt(),
                            max(start.y, end.y).toInt(),
                        )
                    },
                    onDragEnd = {
                        activeRect?.takeIf { it.width() >= 12 && it.height() >= 12 }?.let { onRegionAdded(Rect(it)) }
                        activeRect = null
                        dragStart = null
                    },
                    onDragCancel = {
                        activeRect = null
                        dragStart = null
                    },
                )
            },
    ) {
        val transform = fitTransform(canvasSize, bitmap.width, bitmap.height)
        drawImage(
            bitmap.asImageBitmap(),
            dstOffset = IntOffset(transform.offsetX.toInt(), transform.offsetY.toInt()),
            dstSize = IntSize((bitmap.width * transform.scale).toInt(), (bitmap.height * transform.scale).toInt()),
        )
        (regions + listOfNotNull(activeRect)).forEach { rect ->
            drawRect(
                color = Color.Black.copy(alpha = 0.82f),
                topLeft = Offset(
                    transform.offsetX + rect.left * transform.scale,
                    transform.offsetY + rect.top * transform.scale,
                ),
                size = androidx.compose.ui.geometry.Size(rect.width() * transform.scale, rect.height() * transform.scale),
            )
        }
    }
}

private data class ImageTransform(val scale: Float, val offsetX: Float, val offsetY: Float)

private fun fitTransform(canvas: IntSize, bitmapWidth: Int, bitmapHeight: Int): ImageTransform {
    if (canvas.width == 0 || canvas.height == 0) return ImageTransform(1f, 0f, 0f)
    val scale = min(canvas.width.toFloat() / bitmapWidth, canvas.height.toFloat() / bitmapHeight)
    return ImageTransform(scale, (canvas.width - bitmapWidth * scale) / 2f, (canvas.height - bitmapHeight * scale) / 2f)
}

private fun canvasToBitmap(offset: Offset, canvas: IntSize, bitmapWidth: Int, bitmapHeight: Int): Offset {
    val transform = fitTransform(canvas, bitmapWidth, bitmapHeight)
    return Offset(
        ((offset.x - transform.offsetX) / transform.scale).coerceIn(0f, bitmapWidth.toFloat()),
        ((offset.y - transform.offsetY) / transform.scale).coerceIn(0f, bitmapHeight.toFloat()),
    )
}
