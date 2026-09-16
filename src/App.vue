<template>
  <div id="map"></div>
  <Header></Header>
  <RoadClassBar v-if="loadMap"></RoadClassBar>
  <RealtimeBar v-if="loadMap"></RealtimeBar>
  <VehiclePanel v-if="loadMap"></VehiclePanel>
  <BottomTools v-if="loadMap"></BottomTools>
  <!-- AI 助手：右下角悬浮按钮 + 对话框（全局浮层，跨路由可用） -->
  <AIAssistant v-if="loadMap"></AIAssistant>
  <RouterView></RouterView>
  <!-- 控制中心浮层：全局开关（再点控制中心才关闭），路由切换不消失 -->
  <G2Charts v-if="store.chartsOpen"></G2Charts>
  <!-- 数据管理面板：底部「数据管理」开关，增删改查 SQL Server 业务表 -->
  <DataManage v-if="store.dataPanelOpen"></DataManage>
  <!-- 交通可视化大屏：底部「交通大屏」开关，把库表数据与实时车辆数据汇总联动（全屏浮层） -->
  <TrafficScreen v-if="store.screenOpen" />
</template>
<script setup>
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { onMounted, provide, reactive, ref } from "vue";
import { useRouter } from 'vue-router';
import { Scene } from "@antv/l7";
import { Mapbox } from "@antv/l7-maps";
import { RouterView } from 'vue-router'
import initControl from './tools/initControl'
import initLayer from './tools/initLayer'
import { initTrafficLayers, refreshVisibleTrafficLayers } from './tools/initTrafficLayers'
import { initRoadClassLayers } from './tools/roadClassLayers'
import { initVehicleSim } from './tools/vehicleSim'
import Header from './components/Header.vue'
import RoadClassBar from './components/RoadClassBar.vue'
import RealtimeBar from './components/RealtimeBar.vue'
import VehiclePanel from './components/VehiclePanel.vue'
import BottomTools from './components/BottomTools.vue'
import AIAssistant from './components/AIAssistant.vue'
import G2Charts from './views/G2Charts.vue'
import DataManage from './components/DataManage.vue'
import TrafficScreen from './views/TrafficScreen.vue'
import { store, injectStore } from './store'
import { api as dbApi } from './api'
import { fetchWeather } from './tools/weather'
import { speak } from './tools/speech'
import { ElMessage } from 'element-plus'
const loadMap = ref(false);
const router = useRouter();

// 坑1修复：setup 同步 provide 响应式容器（Vue3 子组件 onMounted 先于父组件执行，
// 子组件在 mounted 里 inject 的是容器引用，等 initMap 完成后赋值即拿到实例）
const sceneMap = reactive({ scene: null, map: null });
provide('$scene_map', sceneMap);
provide('$store', injectStore);

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const initMap = () => {
  const map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/streets-v12", //地图风格
    center: [118.05, 36.81], //地图中心坐标
    zoom: 9.5, //缩放比例
    // 城市视角（CityView.vue）要压到 pitch:70 俯瞰；mapbox 默认 maxPitch 只有 60，
    // 不改这里 pitch:70 会被静默夹成 60，城市视角的「俯视」效果出不来。
    maxPitch: 85,
  });

  // 汉化
  map.addControl(new MapboxLanguage({
    defaultLanguage: 'zh-Hans' // 设置默认语⾔
  }))

  const scene = new Scene({
    id: "map",
    map: new Mapbox({
      mapInstance: map,
    }),
  });
  // 坑：基础图层（道路流线/城市建筑）必须等 style 加载完成再 addLayer。
  // L7 在 style 未就绪时抢先建图层会撞 mapbox「Style is not done loading」，
  // 偶发打断样式加载（地图卡加载、导航/飞行全部失效），故统一推迟到 map load 后。
  map.on("style.load", () => {
    map.setFog({});
    // 消除边界
    map.setFilter("admin-0-boundary-disputed", [
      "all",
      ["==", ["get", "disputed"], "true"],
      ["==", ["get", "admin_level"], 0],
      ["==", ["get", "maritime"], "false"],
      ["match", ["get", "worldview"], ["all", "CN"], true, false],
    ]);
    map.setFilter("admin-0-boundary", [
      "all",
      ["==", ["get", "admin_level"], 0],
      ["==", ["get", "disputed"], "false"],
      ["==", ["get", "maritime"], "false"],
      ["match", ["get", "worldview"], ["all", "CN"], true, false],
    ]);
    map.setFilter("admin-0-boundary-bg", [
      "all",
      ["==", ["get", "admin_level"], 0],
      ["==", ["get", "maritime"], "false"],
      ["match", ["get", "worldview"], ["all", "CN"], true, false],
    ]);
  });
  // 等 style 真正加载完再建基础图层/挂载 UI（慢网时可能数秒）
  const boot = () => {
    initControl(scene, map)
    initLayer(scene)
    initTrafficLayers(scene)
    initRoadClassLayers(scene)
    initVehicleSim(scene, map) // 动态车辆模拟：自驱 tick（未开图层也累计统计），开图层才建 marker
    loadMap.value = true
    // 响应式容器赋值（子组件 mounted 时注入的引用同步生效）
    sceneMap.scene = scene
    sceneMap.map = map
    if (import.meta.env.DEV) {
      // 调试桥仅开发环境暴露（供 CDP 验证脚本断言）
      window.__scene = scene
      window.__map = map
      // 路由实例：截图/验证脚本要用 router.push 走 SPA 跳转，不能整页刷新
      // （整页刷新每次新建一个 mapbox 地图 = 一个 WebGL 上下文，跳七八次就耗尽，地图再也起不来）
      window.__router = router
    }
  }
  if (map.loaded()) boot()
  else map.once('load', boot)
};

