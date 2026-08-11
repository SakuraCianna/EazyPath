package com.eazypath.data.network

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MapApiContractTest {
    private val gson = Gson()

    @Test
    fun `地点搜索合同包含真实坐标和证据摘要`() {
        val json = """
            {
              "id":"00000000-0000-4000-8000-000000000001",
              "name":"南昌站",
              "address":"江西省南昌市",
              "category_code":"150200",
              "longitude":115.918,
              "latitude":28.662,
              "accessibility":{"status":"evidence_available","verified_feature_count":2}
            }
        """.trimIndent()
        val place = gson.fromJson(json, PlaceSearchItem::class.java)
        assertEquals("南昌站", place.name)
        assertEquals(115.918, place.longitude, 0.000001)
        assertEquals(2, place.accessibility.verifiedFeatureCount)
    }

    @Test
    fun `地点详情只消费公开投影和审核证据`() {
        val json = """
            {
              "place":{"id":"p1","name":"江西省博物馆","address":"赣江北大道","category_code":"140100","longitude":115.85,"latitude":28.70,"external_source":"amap","status":"active"},
              "canonical_place_id":"p1",
              "requested_place_id":"p1",
              "units":[],
              "facilities":[],
              "evidence_timeline":[{"id":"o1","feature_key":"step_free_entrance","display_name":"无台阶入口","value":true,"source":"community","grade":"B","moderation_status":"approved","freshness_status":"fresh","observed_at":"2026-08-01T00:00:00.000Z","expires_at":null,"created_at":"2026-08-01T00:00:00.000Z"}],
              "evidence_timeline_has_more":false
            }
        """.trimIndent()
        val details = gson.fromJson(json, PlaceDetails::class.java)
        assertEquals("江西省博物馆", details.place.name)
        assertEquals("step_free_entrance", details.evidenceTimeline.single().featureKey)
        assertTrue(details.evidenceTimeline.single().value.asBoolean)
        assertFalse(details.evidenceTimelineHasMore)
    }

    @Test
    fun `跳转动作合同保留 app web copy 兜底顺序`() {
        val json = """{"actions":[{"type":"app_uri","label":"高德","platform":"amap","url":"amapuri://route/plan"},{"type":"web","label":"网页","platform":"amap","url":"https://uri.amap.com/navigation"},{"type":"clipboard","label":"复制","platform":null,"content":"目的地"}]}"""
        val type = object : TypeToken<LinkActionsData>() {}.type
        val data: LinkActionsData = gson.fromJson(json, type)
        assertEquals(listOf("app_uri", "web", "clipboard"), data.actions.map { it.type })
    }
}
