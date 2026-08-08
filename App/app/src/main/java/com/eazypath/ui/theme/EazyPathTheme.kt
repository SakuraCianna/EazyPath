package com.eazypath.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val EazyPathColors = lightColorScheme(
    primary = Color(0xFF075DD8),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD9E6FF),
    onPrimaryContainer = Color(0xFF001B3F),
    secondary = Color(0xFF007C78),
    secondaryContainer = Color(0xFFB7F2EE),
    error = Color(0xFFBA1A1A),
    errorContainer = Color(0xFFFFDAD6),
    background = Color(0xFFF8F9FF),
    surface = Color(0xFFF8F9FF),
    surfaceVariant = Color(0xFFE9EBF4),
)

@Composable
fun EazyPathTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = EazyPathColors,
        content = content,
    )
}
