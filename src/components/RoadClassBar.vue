<template>
  <div class="road-bar">
    <!-- 总道路：显示全路网（基础图层），其余：只显示对应等级 -->
    <div
      v-for="b in buttons"
      :key="b.key"
      class="road-btn"
      :class="{ on: active === b.key }"
      @click="pick(b.key)"
    >
      {{ b.label }}
    </div>
  </div>
</template>
<script setup>
import { computed, inject } from 'vue'
import { selectRoadClass } from '../tools/roadClassLayers'

const { store } = inject('$store')

// 'total' = 总道路；其余与 roadClassLayers.CLASSES 一一对应
const buttons = [
  { key: 'total', label: '总道路' },
  { key: 'highway', label: '高速公路' },
  { key: 'first', label: '一级道路' },
  { key: 'second', label: '二级道路' },
  { key: 'third', label: '三级道路' },
]
const active = computed(() => store.roadClass || 'total')

const pick = (key) => {
  // 重复点当前等级 = 回到总道路
  const next = active.value === key && key !== 'total' ? 'total' : key
  store.roadClass = next === 'total' ? null : next
  selectRoadClass(next === 'total' ? null : next)
}
</script>
<style scoped>
/* ===== 顶部道路分级栏：白卡片 + 5 个分段按钮（原为藏青玻璃 + 青绿高亮） ===== */
.road-bar {
  position: fixed;
  top: calc(var(--header-h) + 12px);
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--z-panel);
  display: flex;
  align-items: center;
  width: 33.33vw; /* 占页面 1/3 */
  height: 60px;
  box-sizing: border-box;
  padding: 7px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  gap: 6px;
}

.road-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  border-radius: var(--radius);
  font-size: 14px;
  color: var(--text-sub);
  background: var(--bg-sub);
  border: 1px solid transparent;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.road-btn:hover {
  color: var(--primary);
  background: var(--bg-hover);
}

/* 选中态：主色实底（原为青绿 #00C8B8，是页面上唯一一处绿色主色，与全站蓝调冲突） */
.road-btn.on {
  color: #fff;
  background: var(--primary);
  font-weight: 600;
}
</style>
