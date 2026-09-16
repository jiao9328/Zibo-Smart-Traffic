/**
 * 地图就绪回调 —— 统一修复「直接刷新 / 直接输网址时 map 为 null」的竞态。
 *
 * 背景：App.vue 在 setup 里**同步** provide 了响应式容器 `reactive({ scene, map })`，
 * 但实例是在 mapbox 的 'load' 之后（boot()）才写进去的。而 Vue3 子组件的 onMounted
 * 早于父组件 App 的 onMounted，懒加载路由 chunk 又是本地秒回 —— 直接刷新时子组件
 * mounted 那一刻 `sm.map` 还是 null，裸调 `map.xxx` 必抛 TypeError，功能静默失效。
 *
 * 用法：
 *   const { onReady } = useMapReady()
 *   onReady((map, scene) => { map.flyTo(...) })   // 已就绪立即执行；否则等容器赋值
 *
 * @returns {{ onReady: (cb: (map:any, scene:any)=>void) => (()=>void) }}
 */
import { inject, onUnmounted, watch } from 'vue'

export function useMapReady() {
  const sm = inject('$scene_map')
  /** 等待中的回调；容器赋值后一次性全部执行 */
  const pending = []
  let stopWatch = null

  const isReady = () => !!(sm && sm.map)

  const run = (cb) => {
    try {
      cb(sm.map, sm.scene)
    } catch (e) {
      console.error('[useMapReady] 就绪回调执行失败：', e)
    }
  }

  const flush = () => {
    const cbs = pending.splice(0)
    for (const cb of cbs) run(cb)
    if (stopWatch) {
      stopWatch()
      stopWatch = null
    }
  }

  /**
   * 注册「地图就绪」回调。
   * @param {(map:any, scene:any)=>void} cb 地图可用时调用（可能同步、可能异步）
   * @returns {() => void} 取消注册
   */
  const onReady = (cb) => {
    if (isReady()) {
      /* 已就绪也必须异步回调。调用方一律把 onReady 写在 setup 中段，而回调里要用的
       * searchCity / applyStyleFromQuery 这类函数是 setup 后段的 const —— 同步回调会撞上
       * TDZ（ReferenceError: Cannot access 'x' before initialization），还会被下面的 catch
       * 吞成一行 console.error。表现极具迷惑性：整页刷新（地图未就绪 → 走 watch 那条异步
       * 路径）一切正常，SPA 跳进来（地图已就绪）却静默什么都不发生 —— 区域搜索的
       * ?area= / 换风格的 ?style= 都是这么失效的。微任务与 flush() 那条路径时机一致。 */
      Promise.resolve().then(() => run(cb))
      return () => {}
    }
    pending.push(cb)
    // 只挂一个 watch，避免每个调用方各挂一个
    if (!stopWatch) {
      stopWatch = watch(sm, () => {
        if (isReady()) flush()
      })
    }
    return () => {
      const i = pending.indexOf(cb)
      if (i >= 0) pending.splice(i, 1)
    }
  }

  onUnmounted(() => {
    pending.length = 0
    if (stopWatch) {
      stopWatch()
      stopWatch = null
    }
  })

  return { onReady }
}
