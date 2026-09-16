<template></template>
<script setup>
import { onUnmounted } from "vue";
import { useRoute, onBeforeRouteUpdate } from "vue-router";
import { DrawPolygon, DrawRect, DrawCircle, DrawLine } from "@antv/l7-draw";
import { useMapReady } from "../Hooks/useMapReady";
let map, scene, type, draw;
const route = useRoute();
type = route.params.type;
// 地图就绪后再建绘制控件：直接刷新时 scene 还是 null，new DrawXxx(null) 必抛
useMapReady().onReady((m, s) => {
  map = m;
  scene = s;
  initDraw();
});

onBeforeRouteUpdate((to) => {
  type = to.params.type;
  initDraw();
});

// l7-draw 的 destroy() 只销毁图层和事件监听，**不还原**它自己在 enable() 里改过的地图状态
// （见 base-mode.js destroy 无 unbindEnableEvent）：
//   trigger:'click' → doubleClickZoom:false（双击缩放从此失效，此前就有这个遗留）
//   trigger:'drag'  → dragPan:false（整张地图拖不动，更严重）
// 所以每次销毁后都得手动还原。不能用 draw.disable() 代替：disable 会顺手 resetFeatures()，
// 把测量出来的图形一起清掉，而图形是要留着读数的。
const restoreMapStatus = () => {
  scene?.setMapStatus({ dragEnable: true, doubleClickZoom: true });
};

const initDraw = () => {
  if (!scene) return // 地图未就绪时的 onBeforeRouteUpdate
  if (draw) {
    draw.destroy();
    draw = null;
    restoreMapStatus();
  }
  // 矩形/圆形的几何只由两个对角点决定，「按下—拖—松开」一把画完最顺手，
  // 所以给 trigger:'drag'（默认 'click' 要点两下）。多边形/线需要任意个节点，
  // 只能保持逐点点选。
  // 注：drag 模式下 l7-draw 会关掉地图拖拽，避免画框时地图跟着跑（这正是想要的）。
  if (type == "drawPolygonTool") {
    draw = new DrawPolygon(scene, {
      areaOptions: {},
      distanceOptions: {},
    });
  } else if (type == "drawRectTool") {
    draw = new DrawRect(scene, {
      trigger: "drag",
      areaOptions: {},
      distanceOptions: {},
    });
  } else if (type == "drawCircleTool") {
    draw = new DrawCircle(scene, {
      trigger: "drag",
      areaOptions: {},
      distanceOptions: {},
    });
  } else if (type == "line") {
    draw = new DrawLine(scene, {
      distanceOptions: {},
    });
  }
  if (draw) draw.enable();
};

onUnmounted(() => {
  if (draw) {
    draw.destroy();
    draw = null;
    restoreMapStatus();
  }
});
</script>
<style>
</style>
