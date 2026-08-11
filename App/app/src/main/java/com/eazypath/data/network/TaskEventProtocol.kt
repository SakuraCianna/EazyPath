package com.eazypath.data.network

import com.google.gson.JsonParser
import java.util.concurrent.atomic.AtomicBoolean

data class TaskEventSignal(
    val id: Long,
    val type: String,
    val terminal: Boolean,
)

class TaskEventAuthenticationRecovery {
    private val used = AtomicBoolean(false)

    fun tryStartRecovery(): Boolean = used.compareAndSet(false, true)

    fun markStreamHealthy() {
        used.set(false)
    }
}

object TaskEventProtocol {
    private val knownTypes = setOf(
        "task.queued",
        "task.running",
        "task.completed",
        "task.failed",
        "task.retrying",
        "task.input_received",
        "task.requeued",
        "task.cancelled",
        "intent.parsed",
        "card.upserted",
        "stream.reset",
    )
    private val terminalTypes = setOf("task.completed", "task.failed", "task.cancelled")

    fun parse(
        expectedTaskId: String,
        lastSeenId: Long,
        eventId: String?,
        eventType: String?,
        data: String,
    ): TaskEventSignal? = runCatching {
        val type = eventType ?: return null
        if (type !in knownTypes) return null
        val payload = JsonParser.parseString(data).asJsonObject
        if (payload.get("schema_version")?.asInt != 1) return null
        if (payload.get("task_id")?.asString != expectedTaskId) return null
        if (payload.get("type")?.asString != type) return null
        val payloadId = payload.get("event_id")?.asLong ?: return null
        val sseId = eventId?.toLongOrNull()
        if (type == "stream.reset") {
            if (payloadId < 0 || (sseId != null && sseId != payloadId)) return null
            return TaskEventSignal(payloadId, type, terminal = false)
        }
        if (sseId == null || sseId <= lastSeenId || payloadId != sseId) return null
        TaskEventSignal(sseId, type, terminal = type in terminalTypes)
    }.getOrNull()

    fun retryDelayMillis(attempt: Long): Long = when {
        attempt <= 0 -> 1_000L
        attempt == 1L -> 2_000L
        attempt == 2L -> 4_000L
        attempt == 3L -> 8_000L
        attempt == 4L -> 16_000L
        else -> 30_000L
    }
}