// 启动时拉取 SQL Server 业务数据（后端未启动/库未入库都不阻塞地图：
// 图层/图表在 DB 就绪前回退本地同源兜底数据，拉取成功后重建刷新）
const loadDbData = async () => {
  store.dbStatus = 'loading'
  try {
    const data = await dbApi.fetchMapData()
    for (const t of Object.keys(store.dbData)) {
      if (Array.isArray(data[t])) store.dbData[t] = data[t]
    }
    store.dbStatus = 'ok'
    // 拉取时若某些图层已开启，用库中数据重建
    refreshVisibleTrafficLayers()
  } catch (e) {
    store.dbStatus = 'fail'
    store.dbError = e.message || '后端数据服务不可用'
    console.warn('[db] 后端未连接，使用本地演示数据：', store.dbError)
    ElMessage.warning('未连接数据库服务（' + store.dbError + '）：已使用内置演示数据，可在底部「数据管理」查看/重试')
  }
}

onMounted(async () => {
  // 登录页阶段不播开场语音（初始导航可能尚未 resolve，先等路由就绪再判路径）
  await router.isReady()
  const isLogin = router.currentRoute.value.path === '/login'
  initMap();
  // SQL Server 业务数据全量拉取（不阻塞地图加载，失败自动回退演示数据）
  loadDbData();
  // 天气（真实抓取，失败自动回退占位数据）
  store.weather = await fetchWeather()
  // 开场播报（登录成功后的欢迎语音在 Login.vue 里播，此处仅进入主页后播）
  if (!isLogin) speak('淄博智慧交通管理系统已就绪，实时监控全市道路运行状态')
});
</script>
<style>
#map {
  width: 100vw;
  height: 100vh;
  position: absolute;
  left: 0;
  top: 0;
  /* z-index:auto 时 #map 不是层叠上下文，L7 内部写死的 z-index 会直接跑到根层叠上下文里
   * 和全站抢层级（见下方 .l7-control-container 注释）。给个非 auto 的值把地图里的一切
   * 关进这一层，全站浮层 token（--z-panel 46 起）就都在它之上。 */
  z-index: var(--z-map);
}

/* 地图右上角那组 L7 控件（全屏等）默认 position:absolute; top:0; right:0，正压在 Header 上。
 *
 * 之前 #map 没有层叠上下文，L7 控件容器写死的 z-index:1000 高过 Header 的 --z-header:50，
 * 于是「退出登录」按钮的位置 elementFromPoint 命中的是 L7 的 BUTTON.l7-button-control「全屏」
 * ——点退出只会全屏，退出登录实际点不到（这个 bug 就是这样被巡检抓到的）。
 *
 * 两条一起才有意义：
 *   上面给 #map 加了 z-index ⇒ Header 重新盖住这块区域；
 *   这里把控件下移一个 Header 的高度 ⇒ 控件不会被 Header 遮成「看不见也点不到」。
 * 与左上角实时数据栏、顶部道路分级条用的是同一套避让规则（calc(var(--header-h) + ...)）。 */
.l7-control-container .l7-top.l7-right.l7-column {
  top: var(--header-h);
}

.mapboxgl-ctrl-attrib-inner {
  display: none;
}

/* 要素详情气泡：原为 frame3.png 白框 + rgba(255,255,255,.3) 底 + 白字（白字白底不可读），
 * 统一改成白色卡片 + 深色文字，与全站亮色皮肤一致。 */
.mapboxgl-popup .mapboxgl-popup-content {
  background: var(--bg-panel) !important;
  color: var(--text) !important;
  padding: 14px 16px !important;
  border-radius: var(--radius) !important;
  border: 1px solid var(--border) !important;
  box-shadow: var(--shadow-lg) !important;
  font-size: 12px !important;
  line-height: 1.7 !important;
}

.mapboxgl-popup {
  background: none !important;
  max-width: 300px !important;
}

/* popup 箭头跟随卡片底色（默认是白的，只有深色主题才需要改） */
.mapboxgl-popup-anchor-top .mapboxgl-popup-tip,
.mapboxgl-popup-anchor-bottom .mapboxgl-popup-tip,
.mapboxgl-popup-anchor-left .mapboxgl-popup-tip,
.mapboxgl-popup-anchor-right .mapboxgl-popup-tip {
  border-color: var(--bg-panel) !important;
}

