
<style scoped>
.areaSearch {
    width: 100vw;
    position: fixed;
    top: calc(var(--header-h) + 20px);
}

/* 搜索条：原为 rgb(76,158,255) 实心蓝 + 白色输入框，是全站唯一一处「饱和蓝底」，
 * 与白卡片体系冲突，改为白卡片 + 主色按钮。 */
.headerAS {
    background: var(--bg-panel);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    width: 26vw;
    height: 50px;
    padding: 0 6px 0 10px;
    margin: 3px;
    position: absolute;
    top: 0;
    /* 原来 left 缺省=0，整条搜索框压在实时数据栏下（输入框中心命中 .rt-panel，点不进去）。
     * 让到栏右侧：--rt-clear 见 main.css，栏宽改了这里自动跟着走。 */
    left: var(--rt-clear);
    z-index: var(--z-panel);
    display: flex;
    justify-content: space-around;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    border-radius: var(--radius-lg);
}

.headerAS_select {
    width: 22%;
    height: 34px;
    line-height: 34px;
    color: #fff;
    background: var(--primary);
    border-radius: var(--radius);
    text-align: center;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 1px;
    cursor: pointer;
    transition: background-color 0.2s;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* 鼠标悬浮时的效果 */
.headerAS_select:hover {
    background: var(--primary-hover);
}

/* 按下去的感觉 */
.headerAS_select:active {
    background: var(--primary);
}

/* 修改链接样式 */
.headerAS_select a {
    text-decoration: none;
    color: inherit;
}

.headerAS_div_i {
    flex: 1;
    height: 34px;
    box-sizing: border-box;
    background: var(--bg-sub);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    transition: border-color 0.15s;
}

.headerAS_div_i:focus-within {
    border-color: var(--primary);
    background: var(--bg-panel);
}

.headerAS_div_i .icon {
    flex: none;
    width: 15px;
    height: 15px;
}

/* svg 里写死了 fill="#8a8a8a"，只能从上层压 */
.headerAS_div_i .icon path {
    fill: var(--text-mute);
}

.headerAS_div_input {
    flex: 1;
    width: 100%;
    height: 100%;
    border: none;
    outline: none;
    background: transparent;
    font-size: 13px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
}

.headerAS_div_input::placeholder {
    color: var(--text-mute);
}

/* 天气卡片 */
.weatherCondition {
    width: 15vw;
    border-radius: var(--radius-lg);
    overflow: hidden;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    position: absolute;
    right: 5px;
    top: 25px;
    z-index: var(--z-panel);
}

/* 设置表格样式 */
.weatherTable {
    border-collapse: collapse;
    width: 100%;
}

/* 设置表格行样式 */
.weatherRow {
    border-bottom: 1px solid var(--border);
}
.weatherRow:last-child {
    border-bottom: none;
}

/* 设置表格数据样式 */
.weatherData {
    padding: 8px;
    text-align: center;
    font-size: 12px;
    color: var(--text-sub);
}

.c1 {
    width: 50%;
    color: var(--text-mute);
    border-right: 1px solid var(--border);
}

.c2 {
    width: 50%;
    color: var(--text);
    font-weight: 600;
}
</style>
<template>
    <div class="areaSearch">
        <div class="headerAS">
            <div class="headerAS_select" @click="goToCityPage">CITY</div>
            <div class="headerAS_div_i">
                <svg t="1706109836956" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg"
                    p-id="6986" width="20%" height="80%">
                    <path
                        d="M417.05 770.27c-94.33 0-183.01-36.73-249.7-103.43-137.69-137.68-137.69-361.72 0-499.4C234.05 100.74 322.73 64 417.05 64s183 36.74 249.7 103.43c137.69 137.68 137.69 361.72 0 499.4-66.69 66.71-155.37 103.44-249.7 103.44z m0-642.06c-77.18 0-149.73 30.06-204.3 84.62-112.65 112.66-112.65 295.95 0 408.61 54.57 54.57 127.13 84.62 204.3 84.62 77.17 0 149.73-30.05 204.3-84.62C734 508.78 734 325.49 621.35 212.83c-54.57-54.57-127.13-84.62-204.3-84.62z"
                        fill="#8a8a8a" p-id="6987"></path>
                    <path
                        d="M905.1 960c-8.51 0-16.68-3.39-22.7-9.41L610 678.18c-12.54-12.53-12.54-32.86 0-45.4l22.7-22.7c12.52-12.54 32.86-12.54 45.4 0l272.41 272.4c12.54 12.54 12.54 32.86 0.01 45.4l-22.71 22.71A32.124 32.124 0 0 1 905.1 960z"
                        fill="#8a8a8a" p-id="6988"></path>
                </svg>
                <input class="headerAS_div_input" v-model="cityInput" @keyup.enter="searchCity" type="text"
                    placeholder="请输入城市(最低市级)">
            </div>
        </div>
        <div class="weatherCondition">
            <table class="weatherTable">
                <tr class="weatherRow">
                    <td class="c1 weatherData">城市</td>
                    <td class="c2 weatherData">{{ city }}</td>
                </tr>
                <tr class="weatherRow">
                    <td class="c1 weatherData">天气</td>
                    <td class="c2 weatherData">{{ weather1 }}</td>
                </tr>
                <tr class="weatherRow">
                    <td class="c1 weatherData">湿度</td>
                    <td class="c2 weatherData">{{ humidity1 }}</td>
                </tr>
                <tr class="weatherRow">
                    <td class="c1 weatherData">温度</td>
                    <td class="c2 weatherData">{{ temperature }}</td>
                </tr>
                <tr class="weatherRow">
                    <td class="c1 weatherData">风向</td>
                    <td class="c2 weatherData">{{ windDirection }}</td>
                </tr>
                <tr class="weatherRow">
                    <td class="c1 weatherData">风力</td>
                    <td class="c2 weatherData">{{ windPower }}</td>
                </tr>
                <tr class="weatherRow">
                    <td class="c1 weatherData">报导时间</td>
                    <td class="c2 weatherData">{{ reportTime }}</td>
                </tr>
            </table>
        </div>
    </div>
</template>
<script setup>
import { ref, onUnmounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useMapReady } from '../Hooks/useMapReady';
let cityInput = ref('')
let city = ref('')
let weather1 = ref('')
let humidity1 = ref('')
let temperature = ref('')
let windDirection = ref('')
let windPower = ref('')
let reportTime = ref('')

let map
const route = useRoute()
// AI「区域搜索某地」驱动：带 ?area= 进来直接搜索（与手动输入搜索同一流程）
const searchAreaFromQuery = (kw) => {
    if (!kw || !map) return
    cityInput.value = String(kw).trim()
    searchCity()
}
// 地图就绪后再操作：直接刷新时 onMounted 里 sm.map 还是 null，裸调会抛 TypeError
useMapReady().onReady((m) => {
    map = m
    map.setPitch(0)
    map.flyTo({ //飞行到某个点，带飞行动画
                center: [118.05,36.81],
                zoom: 5,
                speed: 0.8,
            })
    searchAreaFromQuery(route.query.area)
})
// 同路由下 query 变化（AI 在同一页再搜别的地区）再次触发
watch(() => route.query.area, (v) => searchAreaFromQuery(v))
// 离开只清掉本页加的行政边界多边形；不要 map.setStyle——
// 换底图会清空 L7 全部叠加图层，且导航控件依赖一次性 load 事件建数据源，
// 换风格后 load 不再触发，后续进导航页路线永远画不出来
onUnmounted(() => {
    if (map && layerId && map.getLayer(layerId)) {
        map.removeLayer(layerId)
    }
})

const goToCityPage = () => {
    // console.log(1);
}
const searchCity = () => {
    addMask(cityInput.value);
}

// 本页添加的边界多边形层 id（无搜索时为空，卸载不误删）
let layerId = ''
const addMask = (text) => {
    let postcode = ''
    let level = ''
    let center = []
    // console.log('https://restapi.amap.com/v3/geocode/geo?address=' + result1.text + '&key=' + import.meta.env.VITE_AMAP_KEY + '')
    fetch('https://restapi.amap.com/v3/geocode/geo?address=' + text + '&key=' + import.meta.env.VITE_AMAP_KEY + '')
        .then(response => response.json())
        .then(data => {
            // console.log(data);
            postcode = data.geocodes[0].adcode
            level = data.geocodes[0].level
            center = data.geocodes[0].location.split(',')
            // console.log(`output->postcode,level,center`, postcode, level, center,typeof center)
            // console.log('https://geo.datav.aliyun.com/areas_v3/bound/' + postcode + '_full.json');
            getBound(postcode)
            addWeatherCondition(postcode)
            mapTo(center, level)
        });
}

const getBound = (postcode) => {
    /* DataV 只给「有下级」的行政区出 _full.json：省 → 下辖各市、市 → 下辖各区县。
     * 区县是叶子节点（childrenNum:0），请求 _full 会 404，而且返回体是 XML 错误页 ——
     * 直接 res.json() 会抛 SyntaxError:'Unexpected token <'，被 promise 吞掉，
     * 结果就是「搜区县不画边界」。所以 _full 不通就退回 {adcode}.json，那是该区县
     * 自身的边界，FeatureCollection 结构与 _full 一致，下面 addLayer 不用改。 */
    const base = 'https://geo.datav.aliyun.com/areas_v3/bound/'
    const load = (u) => fetch(u).then(res => {
        if (!res.ok) throw new Error('HTTP ' + res.status) // 别把 XML 错误页喂给 res.json()
        return res.json()
    })
    load(base + postcode + '_full.json')
        .catch(() => load(base + postcode + '.json'))
        .then(res => {
            // console.log(`output->res`, res)
            if (layerId && map.getLayer(layerId)) {
                map.removeLayer(layerId)
            }
            const id = 'polygon' + postcode
            map.addLayer({
                id,
                type: 'fill',    //多边形为fill
                source: {
                    type: 'geojson',
                    data: res
                },
                //绘制参数
                paint: {
                    'fill-color': 'rgb(0,0,255)',
                    'fill-opacity': 0.6,
                },
            })
            layerId = id
            // console.log(oldLayer.id);
        })
        .catch(e => console.warn('[bound] 行政边界获取失败：', e.message))
}

const mapTo = (center, level) => {
    let zoomIndex = 2 // 兜底（兴趣点等）：保持原行为
    if (level === '省') {
        zoomIndex = 5.5
    } else if (level === '市') {
        zoomIndex = 7
    } else if (level === '区县') {
        // 少了这一档：区县会掉进 2 级兜底（一屏整个中国），边界多边形只有几个像素，
        // 看起来就是「搜了没反应」。11 级下区县轮廓约占屏 1/4~1/3，四周还留着城市上下文。
        zoomIndex = 11
    }
    map.flyTo({ //飞行到某个点，带飞行动画
        center: center,
        zoom: zoomIndex,
        speed: 0.8,
    })
}

const addWeatherCondition = (postcode) => {
    console.log('https://restapi.amap.com/v3/weather/weatherInfo?city=' + postcode + '&key=' + import.meta.env.VITE_AMAP_KEY + '')
    fetch('https://restapi.amap.com/v3/weather/weatherInfo?city=' + postcode + '&key=' + import.meta.env.VITE_AMAP_KEY + '')
        .then(response => response.json())
        .then(weather => {
            console.log(weather);
            let cityWeather = weather.lives[0]
            city.value = cityWeather.city
            humidity1.value = cityWeather.humidity_float
            weather1.value = cityWeather.weather
            temperature.value = cityWeather.temperature_float + '℃'
            windDirection.value = cityWeather.winddirection
            windPower.value = cityWeather.windpower
            reportTime.value = cityWeather.reporttime
        })
}
</script>