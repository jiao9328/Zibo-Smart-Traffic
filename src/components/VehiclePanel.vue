<template>
  <!-- 左下角动态车辆迷你面板：随「动态车辆」图层开关同开同关（store.trafficOn.vehicle 唯一镜像） -->
  <div class="vp-panel ui-panel" :class="{ shift: store.chartsOpen }" v-show="store.trafficOn.vehicle">
    <div class="vp-title">
      <span class="vp-car-icon" aria-hidden="true"><CarIcon /></span>
      <span>动态车辆·信号灯联动</span>
      <span class="vp-close" title="关闭面板并隐藏车辆图层" @click="turnOff">✕</span>
    </div>
    <div class="vp-stat">
      <span>行驶 <b class="ok">{{ stats.running }}</b></span>
      <span>红灯停 <b class="warn">{{ stats.waiting }}</b></span>
      <span>拥堵缓行 <b class="warn">{{ stats.onCongested }}</b></span>
      <span>均速 <b class="cy">{{ stats.avgSpeed }}</b> km/h</span>
    </div>
    <div class="vp-list">
      <!-- 每行：编号徽标（与地图 marker 上的徽标同编号同颜色）+ 状态点 + 车牌 + 道路 + 前方灯 + 速度 -->
      <div v-for="v in vehicles" :key="v.id" class="vp-row" :id="'vp-row-' + v.id"
        :class="{ focus: store.selectedVehicleId === v.id, hover: store.hoveredVehicleId === v.id }"
        :style="{ '--vm-color': carColor(v.id) }" :title="`点击定位到地图上的第 ${carNo(v)} 号车`"
        @click="pick(v)" @mouseenter="store.hoveredVehicleId = v.id" @mouseleave="store.hoveredVehicleId = null">
        <b class="vp-badge">{{ carNo(v) }}</b>
        <span class="vp-dot" :class="v.state" :title="v.state === 'waiting' ? '红灯等待中' : '行驶中'"></span>
        <span class="vp-plate">{{ v.plate }}</span>
        <span class="vp-road" :title="v.road">{{ v.road }}</span>
        <span class="vp-light" :class="v.lightColor"
          :title="v.lightColor === 'none' ? '前方无信号灯' : `前方${lightName[v.lightColor]}（模拟相位，距 ${v.lightDist} m）`">
          {{ v.lightColor === 'none' ? '·' : '◉' }}
        </span>
        <span class="vp-speed"><b>{{ kmh(v) }}</b> km/h</span>
      </div>
    </div>
  </div>
</template>
<script setup>
import { computed, inject, watch, nextTick } from 'vue'
import { setTrafficLayerVisible } from '../tools/initTrafficLayers'
import { vehicles, carColor, carNo, selectVehicle } from '../tools/vehicleSim'
import CarIcon from './CarIcon.vue'

const { store } = inject('$store')
const stats = computed(() => store.vehicleStats)
const kmh = (v) => Math.round(v.speed * 3.6)
const lightName = { green: '绿灯', yellow: '黄灯', red: '红灯' }
const turnOff = () => setTrafficLayerVisible('vehicle', false)

/** 点行 → 地图飞过去 + 高亮 + 打开详情气泡 */
const pick = (v) => selectVehicle(v.id, { fly: true, zoom: 15, openPopup: true })

/* 地图上点了某辆车（或别处改了选中）→ 把对应行滚进视野。
 * 列表自身 max-height + overflow-y:auto，scrollIntoView 滚的是这个列表。 */
watch(
  () => store.selectedVehicleId,
  async (id) => {
    if (id === null) return
    await nextTick()
    const el = document.getElementById('vp-row-' + id)
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
)
</script>
<style scoped>
/* 打开控制中心时，左侧图表列会压住本面板 → 整体让到图表列右侧 */
.vp-panel {
  position: fixed;
  left: 1%;
  bottom: 92px;
  z-index: var(--z-panel); /* 低于底部工具条(90)与弹窗(100)，避免遮挡核心操作 */
  width: 340px;
  box-sizing: border-box;
  padding: 10px 12px;
}

.vp-panel.shift {
  left: calc(var(--g2-left-x) + var(--g2-col-w) + var(--gap));
}

.vp-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  padding-bottom: 8px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border);
}

/* 标题图标：原来是 🚗 emoji（无法着色，且与换 SVG 后的地图 marker 不一致）。
 * 与实时数据栏「动态车辆」行共用 CarIcon 组件，避免两处车形各画一份再走样。 */
.vp-car-icon {
  display: flex;
  width: 15px;
  height: 15px;
  color: var(--primary);
}

.vp-close {
  margin-left: auto;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  line-height: 1;
  color: var(--text-mute);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.vp-close:hover {
  background: var(--danger-soft);
  color: var(--danger);
}

/* 汇总行 */
.vp-stat {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-sub);
  padding: 6px 2px 8px;
  gap: 4px;
  flex-wrap: wrap;
}
.vp-stat b {
  font-weight: 600;
  color: var(--primary);
}
.vp-stat b.ok { color: var(--ok); }
.vp-stat b.warn { color: var(--danger); }

/* 车辆列表 */
.vp-list {
  max-height: 296px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-right: -4px;
  padding-right: 4px;
}

.vp-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-sub);
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.vp-row:hover,
.vp-row.hover {
  background: var(--bg-hover);
}
/* 选中行：浅蓝底 + 车辆专属色描边，与地图上同一辆车的 marker 呼应 */
.vp-row.focus {
  background: var(--primary-soft);
  border-color: var(--vm-color, #1769e0);
}

/* 编号徽标：与地图 marker 上的 .vm-badge 同编号、同颜色（--vm-color 同一来源） */
.vp-badge {
  flex: none;
  min-width: 16px;
  height: 16px;
  padding: 0 3px;
  box-sizing: border-box;
  border-radius: 8px;
  font-size: 10px;
  line-height: 16px;
  font-weight: 700;
  text-align: center;
  color: #fff;
  background: var(--vm-color, #1769e0);
}

.vp-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}
.vp-dot.running { background: var(--ok); }
.vp-dot.waiting { background: var(--danger); }

.vp-plate {
  color: var(--text);
  letter-spacing: 0.5px;
  flex: none;
}

.vp-road {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-mute);
}

/* 前方信号灯模拟相位徽标 */
.vp-light {
  flex: none;
  font-size: 11px;
  width: 12px;
  text-align: center;
}
.vp-light.green { color: var(--ok); }
.vp-light.yellow { color: var(--warn); }
.vp-light.red { color: var(--danger); }
.vp-light.none { color: var(--text-mute); }

.vp-speed {
  flex: none;
  font-size: 11px;
  color: var(--text-mute);
  min-width: 62px;
  text-align: right;
}
.vp-speed b {
  color: var(--primary);
  font-weight: 600;
  font-size: 13px;
}
</style>
