<template>
  <div>
    <div class="g2-left">
      <div class="g2-chart">
        <div class="people-sum">淄博各区县车辆密度指数</div>
        <div class="g2-body">
          <ColumnChart v-bind="config" :data="data" />
        </div>
      </div>
      <div class="g2-chart">
        <div class="people-sum">淄博各区县拥堵路段流量排行</div>
        <div class="g2-body">
          <BarChart v-bind="busChart.bus_config" :data="busChart.bus_data" />
        </div>
      </div>
    </div>
    <div class="g2-right">
      <div class="g2-chart g2-pie">
        <div class="people-sum">近期警情类型分布</div>
        <div class="g2-body">
          <PieChart v-bind="peopleChart.people_config" />
        </div>
      </div>
      <div class="g2-chart g2-stat">
        <div class="people-sum">道路感知设备</div>
        <div class="hospital">
          <div class="item">
            <h4>监控探头 <span class="screen-num">{{ stat.cameraTotal }}台</span></h4>
            <p class="item-sub">故障 <span class="num-fault">{{ stat.cameraFault }}</span></p>
          </div>
          <div class="item">
            <h4>信号灯 <span class="screen-num">{{ stat.lightTotal }}处</span></h4>
            <p class="item-sub">故障 <span class="num-fault">{{ stat.lightFault }}</span></p>
          </div>
        </div>
      </div>
      <div class="g2-chart g2-stat">
        <div class="people-sum">警力与公交运力</div>
        <div class="hospital">
          <div class="item">
            <h4>在线警员 <span class="screen-num">{{ stat.policeOnDuty }}/{{ stat.policeTotal }}</span></h4>
            <p class="item-sub">全市部署警力</p>
          </div>
          <div class="item">
            <h4>公交运力 <span class="screen-num">{{ stat.busRoutes }}线/{{ stat.busStops }}站</span></h4>
            <p class="item-sub">高德真实线路数据</p>
          </div>
        </div>
      </div>
      <!-- 动态车辆·信号灯联动：读 vehicleSim 统计镜像 + 近 60s 均速折线 -->
      <div class="g2-chart vp-block">
        <div class="people-sum">动态车辆·信号灯联动</div>
        <div class="hosp4">
          <div class="it"><b class="ok">{{ vs.running }}</b><span>行驶中</span></div>
          <div class="it"><b class="warn">{{ vs.waiting }}</b><span>红灯等待</span></div>
          <div class="it"><b class="warn">{{ vs.onCongested }}</b><span>拥堵缓行</span></div>
          <div class="it"><b class="cy">{{ vs.avgSpeed }}</b><span>均速km/h</span></div>
        </div>
        <div class="g2-body">
          <LineChart v-bind="lineChart" />
        </div>
      </div>
    </div>
  </div>
</template>
<script setup>
import { computed } from 'vue'
import { ColumnChart, BarChart, PieChart, LineChart } from "@opd/g2plot-vue";
/* 出行人口 */
import { useLeftTop } from "@/Hooks/useLeftTop";
import { useLeftBottom } from "@/Hooks/useLeftBottom";
import { useRightTop } from "@/Hooks/useRightTop";
import { store } from '../store'
import { PRIMARY, AXIS_TEXT } from '@/tools/palette'
/* DB 未就绪时的兜底源：mock 单例与入库数据同种子同口径；JSON 为公交真实数据 */
import { cameras as mockCameras, trafficLights as mockLights, police as mockPolice } from '@/tools/mockData'
import busRoutes from '@/assets/GIS_Data/bus_routes.json'
import busStops from '@/assets/GIS_Data/bus_stops_amap.json'

// DB 就绪（后端可达且已拉取）→ 读 SQL Server；否则回退本地兜底源
const rowsOf = (name) => (store.dbStatus === 'ok' ? store.dbData[name] : undefined)

/* 车辆密度柱状图：派生计算值（人口比例），非 DB 表，保持静态 */
const { config, data } = useLeftTop();

/* 拥堵流量条形图 / 警情饼图：读 DB congestion / alerts，随增删改响应式刷新 */
const busChart = computed(() => useLeftBottom(rowsOf('congestion')));
const peopleChart = computed(() => useRightTop(rowsOf('alerts')));

// 交通设施统计卡（DB 行实时统计；故障数/在勤数按各自状态列）
const stat = computed(() => {
  const cam = rowsOf('cameras') || mockCameras
  const light = rowsOf('traffic_lights') || mockLights
  const pol = rowsOf('police') || mockPolice
  const routes = rowsOf('bus_routes') || busRoutes.features
  const stops = rowsOf('bus_stops') || busStops.features
  return {
    cameraTotal: cam.length,
    cameraFault: cam.filter((c) => c.status === 'fault').length,
    lightTotal: light.length,
    lightFault: light.filter((l) => l.state === 'fault').length,
    policeTotal: pol.length,
    policeOnDuty: pol.filter((p) => p.onDuty === true || p.on_duty === true).length,
    busRoutes: routes.length,
    busStops: stops.length
  }
})

