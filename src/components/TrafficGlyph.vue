<template>
  <!-- 交通图层的行首小图标：与地图上的点符号**同源**（同一份 emoji 表，见 tools/trafficIcons.js），
       所以「面板图标 = 地图符号」不会对不上（原来是信号灯画飞机、警员画房子、公交站画收藏星）。
       字号由使用处的 CSS 决定（宽度/高度按 font-size 走，与 CarIcon.vue 的盒子一致）。 -->
  <span class="traffic-glyph" role="img" :aria-label="glyph.label">{{ glyph.char }}</span>
</template>

<script setup>
import { computed } from 'vue'
import { TRAFFIC_GLYPHS } from '../tools/trafficIcons'

const props = defineProps({
  // 四类点位图层名（与 initTrafficLayers 的注册表键一致）：camera / trafficLight / police / busStop
  name: { type: String, required: true }
})
const glyph = computed(() => TRAFFIC_GLYPHS[props.name] || TRAFFIC_GLYPHS.camera)
</script>

<style scoped>
.traffic-glyph {
  display: block;
  width: 100%;
  height: 100%;
  /* emoji 是彩色位图字体，故意不设 color —— color 对彩色字形无效（开关态由行尾的 rt-dot 表达） */
  font-family: 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', 'Segoe UI Symbol', sans-serif;
  font-size: 100%; /* 行高/字号都跟着父级盒子走，与 iconfont 图标同一视觉重量 */
  line-height: 1;
  text-align: center;
}
</style>
