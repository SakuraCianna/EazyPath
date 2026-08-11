package com.eazypath.ui.viewmodels

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskStreamStatePolicyTest {
    @Test
    fun successfulNonTerminalSnapshotKeepsAStableStreamError() {
        assertTrue(shouldShowTaskStreamStoppedError(refreshSucceeded = true, taskIsTerminal = false))
    }

    @Test
    fun terminalOrFailedSnapshotDoesNotOverwriteItsOwnState() {
        assertFalse(shouldShowTaskStreamStoppedError(refreshSucceeded = true, taskIsTerminal = true))
        assertFalse(shouldShowTaskStreamStoppedError(refreshSucceeded = false, taskIsTerminal = false))
    }
}
