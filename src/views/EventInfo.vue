<template>
    <div>
      <div class="displayCard" v-show="data.tableData.length">
        <el-table @row-click="tableClick" height="220" :data="data.tableData" size="small">
          <el-table-column prop="event_num" label="编号" />
          <el-table-column prop="name" label="事故类型" />
          <el-table-column prop="area" label="事故区域" />
          <el-table-column prop="car_num" label="车牌号" />
          <el-table-column prop="level" label="事故等级" />
        </el-table>
      </div>
      <el-card class="box-card">
        <el-button @click="toDraw" type="primary">拉框查询</el-button>
      </el-card>
    </div>
  </template>
  <script setup>
  import { PointLayer } from "@antv/l7";
  import { reactive, onUnmounted } from "vue";
  import { useMapReady } from "../Hooks/useMapReady";
  import { DrawRect, DrawEvent } from "@antv/l7-draw";
  import * as turf from "@turf/turf";
  import { ElMessage } from "element-plus";
  // 事件数据改读 SQL Server（store.dbData.events），增删改后与数据管理面板共享同一来源
  import { pointFC } from "../tools/dbAdapter";
  import { store } from "../store";
  let map, scene, pointLayer, draw;
  const data = reactive({
    tableData: [],
  });
  
  onUnmounted(() => {
    // 框还没拉完就离开页面时 draw 仍在，同样要把地图状态还原回去
    if (draw) {
      draw.destroy();
      draw = null;
    }
    if (scene) restoreMapStatus();
    if (pointLayer) {
      scene.removeLayer(pointLayer);
      pointLayer = null;
    }
  });
  
  const tableClick = (e) => {
    map.flyTo({
      center: e.xy,
      zoom: 17,
      pitch: 0,
    });
  };
  
  // l7-draw 的 destroy() 不还原它 enable() 时改过的地图状态：drag 模式下会关掉 dragPan，
  // 不手动还原的话，拉完一次框地图就再也拖不动了（双击缩放同理）。
  const restoreMapStatus = () => {
    scene.setMapStatus({ dragEnable: true, doubleClickZoom: true });
  };

  const toDraw = () => {
    if (pointLayer) {
      scene.removeLayer(pointLayer);
      pointLayer = null;
    }
    data.tableData = [];
    // 拉框查询就是「框哪查哪」，按下拖出矩形、松开即出结果，比默认的两点点选直观
    draw = new DrawRect(scene, { trigger: "drag" });
    draw.on(DrawEvent.Add, (e) => {
      draw.destroy();
      draw = null;
      restoreMapStatus();
      toSearch(e);
    });
    draw.enable();
  };
  
  const toSearch = (e) => {
    const evRows = (store.dbData && store.dbData.events) || [];
    if (!evRows.length) {
      ElMessage.warning("数据库暂无事件记录：请先启动数据服务（pnpm server）并执行 db/seed.sql 入库");
      return;
    }
    let arr = [];
    // DB 行 → 事件 FeatureCollection（列名已按图层口径适配）
    pointFC("events", evRows).features.forEach((item) => {
      if (turf.booleanPointInPolygon(item, e)) {
        arr.push(item);
        item.properties.xy = item.geometry.coordinates;
        data.tableData.push(item.properties);
      }
    });
    if (arr.length > 0) {
      pointLayer = new PointLayer()
        .source(turf.featureCollection(arr)) //数据源  跟mapbox不一样 它只能放要素集合
        .shape("circle")
        .active(true)
        .animate(true)
        .size(70)
        .color("red");
      scene.addLayer(pointLayer);
    } else {
      ElMessage.info("没有查询到信息");
    }
  };
  
  // 地图就绪后再取实例：直接刷新时 onMounted 里还是 null
  useMapReady().onReady((m, s) => {
    map = m;
    scene = s;
  });
  </script>
      <style scoped>
  .box-card {
    position: absolute;
    right: 8px;
    top: 15%;
    /* 原来是裸的 999，收敛到 --z-modal(100)：仍高于数据管理面板(96)，但不参与 1000+ 的弹窗层 */
    z-index: var(--z-modal);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow);
  }

  /* 拉框查询按钮卡片：原来靠 --el-card-bg-color 塞了层半透明紫，白卡片上直接留白即可 */
  .el-card {
    --el-card-bg-color: var(--bg-panel);
    --el-card-border-color: var(--border);
  }

  .displayCard {
    width: 32%;
    display: flex;
    justify-content: center;
    position: absolute;
    /* 原来 left:1% 与左上「实时数据栏」(left:1% + 172px，z-index 46) 完全重叠，
     * 结果表格会被实时栏压住。右移到实时栏之外（与 --g2-left-x 同源）。 */
    left: var(--g2-left-x);
    top: 11%;
    outline: none;
    color: var(--text);
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  :deep(.el-table) {
    --el-table-border-color: var(--border);
    background-color: transparent;
  }

  :deep(.el-table tr) {
    background-color: transparent;
    color: var(--text);
    cursor: pointer;
  }

  :deep(.el-table th.el-table__cell) {
    background-color: var(--bg-sub);
    color: var(--text-sub);
  }

  :deep(.el-table tr:hover) {
    background-color: var(--bg-hover);
  }

  :deep(.el-table--enable-row-transition .el-table__body td.el-table__cell) {
    background-color: transparent;
  }
  
  :deep(.el-table th.el-table__cell) {
    background-color: transparent;
  }
  
  :deep(.el-table td.el-table__cell) {
    border-bottom: none;
  }
  

