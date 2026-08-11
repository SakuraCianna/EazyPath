package com.eazypath.data.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskEventProtocolTest {
    private val taskId = "00000000-0000-4000-8000-000000000001"

    @Test
    fun acceptsOnlyMatchingNewKnownEvents() {
        val signal = TaskEventProtocol.parse(taskId, 4, "5", "card.upserted", envelope(5, "card.upserted"))
        assertEquals(5L, signal?.id)
        assertNull(TaskEventProtocol.parse(taskId, 5, "5", "card.upserted", envelope(5, "card.upserted")))
        assertNull(TaskEventProtocol.parse(taskId, 0, "5", "future.event", envelope(5, "future.event")))
        assertNull(TaskEventProtocol.parse(taskId, 0, "5", "card.upserted", envelope(6, "card.upserted")))
    }

    @Test
    fun recognizesTerminalEventsAndResetSnapshots() {
        assertTrue(TaskEventProtocol.parse(taskId, 8, "9", "task.completed", envelope(9, "task.completed"))!!.terminal)
        val reset = TaskEventProtocol.parse(taskId, 20, "12", "stream.reset", envelope(12, "stream.reset"))
        assertEquals(12L, reset?.id)
        assertEquals("stream.reset", reset?.type)
        assertNull(TaskEventProtocol.parse(taskId, 0, "1", "task.running", "{\"schema_version\":\"wrong\"}"))
    }

    @Test
    fun capsReconnectBackoff() {
        assertEquals(1_000, TaskEventProtocol.retryDelayMillis(0))
        assertEquals(30_000, TaskEventProtocol.retryDelayMillis(99))
    }

    @Test
    fun allowsOnlyOneAuthenticationRecoveryUntilStreamIsHealthy() {
        val recovery = TaskEventAuthenticationRecovery()
        assertTrue(recovery.tryStartRecovery())
        assertTrue(!recovery.tryStartRecovery())
        recovery.markStreamHealthy()
        assertTrue(recovery.tryStartRecovery())
    }

    private fun envelope(id: Long, type: String) = """
        {"event_id":$id,"task_id":"$taskId","type":"$type","schema_version":1,"data":{}}
    """.trimIndent()
}
