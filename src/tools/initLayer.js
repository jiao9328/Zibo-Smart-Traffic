import roadData from '../assets/GIS_Data/Zibo_roads.json'
import cityData from '../assets/GIS_Data/Zibo_Buildings.json'

import { LineLayer,CityBuildingLayer } from '@antv/l7';

/**
 * 基础图层实例注册表。
 * 坑：L7 2.15 的 scene.getLayerByName 查的是内部数字 id，构造选项里的 id 查不到，
 * 统一按本表取实例（initTrafficLayers / roadClassLayers / Home 共用）
 */
export const baseLayerMap = {}

export default (scene) => {
    const road_layer = new LineLayer({
        id: '淄博道路',
    })
    road_layer.source(roadData)
        .size(0.7) // 全路网是最密的一层（含支路），1px 在亮底图上糊成一片蓝雾；0.7px 才透得出底图
        .shape('line')
        .color('#1990FF')
        .animate({
            interval: 1,  //流线长度
            trailLength: 2, //流线间隔
            duration: 2 //执行时间
        })
    scene.addLayer(road_layer)
    baseLayerMap['淄博道路'] = road_layer

    const building_layer = new CityBuildingLayer({
        id: '淄博市',
    })
    building_layer
    .source(cityData)
    .size('Elevation', (h)=>h)
    /* ★ 用户 2026-09-15 第 8 条「删除大屏从中间一直向外扩散的动画效果」：
     *   指的就是下面这圈以 sweepCenter 为圆心、半径随时间往外推的光环。
     *   L7 里它是 `u_circleSweep = sweep.enable ? 1 : 0`、半径吃 `animate(true)` 喂的
     *   layer 动画时间（读 node_modules/@antv/l7 的 city 片元 uniform 定的）。
     *   所以两个都得去掉 —— 只删 sweep 块、留着 animate(true) 的话，
     *   u_time 还在走，建筑窗光仍会周期性闪（默认 sweep 是 enable:false，本就无环）。
     *   去掉后建筑是静态灯光，交互高亮（.active）不受影响。 */
    .active({
      color: '#0ff',
      mix: 0.5
    })
    .style({
      opacity: 0.7,
      baseColor: 'rgb(16, 16, 16)',
      windowColor: 'rgb(30, 60, 89)',
      brightColor: 'rgb(255, 176, 38)'
    });
  scene.addLayer(building_layer);
  baseLayerMap['淄博市'] = building_layer

  /* DEV 调试桥：CDP 验证要直接读这两个实例（scene.getLayers() 拿不到构造时的 id ——
   * L7 会把 layer.id 覆写成它在场景里的数字序号，'淄博道路'/'淄博市' 只在 baseLayerMap 里）。
   * 生产构建里没有这个字段。 */
  if (import.meta.env.DEV) {
    window.__base = { map: baseLayerMap, get: (id) => baseLayerMap[id] || null }
  }
}