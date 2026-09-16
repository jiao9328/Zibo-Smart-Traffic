<template>
    <nav id="menu">
        <a href="#"
       :class="{ active: selectedStyle === index }"
       @click="changeStyle(index)"
       v-for="(item, index) in mapStyles"
       :key="index">
       {{ item }}
    </a>
    </nav>
</template>

<script setup>
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useMapReady } from '../Hooks/useMapReady';
const stylesId = ref(['streets-v12', 'streets-v11', 'dark-v10', 'satellite-v9', 'outdoors-v11', 'navigation-day-v1',
        'navigation-night-v1', 'navigation-preview-day-v4', 'navigation-preview-night-v4', 'navigation-guidance-day-v4']);
const mapStyles = ref(['街道风格', '高对比度街道风格', '深色风格', '卫星影像', '地形风格', '高清街道风格',
        '夜间街道风格', '导航风格（白天）', '导航风格（夜间）', '海图风格']);
let map
const selectedStyle = ref(null);
const route = useRoute()
const changeStyle = (index) => {
    if (!map) return
    selectedStyle.value = index;
    /* ★ 不要调 map.setProjection('globe')。
     * L7 不把图层挂到 mapbox 的 custom layer 上，而是自建 canvas 并用
     * WebMercatorViewport 自己算投影矩阵（@antv/l7-maps/es/mapbox/Viewport.js）。
     * 切成球面投影后「球体 + 平面」必然错位，7 类业务图层全部对不上路网。
     * 而且地球形态只在 zoom ≤ 5 才出现，那时业务图层本来就全看不见，收益为零。 */
    map.setStyle(`mapbox://styles/mapbox/${stylesId.value[index]}`);
};
// AI「切换某一风格」驱动：带 ?style= 进来直接点选对应风格（与手动点击同一流程）
const applyStyleFromQuery = (label) => {
    if (!label || !map) return
    const i = mapStyles.value.indexOf(label)
    if (i >= 0) changeStyle(i)
}
// 地图就绪后再执行：直接刷新时 onMounted 里 sm.map 还是 null
useMapReady().onReady((m) => {
    map = m
    applyStyleFromQuery(route.query.style)
})
// 同路由下 query 变化（AI 在同一页再换风格）再次点选
watch(() => route.query.style, (v) => applyStyleFromQuery(v))

const setAllNone = () => {
    const links = document.querySelectorAll('[data-i="a"]');
    for (let i = 0; i < links.length; i++) {
        links[i].className = '';
    }
};

const setMapStyle = (style) => {
    const styleId = stylesId.value[mapStyles.value.indexOf(style)];
    setAllNone();
    const link = document.querySelector(`#${styleId}`);
    if (link && map) {
        link.className = 'active';
        map.setStyle(`mapbox://styles/mapbox/${styleId}`);
    }
};
</script>

<style scoped>
/* 风格下拉菜单：与全站白卡片统一（原为 #fff + 3px 圆角 + 半透明黑边） */
#menu {
    background: var(--bg-panel);
    position: absolute;
    z-index: var(--z-panel);
    top: 11%;
    right: 5%;
    width: 132px;
    box-sizing: border-box;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    font-family: inherit;
}

#menu a {
    font-size: 13px;
    color: var(--text-sub);
    display: block;
    margin: 0;
    padding: 9px 10px;
    text-decoration: none;
    border-bottom: 1px solid var(--border);
    text-align: center;
    transition: background 0.15s, color 0.15s;
}

#menu a:last-child {
    border-bottom: none;
}

#menu a:hover {
    background-color: var(--bg-hover);
    color: var(--primary);
}

#menu a.active {
    background-color: var(--primary-soft);
    color: var(--primary);
    font-weight: 600;
}

#menu a.active:hover {
    background: #3074a4;
}
</style>
