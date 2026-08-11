package com.eazypath.data

import java.io.IOException
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

class TaskSnapshotRetryPolicyTest {
    @Test
    fun retriesNetworkRateLimitAndServerFailures() {
        assertTrue(isRetryableTaskSnapshotError(IOException("offline")))
        assertTrue(isRetryableTaskSnapshotError(httpError(429)))
        assertTrue(isRetryableTaskSnapshotError(httpError(503)))
    }

    @Test
    fun stopsOnPermanentClientAndProtocolFailures() {
        assertFalse(isRetryableTaskSnapshotError(httpError(401)))
        assertFalse(isRetryableTaskSnapshotError(httpError(404)))
        assertFalse(isRetryableTaskSnapshotError(ApiException("TASK_NOT_FOUND", "任务不存在")))
    }

    private fun httpError(status: Int): HttpException = HttpException(
        Response.error<Any>(status, "error".toResponseBody()),
    )
}
