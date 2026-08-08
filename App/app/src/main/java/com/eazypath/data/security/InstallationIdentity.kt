package com.eazypath.data.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID

class InstallationIdentity(context: Context) {
    private val preferences = context.getSharedPreferences("eazypath_identity", Context.MODE_PRIVATE)
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    val installationGuid: String
        get() = preferences.getString(KEY_GUID, null) ?: UUID.randomUUID().toString().also {
            preferences.edit().putString(KEY_GUID, it).apply()
        }

    fun publicKeySpkiBase64(): String {
        ensureKeyPair()
        return Base64.encodeToString(keyStore.getCertificate(KEY_ALIAS).publicKey.encoded, Base64.NO_WRAP)
    }

    fun sign(payload: String): String {
        ensureKeyPair()
        val privateKey = keyStore.getKey(KEY_ALIAS, null)
        val signature = Signature.getInstance("SHA256withECDSA").apply {
            initSign(privateKey as java.security.PrivateKey)
            update(payload.toByteArray(Charsets.UTF_8))
        }
        return Base64.encodeToString(signature.sign(), Base64.NO_WRAP)
    }

    private fun ensureKeyPair() {
        if (keyStore.containsAlias(KEY_ALIAS)) return
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        generator.initialize(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
            )
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build(),
        )
        generator.generateKeyPair()
    }

    private companion object {
        const val KEY_ALIAS = "eazypath_installation_signing_v1"
        const val KEY_GUID = "installation_guid"
    }
}
