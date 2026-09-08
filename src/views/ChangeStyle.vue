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
import { ref, onMounted, inject, watch } from 'vue';
import { useRoute } from 'vue-router';
const stylesId = ref(['streets-v12', 'streets-v11', 'dark-v10', 'satellite-v9', 'outdoors-v11', 'navigation-day-v1',
        'navigation-night-v1', 'navigation-preview-day-v4', 'navigation-preview-night-v4', 'navigation-guidance-day-v4']);
const mapStyles = ref(['街道风格', '高对比度街道风格', '深色风格', '卫星影像', '地形风格', '高清街道风格',
        '夜间街道风格', '导航风格（白天）', '导航风格（夜间）', '海图风格']);
let map
const selectedStyle = ref(null);
const route = useRoute()
const changeStyle = (index) => {
    selectedStyle.value = index;
    console.log(stylesId.value[index]);
    map.setStyle(`mapbox://styles/mapbox/${stylesId.value[index]}`);
    map.setProjection('globe');
};
// AI「切换某一风格」驱动：带 ?style= 进来直接点选对应风格（与手动点击同一流程）
const applyStyleFromQuery = (label) => {
    if (!label || !map) return
    const i = mapStyles.value.indexOf(label)
    if (i >= 0) changeStyle(i)
}
onMounted(() => {
    map = inject("$scene_map").map
    applyStyleFromQuery(route.query.style)
});
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
    if (link) {
        link.className = 'active';
        map.setStyle(`mapbox://styles/mapbox/${styleId}`);
        map.setProjection('globe');
    }
};
</script>
  
<style scoped>
#menu {
    background: #fff;
    position: absolute;
    z-index: 1;
    top: 11%;
    right: 5%;
    border-radius: 3px;
    width: 120px;
    border: 1px solid rgba(0, 0, 0, 0.4);
    font-family: 'Open Sans', sans-serif;
}

#menu a {
    font-size: 13px;
    color: #404040;
    display: block;
    margin: 0;
    padding: 0;
    padding: 10px;
    text-decoration: none;
    border-bottom: 1px solid rgba(0, 0, 0, 0.25);
    text-align: center;
}

#menu a:last-child {
    border: none;
}

#menu a:hover {
    background-color: #f8f8f8;
    color: #404040;
}

#menu a.active {
    background-color: #3887be;
    color: #ffffff;
}

#menu a.active:hover {
    background: #3074a4;
}
</style>
  