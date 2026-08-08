package com.eazypath.data.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class StoredSession(
    val accessToken: String,
    val refreshToken: String,
    val accessExpiresAtEpochMs: Long,
)

class SecureSessionStore(context: Context) {
    private val preferences = context.getSharedPreferences("eazypath_session", Context.MODE_PRIVATE)

    fun read(): StoredSession? {
        val accessToken = decrypt(preferences.getString(KEY_ACCESS, null) ?: return null)
        val refreshToken = decrypt(preferences.getString(KEY_REFRESH, null) ?: return null)
        val expiresAt = preferences.getLong(KEY_ACCESS_EXPIRES_AT, 0L)
        return StoredSession(accessToken, refreshToken, expiresAt)
    }

    fun write(accessToken: String, refreshToken: String, expiresInSeconds: Long) {
        preferences.edit()
            .putString(KEY_ACCESS, encrypt(accessToken))
            .putString(KEY_REFRESH, encrypt(refreshToken))
            .putLong(KEY_ACCESS_EXPIRES_AT, System.currentTimeMillis() + expiresInSeconds * 1_000L)
            .apply()
    }

    fun clear() {
        preferences.edit().clear().apply()
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply {
            init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        }
        val payload = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(payload, Base64.NO_WRAP)
    }

    private fun decrypt(value: String): String {
        val payload = Base64.decode(value, Base64.NO_WRAP)
        require(payload.size > IV_LENGTH)
        val iv = payload.copyOfRange(0, IV_LENGTH)
        val encrypted = payload.copyOfRange(IV_LENGTH, payload.size)
        val cipher = Cipher.getInstance(TRANSFORMATION).apply {
            init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
        }
        return cipher.doFinal(encrypted).toString(Charsets.UTF_8)
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            generateKey()
        }
    }

    private companion object {
        const val KEY_ALIAS = "eazypath_session_encryption_v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_LENGTH = 12
        const val KEY_ACCESS = "access_token"
        const val KEY_REFRESH = "refresh_token"
        const val KEY_ACCESS_EXPIRES_AT = "access_expires_at"
    }
}
