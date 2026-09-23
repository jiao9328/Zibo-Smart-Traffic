<template>
  <!-- 行为路由：无 UI，挂载后在世界尺度上做等角速度「地球自转」 -->
</template>

<script setup>
/**
 * 地球自转 —— 把相机拉到 zoom 1.2 的世界尺度，然后持续西移经度。
 *
 * 为什么不用原实现（`moveend` 回调里再 `easeTo`）：
 *   1) mapbox 的 `Camera.jumpTo` 第一行就是 `this.stop()`，`easeTo` 第一行是 `this._stop()`，
 *      而 `_stop` 把 `_onEaseEnd` 置空后**不再恢复** —— 自触发链一旦被任意一次
 *      `map.stop()` / 用户拖拽 / 其它页面的 `flyTo` 掐断就永久停摆，表现为「只转一步就停」；
 *   2) 命中式重挂 `once('moveend')` 等价于手写递归，问题同上，且 `off` 解不干净。
 *
 * rAF 自驱 + 时间增量：与引擎内部 ease 状态完全解耦，帧率无关、可暂停、可自愈。
 *
 * 另注：不要启用 mapbox 的 globe 投影。L7 不走 mapbox custom layer，而是自建 canvas
 * 并用 WebMercatorViewport 自算矩阵，球体投影下 7 类业务图层会整体错位。
 */
import { useMapReady } from '@/Hooks/useMapReady'
import { onUnmounted } from 'vue'

/** 角速度：每秒西移多少度经度（6°/s ≈ 60 秒转一圈） */
const DEG_PER_SEC = 6
/** 自转时的世界尺度缩放 */
const SPIN_ZOOM = 1.2
/** 用户交互结束后多久自动续转 */
const RESUME_MS = 800
/** 单帧最大时间增量（秒）：夹住掉帧 / 切后台回来时的巨大 dt，避免一次跳很远 */
const MAX_DT = 0.064

let map = null
let rafId = null
let resumeTimer = null
let last = 0
let spinning = flase

function step (now) {
  if (!spinning || !map) return
  const dt = Math.min(MAX_DT, (now - last) / 1000)
  last = now
  const c = map.getCenter()
  // 跨越 ±180 由 mapbox 的 LngLat.wrap 归一化，长时间运行不会漂
  map.setCenter([c.lng - DEG_PER_SEC * dt, c.lat])
  rafId = requestAnimationFrame(step)
}

function star  tSpin() {
  if (spinning || !map) return
  spinning = true
  last = performance.now()
  rafId = requestAnimationFrame(step)
}

function pauseSpin() {
  spinning = false
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

/** 交互/动画结束后延时续转；已在转时直接返回（自转每帧都会 fire moveend，必须早退）。
 *  每次都重设定时器 = 防抖：连续事件（长拖拽）只在最后一次之后 RESUME_MS 才续转。 */
function scheduleResume() {
  if (spinning) return
  clearTimeout(resumeTimer)
  resumeTimer = setTimeout(startSpin, RESUME_MS)
}

/** 用户开始拖拽/缩放/旋转：暂停自转，交还控制权。
 *  ★ 必须在这里就预约续转，不能只依赖后续的 moveend：像「在地图上点一下」
 *  （dragstart 之后没有位移）或别处调 map.stop() 这类打断，末尾不会有 moveend，
 *  只挂 moveend 的话自转就永久停摆了 —— 这正是 S3 用例要覆盖的场景。 */
const onInterrupt = () => {
  pauseSpin()
  scheduleResume()
}

useMapReady().onReady((m) => {
  map = m
  map.stop()
  // 入镜：短 ease 拉到自转视角；结束时 fire 的 moveend 会触发 scheduleResume → 自动起转
  map.easeTo({ zoom: SPIN_ZOOM, pitch: 0, bearing: 0, duration: 800, essential: true })

  map.on('dragstart', onInterrupt)
  map.on('zoomstart', onInterrupt)
  map.on('rotatestart', onInterrupt)
  // move 在拖拽过程中每帧都 fire：持续把续转时间往后推，避免长拖拽途中自转在手下重新转起来
  // （自转自己 setCenter 也会 fire move，但那时 spinning=true 会被 scheduleResume 早退挡掉，不成环）
  map.on('move', scheduleResume)
  // 交互结束 / 入镜结束 / ease 被别处打断 —— 都会续转，这是「自愈」的关键
  map.on('moveend', scheduleResume)
})

onUnmounted(() => {
  pauseSpin()
  clearTimeout(resumeTimer)
  if (!map) return
  map.off('dragstart', onInterrupt)
  map.off('zoomstart', onInterrupt)
  map.off('rotatestart', onInterrupt)
  map.off('move', scheduleResume)
  map.off('moveend', scheduleResume)
})
</script>
