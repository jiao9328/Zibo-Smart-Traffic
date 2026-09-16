<template>
    <div></div>
</template>
<script setup>
import { onMounted, inject, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { resolvePlace } from '../tools/places'
const route = useRoute()
let map, directionControl, ready = false, planned = false, pollTimer = null

/* ---------- 起终点解析：高德精确坐标优先，绕开控件内置的 Mapbox 地名解析 ----------
 * 坑：导航控件内置的是 Mapbox Geocoder，对中国地名覆盖很差——
 * 实测「山东理工大学」只解析到省级（坐标落在 100km 外）、
 * 「淄博市人民政府」解析成「淄博市」市中心，画出来的路线完全不对。
 * 故先拿高德精确坐标（失败回退本地路网/POI 表），再把坐标数组 [lng,lat]
 * 直接喂 setOrigin/setDestination——控件只认 字符串 或 坐标数组 两种入参，
 * 字符串仍会走 Mapbox 解析，坐标数组则完全绕开地名解析、定位精确。 */
const amapGeo = async (place) => {
    if (!place || !import.meta.env.VITE_AMAP_KEY) return null
    // 省/外市/自治州不加 city 约束；区县与本地 POI 一律限定淄博，避免同名异地（如别处"人民公园"）
    const scope = /(^|[^淄博])(省|市|州)$/.test(place) || place.includes('自治区') ? '' : '淄博'
    try {
        const r = await fetch(`https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(place)}&key=${import.meta.env.VITE_AMAP_KEY}${scope ? '&city=' + scope : ''}`)
        const d = await r.json()
        const g = d && d.geocodes && d.geocodes[0]
        if (g && g.location) return g.location.split(',').map(Number)
    } catch (e) { /* 断网等：走本地/原文兜底 */ }
    return null
}
// 精确坐标解析：高德 → 本地路网/POI 表；都没有才返回 null（让原文走控件内 Mapbox 解析碰运气）
const resolveCenter = async (place) => {
    const k = String(place).trim()
    if (!k) return null
    let center = await amapGeo(k)
    if (!center) center = resolvePlace(k)?.center || null
    return center
}
// 坐标喂给控件后，输入框会被回显成 "118.001,36.813" 这样的数字串。
// 控件内部解析中文地名不可靠（见上），故等数字回显后把输入框文本换回中文地名，仅动 DOM 不动控件状态
const renameInputsTo = (from, to) => {
    const isCoordText = (v) => /^-?[\d.]+,-?[\d.]+$/.test(v || '')
    const apply = () => {
        try {
            const ins = [...document.querySelectorAll('.mapboxgl-ctrl-directions .mapboxgl-ctrl-geocoder input')]
            if (ins.length >= 2) {
                if (isCoordText(ins[0].value)) ins[0].value = from
                if (isCoordText(ins[1].value)) ins[1].value = to
            }
        } catch (e) { /* 控件尚未渲染等 */ }
    }
    apply()
    setTimeout(apply, 400)
    setTimeout(apply, 1500)
}

// 由路由 query 规划路线：起终点解析成精确坐标后填入导航控件，随后控件自动画线并缩放至整条线路
// （与手动在导航面板输入起终点同一套流程，只是地名换成高德精确坐标，避免 Mapbox 中文地名解析错位）
const plan = async () => {
    const to = String(route.query.to || '').trim()
    if (!to || !directionControl || !ready) return
    const from = String(route.query.from || '淄博站').trim()
    try {
        const [fc, dc] = await Promise.all([resolveCenter(from), resolveCenter(to)])
        if (fc) directionControl.setOrigin(fc) // [lng,lat] 数组：控件只认 字符串 或 坐标数组
        if (dc) directionControl.setDestination(dc)
        if (fc && dc) renameInputsTo(from, to) // 把输入框数字回显换回中文地名
    } catch (e) { /* 解析/设置失败不阻塞（控件保持手输状态） */ }
}

// 地图就绪且插件 directions 数据源已建好后才允许规划：
// 路线请求若早于数据源创建，插件会静默跳过画线（source 永远为空）
const styleLoaded = () => !!map && !!map.loaded && map.loaded()
const sourceReady = () => styleLoaded() && !!map.getSource && !!map.getSource('directions')
const mapSettled = sourceReady
const tryPlan = () => {
    if (planned || !sourceReady()) return
    // style 慢加载（十几秒+）时轮询不能设上限：首次规划成功才停，
    // 否则路线会因超时放弃而永远画不出来
    ready = true
    planned = true
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    plan()
}

onMounted(() => {
    map = inject("$scene_map").map
    // 控件必须在 style 加载完成后才实例化：插件靠一次性 load 事件建数据源，
    // 若在 style 加载中（或换风格后 load 已发过）挂载，source 永不创建、路线永远画不出来
    const ensureCtrl = () => {
        if (directionControl || !styleLoaded()) return
        directionControl = new MapboxDirections({
            accessToken: import.meta.env.VITE_MAPBOX_TOKEN,
            // 导航指令用中文；geocoder 命名空间会原样拼进地理编码请求参数，
            // 让起终点解析结果显示中文地名（否则默认英文 "Boshan Qu, Zibo Shi, ..."）
            language: 'zh-Hans',
            unit: 'metric',
            geocoder: {
                language: 'zh-Hans',
                country: 'cn',
                proximity: [118.05, 36.81]
            }
        })
        map.addControl(directionControl)
    }
    // 低频常驻轮询：等 style 就绪 → 建控件 → 首次规划成功即停
    // （慢网/换风格/晚挂载都兜得住）
    pollTimer = setInterval(() => { ensureCtrl(); tryPlan() }, 300)
})
// 同路由下 query 变化（AI 换起终点）再规划一次
watch(() => [route.query.from, route.query.to], () => { if (mapSettled()) plan() })

onUnmounted(() => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    if (directionControl && map) {
        map.removeControl(directionControl)
        map.off('load', tryPlan)
    }
})
</script>
<style>
</style>