.mapboxgl-popup-content__panel {
  font-size: 12px !important;
}

/* 关闭按钮：原样式把 svg 整体 display:none 藏掉了关闭按钮，改为只隐藏默认的大图标、
 * 用文字 × 替代，保证每个气泡都能关。 */
.mapboxgl-popup svg {
  display: none !important;
}

.mapboxgl-popup-close-button {
  right: 6px !important;
  top: 4px !important;
  width: 18px !important;
  height: 18px !important;
  font-size: 16px !important;
  line-height: 1 !important;
  color: var(--text-mute) !important;
  border-radius: 50% !important;
}

.mapboxgl-popup-close-button:hover {
  background: var(--danger-soft) !important;
  color: var(--danger) !important;
}

.mapboxgl-popup .mapboxgl-popup-content b {
  color: var(--primary);
}

/* 导航起终点控件：原来 left:1% 正好落在实时数据栏底下，两个输入框的中心点到的都是 .rt-panel，
 * 点不开、输不进（CDP 巡检量到重叠 20124px²）。改到栏右侧的安全区里。
 * 用 left 而不是 right 让位：这个控件规划出路线后会向下长高，横向位置必须一次定死。 */
.mapboxgl-ctrl-directions {
  position: fixed;
  top: 10%;
  left: var(--rt-clear);
}

/* ===== 动态车辆 marker（vehicleSim 生成的 DOM） =====
 * 外层 transform 由 mapbox 定位接管（inline），样式里不能动；旋转只作用于内层 .vm-inner。
 * 因此「选中放大」绝不能用 transform: scale()（每 300ms 被 tick 的 rotate 覆盖），
 * 改用 svg 的 width/height 变化，光环用 ::before。 */
.vehicle-marker {
  position: relative;
  cursor: pointer;
  line-height: 1;
  /* ★ 车辆专属色：--vm-color 由 buildMarker 内联写在根节点上。
   * color 供车身 SVG 的 fill="currentColor" 使用，徽标背景用 var(--vm-color)，
   * 两者同源 —— 列表徽标与地图 marker 的编号/颜色因此一一对应。 */
  color: var(--vm-color, #1769e0);
}

/* 车辆图标：俯视车形 SVG，fill 取 --vm-color（每辆车专属色，与左侧列表徽标同源） */
.vehicle-marker .vm-inner {
  display: block;
  transform-origin: center center;
}

.vehicle-marker .vm-inner svg {
  display: block;
  width: 22px;
  height: 22px;
  transition: width 0.15s ease, height 0.15s ease, filter 0.3s;
  filter: drop-shadow(0 1px 2px rgba(16, 24, 40, 0.35));
}

/* 红灯等待中的车辆泛红光 */
.vehicle-marker.vm-waiting .vm-inner svg {
  filter: drop-shadow(0 0 5px var(--danger));
}

/* 编号徽标：与左侧列表行徽标同编号、同颜色，是「认清是哪辆车」的主要视觉锚点 */
.vehicle-marker .vm-badge {
  position: absolute;
  top: -7px;
  left: 13px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  box-sizing: border-box;
  border-radius: 8px;
  font-size: 9px;
  line-height: 15px;
  font-weight: 700;
  font-style: normal;
  text-align: center;
  color: #fff;
  background: var(--vm-color, #1769e0);
  border: 1px solid #fff;
  box-shadow: 0 1px 3px rgba(16, 24, 40, 0.3);
  pointer-events: none; /* 徽标不吃点击，否则会缩小 marker 的点击热区 */
}

/* 选中 / 悬停：置顶 + 放大 + 发光 */
.vehicle-marker.vm-focus,
.vehicle-marker.vm-hover {
  z-index: 5;
}

.vehicle-marker.vm-focus .vm-inner svg,
.vehicle-marker.vm-hover .vm-inner svg {
  width: 32px;
  height: 32px;
  filter: drop-shadow(0 0 8px var(--vm-color, #1769e0));
}

/* 选中态的呼吸光环（悬停不加光环，避免满屏闪） */
.vehicle-marker.vm-focus::before {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 46px;
  height: 46px;
  margin: -23px 0 0 -23px;
  border: 2px solid var(--vm-color, #1769e0);
  border-radius: 50%;
  animation: vm-pulse 1.4s ease-out infinite;
  pointer-events: none;
}

@keyframes vm-pulse {
  0% {
    transform: scale(0.45);
    opacity: 0.95;
  }
  100% {
    transform: scale(1.15);
    opacity: 0;
  }
}

/* 车辆气泡标题里的编号小徽标 */
.mapboxgl-popup .vm-popup-no {
  display: inline-block;
  min-width: 15px;
  height: 15px;
  margin-right: 5px;
  border-radius: 8px;
  font-size: 10px;
  line-height: 15px;
  font-style: normal;
  text-align: center;
  color: #fff;
  vertical-align: 1px;
}
</style>
