<template>
  <div class="footer">
    <div class="btn-groups">
      <!-- 平铺排列：视图 → 控制 → 查询工具 → 风格（无分隔线） -->
      <RouterLink to="/" @click="reset()">
        <div class="item">
          <button class="toggle-btn">
            <i class="iconfont icon-shouye-copy"></i>
          </button>
          <p>首页</p>
        </div>
      </RouterLink>
      <RouterLink to="/rotation">
        <div class="item">
          <button class="toggle-btn">
            <i class="iconfont icon-fuwudiqiu"></i>
          </button>
          <p>地球自转</p>
        </div>
      </RouterLink>
      <RouterLink to="/cityview">
        <div class="item">
          <button class="toggle-btn">
            <i class="iconfont icon-icon-test"></i>
          </button>
          <p>城市视角</p>
        </div>
      </RouterLink>
      <!-- 控制中心：开关式浮层（点其它按钮不关闭，再点本按钮才关闭） -->
      <div class="item" :class="{ on: store.chartsOpen }" @click="toggleCharts">
        <button class="toggle-btn">
          <i class="iconfont icon-supervision-full"></i>
        </button>
        <p>控制中心</p>
      </div>
      <!-- 数据管理：开关式浮层，SQL Server 业务表增删改查（写库后地图图层实时刷新） -->
      <div class="item" :class="{ on: store.dataPanelOpen }" @click="store.dataPanelOpen = !store.dataPanelOpen">
        <button class="toggle-btn">
          <i class="iconfont icon-ziliaoku"></i>
        </button>
        <p>数据管理</p>
      </div>
      <el-popover placement="top" :width="140" trigger="click" popper-class="tool-popover">
        <template #reference>
          <div class="item">
            <button class="toggle-btn">
              <i class="iconfont icon-ruler"></i>
            </button>
            <p>地图测量</p>
          </div>
        </template>
        <div class="popover-w">
          <RouterLink v-for="(item, index) in tools" :key="index" :to='"/mapdraw/" + item' class="popover-tool">
            <i :class="computeClass(item)"></i>
            <p>{{ toolName[index] }}</p>
          </RouterLink>
        </div>
      </el-popover>
      <RouterLink to="/eventinfo">
        <div class="item">
          <button class="toggle-btn">
            <i class="iconfont icon-shouye-copy"></i>
          </button>
          <p>拉框查询</p>
        </div>
      </RouterLink>
      <RouterLink to="/areasearch">
        <div class="item">
          <button class="toggle-btn">
            <i class="iconfont icon-quyusousuo"></i>
          </button>
          <p>区域搜索</p>
        </div>
      </RouterLink>
      <RouterLink to="/navigation">
        <div class="item">
          <button class="toggle-btn">
            <i class="iconfont icon-daohang"></i>
          </button>
          <p>导航</p>
        </div>
      </RouterLink>
      <!-- 切换风格：点一下进入风格页可切换；在风格页再点一下即关闭退出 -->
      <div class="item" :class="{ on: styleOpen }" @click="toggleStyle">
        <button class="toggle-btn">
          <i class="iconfont icon-tucengfengge"></i>
        </button>
        <p>切换风格</p>
      </div>
      <!-- 交通大屏：全屏浮层开关（点其它按钮不关闭，再点本按钮才关闭）。
           ★ 必须追加在 .btn-groups 末尾：cdp-click-test / cdp-fuzz 里有按序号硬编码的按钮表，
           插在中间会让它们全部错位。
           图标用 icon-gaikuang（屏幕里一条折线图），语义就是"可视化大屏"。原先用的
           icon-tubiaozhizuomobanzhuanqu-02 虽字形存在，但放大复核（scripts/cdp-icon-grid.mjs）
           发现它画的是**购物车** —— 字形存在 ≠ 语义正确。 -->
      <div class="item" :class="{ on: store.screenOpen }" @click="store.screenOpen = !store.screenOpen">
        <button class="toggle-btn">
          <i class="iconfont icon-gaikuang"></i>
        </button>
        <p>交通大屏</p>
      </div>
    </div>
  </div>