// 动态车辆联动块：vehicleSim 每秒写入的统计镜像 + 近 60s 均速（秒级刷新）
const vs = computed(() => store.vehicleStats)
// 注：不设 height，高度交给 .g2-body 的 flex 尺寸（原 height:92 会在面板变矮时溢出）
const lineChart = computed(() => ({
  xField: 't',
  yField: 'speed',
  smooth: true,
  color: PRIMARY,
  lineStyle: { lineWidth: 2 },
  xAxis: { label: { style: { fill: AXIS_TEXT, fontSize: 10 } }, tickCount: 6 },
  yAxis: { label: { style: { fill: AXIS_TEXT, fontSize: 10 } }, min: 0 },
  // 依赖 history.length 触发每秒重算（push/shift 原地变更不会自动触发）
  data: (store.vehicleStats.history.length, store.vehicleStats.history.slice())
}))
</script>
<style scoped>
/* 控制中心左右两列。
 * 原实现有 4 个互相叠加的毛病，逐条对应到下面的属性：
 *   1. z-index:100 高过底部工具条(90)/实时数据栏(46)/车辆面板(45) → 改用 --z-chart(80)
 *   2. top/bottom 用固定的 160px/75vh，与 Header 和底部工具条各档分辨率下不对齐
 *      → 改成由 --header-h / --footer-h 推出的安全区
 *   3. height:75vh 与内部写死的 height:270px 打架，面板按百分比缩小时内容溢出盖住下一块
 *   4. 列容器整体可点，两列之间的空隙也吃事件，挡着地图没法拖 → 容器 pointer-events:none
 */
.g2-left,
.g2-right {
  position: fixed;
  top: calc(var(--header-h) + 20px);
  bottom: calc(var(--footer-h) + 26px);
  width: var(--g2-col-w);
  display: flex;
  flex-direction: column;
  gap: var(--gap);
  box-sizing: border-box;
  pointer-events: none; /* 列容器不吃事件，两列间的空隙可以直接拖地图 */
  z-index: var(--z-chart); /* 80 < --z-footer 90：绝不盖住底部按钮 */
}

.g2-right {
  right: 60px;
}

/* 左列让开左上「实时数据栏」（left:1% + 168px，1440 宽下右边缘约 182px） */
.g2-left {
  left: var(--g2-left-x);
}

.g2-chart {
  position: relative;
  flex: 1 1 0;
  min-height: 0; /* flex 子项默认 min-height:auto，不写这行内容会把面板撑破 */
  display: flex;
  flex-direction: column;
  box-sizing: border-box; /* 修 padding 造成的横向溢出（原 content-box 多出 40px） */
  overflow: hidden; /* 内容不得串到相邻面板 */
  padding: 12px 16px 14px;
  pointer-events: auto; /* 容器 none，卡片本体恢复交互 */
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
}

/* G2Plot 宿主：必须有确定高度，否则 autoFit 无从计算，会兜底到 400px 撑破面板 */
.g2-body {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
}

/* ★ 关键一行：给 G2Plot 自己建的那层容器（.g2-body 的直接子 div）一个确定高度。
 *
 * 不加这行会死锁，实测过：Plot 构造时读自己容器的尺寸，那层 div 还是 height:auto 且
 * 没有任何子节点，于是高度为 0 → 命中 getChartSize 的兜底值 400 → 画出 400px 高的 canvas
 * → 这个 canvas 反过来把容器撑成 400 → 此后容器高度恒等于 chart.height，
 * size-sensor 的 `height !== chart.height` 判断永远为假，forceFit 再也不会被触发，
 * 图表就永久卡在 400px（面板 180px 也照样画 400px，溢出盖住下一块）。
 * 用 height:100% 让它由父层（.g2-body，高度已由 flex 链确定）决定，断开这个自我循环。
 *
 * 必须写 :deep()：这层 div 是 G2Plot 用 JS 建出来的，不带 Vue 的 scoped 属性
 * （scoped 会编译成 `.g2-body > div[data-v-xxx]`），不加 :deep 选择器根本匹配不上，
 * 规则形同虚设 —— 这一点已实测确认。 */
:deep(.g2-body > div) {
  height: 100%;
}

/* 原 .g2-chart::before/::after 是 border.png 位图装饰角（top:-5px 故意探出卡片外）。
 * 它们既与「白卡片 + 1px 描边」的新视觉冲突，又必然被上面的 overflow:hidden 裁掉，
 * 且未设 pointer-events:none 时还会挡住 canvas 边缘的点击 —— 直接删掉，
 * 角落不再需要装饰。图片文件本身保留不删。 */

/* 右列各块的高度配比（原来是 26%/10%/10%/28% 的行内 style，改成 flex 比例） */
.g2-right > .g2-pie { flex: 5 1 0; }
.g2-right > .g2-stat { flex: 2 1 0; min-height: 112px; }
.g2-right > .vp-block { flex: 4 1 0; }

.hospital {
  display: flex;
  justify-content: space-evenly;
  color: var(--text);
  align-items: flex-start;
  text-align: center;
}

.hospital .item {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* 卡片标题：回到文档流内（原来用 top:-58px + absolute 顶到面板外面去了），
 * 背景由 chart-item.png 位图改为纯 CSS */
.people-sum {
  flex: none;
  height: 30px;
  line-height: 30px;
  margin-bottom: 6px;
  text-align: center;
  color: var(--text);
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}

/* 故障数：原来是行内 style 硬写 #ff6b6b，改用语义色变量 */
.num-fault {
  color: var(--danger);
  font-weight: 600;
}

/* ===== 动态车辆·信号灯联动块 ===== */
.vp-block {
  display: flex;
  flex-direction: column;
}

/* 4 项速览：行驶中 / 红灯等待 / 拥堵缓行 / 均速 */
.hosp4 {
  display: flex;
  justify-content: space-around;
  text-align: center;
  /* 与下方折线留出呼吸感：原来只有 2px，标签紧贴曲线 */
  margin-bottom: 8px;
  flex: none;
}

.hosp4 .it {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}

.hosp4 .it b {
  font-size: 17px;
  font-weight: bold;
}

.hosp4 .it b.ok { color: var(--ok); }
.hosp4 .it b.warn { color: var(--danger); }
.hosp4 .it b.cy { color: var(--primary); }

.hosp4 .it span {
  font-size: 11px;
  color: var(--text-mute);
}
</style>
