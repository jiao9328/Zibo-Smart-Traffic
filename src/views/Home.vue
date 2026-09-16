<template>
  <div class="home-wrap"></div>
</template>
<script setup>
// 首页：纯净地图 + 顶部标题 + 底部工具条。
// 等地图就绪后飞到淄博全景，打开道路/建筑基础图层。
import { store } from '../store'
import { selectRoadClass } from '../tools/roadClassLayers'
import { baseLayerMap } from '../tools/initLayer'
import { useMapReady } from '../Hooks/useMapReady'

// 容器已就绪直接飞，否则等容器赋值（App.vue boot 完成后触发一次即停）
useMapReady().onReady((map) => {
  map.flyTo({
    center: [118.05, 36.81],
    zoom: 9.5,
    pitch: 0,
    duration: 2000
  })
  // 建筑基础图层显示
  const building = baseLayerMap['淄博市']
  if (building) building.show()
  // 道路：若已选分级则维持分级显示，否则显示基础全路网
  selectRoadClass(store.roadClass)
})
</script>
