package com.eazypath.data.network

import com.eazypath.BuildConfig
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

class NetworkClient(accessToken: () -> String?) {
    private val baseClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(45, TimeUnit.SECONDS)
        .apply {
            if (BuildConfig.DEBUG) {
                addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
            }
        }
        .build()

    private val authenticatedClient = baseClient.newBuilder()
        .addInterceptor { chain ->
            val token = accessToken()
            val request = if (token.isNullOrBlank()) chain.request() else {
                chain.request().newBuilder().header("Authorization", "Bearer $token").build()
            }
            chain.proceed(request)
        }
        .build()

    val publicApi: EazyPathApiService = retrofit(baseClient).create(EazyPathApiService::class.java)
    val authenticatedApi: EazyPathApiService = retrofit(authenticatedClient).create(EazyPathApiService::class.java)
    val eventClient: OkHttpClient get() = authenticatedClient

    private fun retrofit(client: OkHttpClient): Retrofit = Retrofit.Builder()
        .baseUrl(BuildConfig.API_BASE_URL.ensureTrailingSlash())
        .client(client)
        .addConverterFactory(GsonConverterFactory.create())
        .build()

    private fun String.ensureTrailingSlash(): String = if (endsWith('/')) this else "$this/"
}
