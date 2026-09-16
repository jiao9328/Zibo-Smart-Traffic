<template>
  <!-- 行为路由：无 UI，挂载即把相机推到「城市视角」（低空俯瞰淄博路网） -->
</template>

<script setup>
/**
 * 城市视角 —— 飞到淄博中心，压到 pitch:70 的俯瞰视角。
 *
 * 修复记录：原实现 `let map, scene` 声明后**从未给 map 赋值**（只赋了 scene），
 * 第 10 行 `map.flyTo(...)` 必抛 `TypeError: Cannot read properties of undefined`，
 * 所以点底部「城市视角」按钮毫无反应。改用 useMapReady 统一取实例 + 处理未就绪。
 *
 * 注意：pitch:70 依赖 App.vue 建图时的 `maxPitch: 85`，否则会被 mapbox 默认的
 * maxPitch=60 静默夹成 60。
 */
import { useMapReady } from '@/Hooks/useMapReady'

useMapReady().onReady((map) => {
  // 打断在途动画（首页的 flyTo / 地球自转的 ease），否则相机指令互相打断
  map.stop()
  map.flyTo({
    center: [118.05, 36.81],
    zoom: 12,
    pitch: 70,
    bearing: 0,
    duration: 2500,
    essential: true // 系统开启「减少动态效果」时仍播（大屏演示需要）
  })
})
</script>