</template>
<script setup>
import { RouterLink, useRoute, useRouter } from "vue-router";
import { computed, inject } from "vue";
// 坑1修复：注入的是 App.vue setup 同步创建的 reactive 容器，mounted 时可能尚未赋值，
// 使用时统一取 sm.map / sm.scene（地图就绪后必有值）
const sm = inject("$scene_map");
const { store } = inject("$store");
const reset = () => {
  const map = sm.map;
  if (!map) return;
  map.setCenter([118.05, 36.81]);
  map.setZoom(9.5);
  map.setPitch(0);
};
// 控制中心浮层开关：再点一次才关闭，点其它按钮不关闭
const toggleCharts = () => {
  store.chartsOpen = !store.chartsOpen;
};
// 切换风格开关：进入风格页可点选；已在风格页时再点一次即关闭退出
const route = useRoute()
const router = useRouter()
const styleOpen = computed(() => route.path === '/changestyle')
const toggleStyle = () => {
  router.push(styleOpen.value ? '/' : '/changestyle')
};
const computeClass = (item) => {
  // 交通图层名 → 实际 iconfont 类名（iconfont 无同名图标，做近似映射）
  const ICON_MAP = {
    camera: 'supervision-full', trafficLight: 'icon-test', police: 'shouye-copy',
    busRoute: 'daohang', congestion: 'daolu', heat: 'paint', busStop: 'shoucang'
  }
  return "iconfont query-item icon-" + (ICON_MAP[item] || item);
};
const toolName = ['多边形','矩形','圆形','线']
const tools = ["drawPolygonTool", "drawRectTool", "drawCircleTool", "line"];
</script>
<style>
/* ===== 底部工具栏：白色悬浮胶囊 + 分组 + 方形圆角按钮 =====
 * 原为藏青玻璃 + 圆形发光按钮 + 9px 标签，在亮底图上像贴了块黑胶带。 */
.footer {
  position: fixed;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  z-index: var(--z-footer);
  display: flex;
  align-items: center;
  padding: 6px 14px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: var(--shadow-lg);
}

.btn-groups {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
}

.btn-groups .item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 3px 5px;
  border-radius: var(--radius);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}

.btn-groups .item:hover {
  background: var(--bg-hover);
}

.btn-groups .item p {
  margin: 0;
  font-size: 11px;
  color: var(--text-sub);
  line-height: 1;
  white-space: nowrap;
}

.btn-groups button {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: none;
  outline: none;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  color: var(--text-sub);
  background: transparent;
  transition: background 0.15s, color 0.15s;
}

.btn-groups .item:hover button {
  cursor: pointer;
  color: var(--primary);
}

/* 开关型按钮（控制中心 / 切换风格）点亮态 */
.btn-groups .item.on {
  background: var(--primary-soft);
}

.btn-groups .item.on button {
  color: var(--primary);
}

.btn-groups .item.on p {
  color: var(--primary);
  font-weight: 600;
}

a {
  text-decoration: none;
  color: var(--text-sub);
}

.el-button+.el-button {
  margin-left: 8px;
}

.popover-w {
  display: flex;
  align-items: center;
  justify-content: space-around;
}

/* 测量工具下拉项：原为行内 style + 5px 字号（小到读不出），改为卡片内的图标按钮 */
.popover-tool {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 6px 10px;
  border-radius: var(--radius);
  color: var(--text-sub);
  transition: background 0.15s, color 0.15s;
}

.popover-tool i {
  font-size: 16px;
}

.popover-tool p {
  font-size: 11px;
  line-height: 1;
}

.popover-tool:hover {
  background: var(--bg-hover);
  color: var(--primary);
}

/* el-popover 是 teleport 到 body 的，必须用 popper-class + 非 scoped 样式才能命中 */
.tool-popover.el-popover.el-popper {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  color: var(--text);
  padding: 6px;
  min-width: auto;
}

.tool-popover.el-popover.el-popper .el-popper__arrow::before {
  background: var(--bg-panel);
  border-color: var(--border);
}

/* 查询下拉里的图标项：hover 用主色淡底（原来是深蓝渐变，在白卡片上很脏） */
.query-item {
  color: var(--text-sub);
}

.query-item:hover {
  cursor: pointer;
  background: var(--primary-soft);
  color: var(--primary);
}
</style>
