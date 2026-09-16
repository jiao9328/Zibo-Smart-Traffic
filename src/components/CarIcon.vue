<template>
  <!-- 俯视车形图标：车头朝上（与地图 marker 里 vehicleSim 的 CAR_SVG 方向一致）。
       fill 取 currentColor，由父级 color 决定 —— 这正是替换 🚗 emoji 的原因：
       emoji 是彩色位图字体，既不能随主题着色，也无法表示「每辆车一个专属色」。 -->
  <svg class="car-icon" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="6.2" y="2.4" width="11.6" height="19.2" rx="4.6" />
    <rect class="car-window" x="8.3" y="6.4" width="7.4" height="5.2" rx="1.5" />
    <rect class="car-window dim" x="8.3" y="13.6" width="7.4" height="3.2" rx="1.3" />
  </svg>
</template>

<script setup>
// 无状态图标组件；尺寸/颜色全部由使用处的 CSS 决定（.car-icon { width/height/color }）
</script>

<style scoped>
.car-icon {
  display: block;
  width: 100%;
  height: 100%;
  fill: currentColor;
}
/* 车窗挖空：用父级背景色不靠谱，直接降低不透明度，在任意底色上都能读出车窗 */
.car-window {
  fill: #fff;
  opacity: 0.55;
}
.car-window.dim {
  opacity: 0.35;
}
</style>
