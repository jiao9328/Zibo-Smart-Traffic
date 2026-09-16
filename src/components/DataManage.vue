<template>
  <div class="dm-panel">
    <!-- 标题栏 -->
    <div class="dm-head">
      <div class="dm-title"><i class="iconfont icon-ziliaoku"></i> 数据管理 <span class="dm-sub">SQL Server · ZiboSmartTraffic</span></div>
      <div class="dm-head-right">
        <span class="dm-state" :class="'s-' + store.dbStatus">
          <i class="dm-dot"></i>{{ stateText }}
        </span>
        <el-button size="small" text bg class="dm-re" @click="retry" :loading="store.dbStatus === 'loading'">
          重连
        </el-button>
        <el-button size="small" text bg class="dm-close" @click="store.dataPanelOpen = false">✕ 关闭</el-button>
      </div>
    </div>

    <!-- 后端/数据库异常提示 -->
    <el-alert v-if="store.dbStatus === 'fail'" type="error" :closable="false" class="dm-alert">
      数据库服务未连接：{{ store.dbError }} —— 请先启动后端（pnpm server）并在 SSMS 执行 db/setup.sql、db/seed.sql
    </el-alert>

    <!-- 表签（增删改 → 写库 → 重取该表 → 重建对应地图图层） -->
    <el-tabs v-model="active" class="dm-tabs" :before-leave="beforeLeave">
      <el-tab-pane v-for="tab in TABS" :key="tab.t" :name="tab.t">
        <template #label>
          <span class="dm-tablabel">{{ tab.label }} <em v-if="rowsOf(tab.t).length">{{ rowsOf(tab.t).length }}</em></span>
        </template>
      </el-tab-pane>
    </el-tabs>

    <!-- 表格区 -->
    <div class="dm-body">
      <el-table :data="rowsOf(active)" size="small" height="100%" v-loading="busy" row-key="id">
        <el-table-column v-for="c in activeTab.cols" :key="c.p" :prop="c.p" :label="c.l" :width="c.w" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="c.s" class="dm-chip" :style="{ color: fmtCell(row, c).c }">
              <i class="dm-chip-dot" :style="{ background: fmtCell(row, c).c }"></i>{{ fmtCell(row, c).t }}
            </span>
            <span v-else-if="c.p === 'color'" class="dm-swatch" :style="{ background: row.color }"></span>
            <span v-else>{{ row[c.p] }}</span>
          </template>
        </el-table-column>
        <el-table-column v-if="!activeTab.readonly" label="操作" :width="110" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="delRow(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 底部操作条 -->
    <div class="dm-foot">
      <span class="dm-foot-tip">
        <template v-if="activeTab.readonly">该表为只读展示数据（热力底图用），不支持增删改。</template>
        <template v-else>共 {{ rowsOf(active).length }} 条 · 新增/编辑后自动写库并刷新地图图层</template>
      </span>
      <el-button v-if="!activeTab.readonly" type="primary" size="small" @click="openCreate">＋ 新增{{ activeTab.label }}</el-button>
    </div>
  </div>

  <!-- 新增 / 编辑 弹层（非 modal，便于地图点选坐标 / 画线） -->
  <el-dialog v-model="dialog.show" :title="dialog.title" width="700px" class="dm-dialog" :close-on-click-modal="false" :append-to-body="true">
    <div v-if="dialog.show" class="dm-form">
      <div v-for="f in activeTab.fields" :key="f.k" class="dm-frow" :class="{ 'dm-frow-wide': f.k === 'geometry' || f.k === 'lng' }">
        <label class="dm-flabel">{{ f.l }}<i v-if="f.req" class="dm-req">*</i></label>
        <!-- 文本框 / 编号 -->
        <el-input v-if="f.kind === 'text'" v-model.trim="form[f.k]" :placeholder="f.ph" clearable />
        <!-- 数字 -->
        <el-input-number v-else-if="f.kind === 'num'" v-model="form[f.k]" :precision="f.dec || 0" :step="f.step || 1" controls-position="right" style="width: 100%" />
        <!-- 固定下拉（枚举，值即库里存的英文/数字） -->
        <el-select v-else-if="f.kind === 'sel'" v-model="form[f.k]" style="width: 100%">
          <el-option v-for="o in f.opts" :key="o.v" :label="o.l" :value="o.v" />
        </el-select>
        <!-- 可自填下拉（区县等：既可从库中选也可手输） -->
        <el-select v-else-if="f.kind === 'area'" v-model="form[f.k]" filterable allow-create default-first-option style="width: 100%" :placeholder="f.ph || '选择或输入'">
          <el-option v-for="a in areaOptions" :key="a" :label="a" :value="a" />
        </el-select>
        <!-- 可自填下拉（其它建议值） -->
        <el-select v-else-if="f.kind === 'tag'" v-model="form[f.k]" filterable allow-create default-first-option style="width: 100%" :placeholder="f.ph || '选择或输入'">
          <el-option v-for="o in f.opts" :key="o.v" :label="o.l" :value="o.v" />
        </el-select>
        <!-- 布尔开关（警员在勤） -->
        <div v-else-if="f.kind === 'bit'" class="dm-bitrow">
          <el-switch v-model="form[f.k]" />
          <span class="dm-bit-txt">{{ form[f.k] ? f.onTxt || '是' : f.offTxt || '否' }}</span>
        </div>
        <!-- 经纬度 + 地图点选 -->
        <div v-else-if="f.k === 'lng'" class="dm-coord">
          <el-input-number v-model="form.lng" :precision="6" :step="0.0001" controls-position="right" placeholder="经度" />
          <el-input-number v-model="form.lat" :precision="6" :step="0.0001" controls-position="right" placeholder="纬度" />
          <el-button size="small" type="warning" plain :disabled="picking" @click="startPick">地图点选</el-button>
        </div>
      </div>
      <!-- 公交线路几何：地图画线 -->
      <div v-if="active === 'bus_routes'" class="dm-frow dm-frow-wide">
        <label class="dm-flabel">线路走向<i class="dm-req">*</i></label>
        <div class="dm-draw">
          <el-button size="small" type="warning" plain :disabled="!!drawBusy" @click="startDraw">
            {{ form.geometry ? '重画线路' : '在地图画线' }}
          </el-button>
          <el-button v-if="form.geometry" size="small" text type="danger" @click="clearGeom">清除</el-button>
          <span class="dm-draw-tip">
            {{ drawBusy ? '左键逐点画线，双击 / 右键结束' : form.geometry ? `已绘制 ${form.geometry.coordinates.length} 个节点` : '未绘制' }}
          </span>
        </div>
      </div>
      <p class="dm-picktip" v-if="picking">点选模式：在地图上单击目标位置，坐标将回填到上方表单（可按 Esc 取消）</p>
    </div>
    <template #footer>
      <el-button size="small" @click="closeDialog">取 消</el-button>
      <el-button size="small" type="primary" :loading="saving" @click="save">保 存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
/**
 * 数据管理面板：SQL Server 业务数据的增删改查 UI（地图应用内浮层）
 *  - 8 张可编辑表 + 1 张只读表（heat_points），表签切换即时浏览
 *  - 新增/编辑：字段按服务端列白名单渲染表单；坐标支持「地图点选」，
 *    公交线路支持「地图画线」（l7-draw DrawLine，几何以 GeoJSON 文本入库）
 *  - 保存/删除：api 写库 → 重取该表 → store.dbData 替换 → refreshTrafficLayer 重建图层，
 *    控制中心图表（computed 读 store.dbData）同步刷新
 */
import { computed, inject, onUnmounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import mapboxgl from 'mapbox-gl'
import { DrawLine, DrawEvent } from '@antv/l7-draw'
import { store } from '../store'
import { api } from '../api'
import { refreshTrafficLayer, refreshVisibleTrafficLayers } from '../tools/initTrafficLayers'
import { DISTRICTS } from '../tools/generators'
import { PRIMARY, OK, WARN, DANGER } from '../tools/palette'

const sm = inject('$scene_map')
const map = () => sm.map

/* ---------- 表元信息（与服务端 server/index.js TABLES 白名单/枚举一一对应） ---------- */
const AREA_PH = '选择区县'
const LEVEL_OPTS = [1, 2, 3, 4].map((v) => ({ v, l: ['', '一般', '较大', '重大', '特别重大'][v] }))
const TABS = [
  {
    t: 'cameras', label: '监控探头', readonly: false,
    cols: [
      { p: 'cam_id', l: '编号', w: 110 }, { p: 'name', l: '名称', w: 170 }, { p: 'road', l: '道路', w: 130 },
      { p: 'status', l: '状态', w: 90, s: 1 }, { p: 'area', l: '区县', w: 90 }
    ],
    fields: [
      { k: 'cam_id', l: '设备编号', kind: 'text', req: true, ph: '如 CAM1001（建议新编号接续最大值）' },
      { k: 'name', l: '点位名称', kind: 'text', req: true, ph: '如 柳泉路人民路口东侧' },
      { k: 'road', l: '所在道路', kind: 'text', req: true, ph: '如 柳泉路' },
      { k: 'status', l: '运行状态', kind: 'sel', req: true, opts: [{ v: 'normal', l: '正常' }, { v: 'fault', l: '故障' }] },
      { k: 'area', l: '所属区县', kind: 'area', req: true, ph: AREA_PH },
      { k: 'lng', l: '经纬度', kind: 'coord', req: true }
    ]
  },
  {
    t: 'traffic_lights', label: '信号灯', readonly: false,
    cols: [
      { p: 'tl_id', l: '编号', w: 100 }, { p: 'state', l: '状态', w: 90, s: 1 }, { p: 'area', l: '区县', w: 90 },
      { p: 'lng', l: '经度', w: 100 }, { p: 'lat', l: '纬度', w: 100 }
    ],
    fields: [
      { k: 'tl_id', l: '设备编号', kind: 'text', req: true, ph: '如 TL101' },
      { k: 'name', l: '名称', kind: 'text', req: false, ph: '可选' },
      { k: 'state', l: '灯态', kind: 'sel', req: true, opts: [{ v: 'green', l: '绿灯' }, { v: 'red', l: '红灯' }, { v: 'yellow', l: '黄灯' }, { v: 'fault', l: '故障' }] },
      { k: 'area', l: '所属区县', kind: 'area', req: true, ph: AREA_PH },
      { k: 'lng', l: '经纬度', kind: 'coord', req: true }
    ]
  },
  {
    t: 'police', label: '警员', readonly: false,
    cols: [
      { p: 'pol_id', l: '编号', w: 100 }, { p: 'name', l: '姓名', w: 100 }, { p: 'badge', l: '警号', w: 110 },
      { p: 'district', l: '辖区', w: 90 }, { p: 'on_duty', l: '状态', w: 90, s: 1 }, { p: 'location', l: '位置描述', w: 180 }
    ],
    fields: [
      { k: 'pol_id', l: '警员编号', kind: 'text', req: true, ph: '如 POL100' },
      { k: 'name', l: '姓名', kind: 'text', req: true, ph: '如 张伟' },
      { k: 'badge', l: '警号', kind: 'text', req: true, ph: '如 鲁C104001' },
      { k: 'district', l: '所属区县', kind: 'area', req: true, ph: AREA_PH },
      { k: 'on_duty', l: '执勤状态', kind: 'bit', req: true, onTxt: '在勤', offTxt: '休班' },
      { k: 'location', l: '位置描述', kind: 'text', req: false, ph: '如 张店区金晶大道与新村路交叉口' },
      { k: 'lng', l: '经纬度', kind: 'coord', req: true }
    ]
  },
  {
    t: 'alerts', label: '实时警情', readonly: false,
    cols: [
      { p: 'alert_id', l: '编号', w: 130 }, { p: 'type', l: '类型', w: 100 }, { p: 'level', l: '级别', w: 80, s: 1 },
      { p: 'status', l: '处置状态', w: 90, s: 1 }, { p: 'area', l: '区县', w: 90 }, { p: 'road', l: '路段', w: 140 },
      { p: 'minutes_ago', l: '发生(分钟前)', w: 110 }, { p: 'car_num', l: '车牌', w: 110 }
    ],
    fields: [
      { k: 'alert_id', l: '警情编号', kind: 'text', req: true, ph: '如 JQ20260000' },
      { k: 'type', l: '警情类型', kind: 'tag', req: true, ph: '如 交通事故', opts: [{ v: '交通事故', l: '交通事故' }, { v: '交通管制', l: '交通管制' }, { v: '设备故障', l: '设备故障' }, { v: '道路施工', l: '道路施工' }, { v: '天气影响', l: '天气影响' }, { v: '交通违章', l: '交通违章' }] },
      { k: 'level', l: '警情级别', kind: 'sel', req: true, opts: LEVEL_OPTS },
      { k: 'status', l: '处置状态', kind: 'sel', req: true, opts: [{ v: 'handling', l: '处置中' }, { v: 'pending', l: '待处置' }] },
      { k: 'area', l: '所属区县', kind: 'area', req: true, ph: AREA_PH },
      { k: 'road', l: '事发路段', kind: 'text', req: false, ph: '如 柳泉路' },
      { k: 'minutes_ago', l: '发生时间(分钟前)', kind: 'num', req: true },
      { k: 'car_num', l: '涉事车牌', kind: 'text', req: false, ph: '如 鲁C·AB123（无则留空）' },
      { k: 'lng', l: '经纬度', kind: 'coord', req: true }
    ]
  },
  {
    t: 'events', label: '事件记录', readonly: false,
    cols: [
      { p: 'event_num', l: '编号', w: 120 }, { p: 'name', l: '事故类型', w: 100 }, { p: 'area', l: '区域', w: 90 },
      { p: 'level', l: '级别', w: 80, s: 1 }, { p: 'car_num', l: '车牌', w: 120 }, { p: 'phone', l: '联系电话', w: 130 }
    ],
    fields: [
      { k: 'event_num', l: '事件编号', kind: 'text', req: true, ph: '如 EV1001' },
      { k: 'name', l: '事故类型', kind: 'text', req: true, ph: '如 追尾' },
      { k: 'area', l: '所属区县', kind: 'area', req: true, ph: AREA_PH },
      { k: 'level', l: '事故级别', kind: 'sel', req: true, opts: LEVEL_OPTS },
      { k: 'car_num', l: '涉事车牌', kind: 'text', req: false, ph: '如 鲁C·AB123' },
      { k: 'phone', l: '联系电话', kind: 'text', req: false, ph: '如 13800000000' },
      { k: 'lng', l: '经纬度', kind: 'coord', req: true }
    ]
  },
  {
    t: 'congestion', label: '拥堵路段', readonly: false,
    cols: [
      { p: 'name', l: '路段', w: 160 }, { p: 'level', l: '程度', w: 90, s: 1 }, { p: 'avg_speed', l: '均速km/h', w: 100 },
      { p: 'flow', l: '流量指数', w: 90 }, { p: 'area', l: '区县', w: 90 }
    ],
    fields: [
      { k: 'name', l: '路段名', kind: 'text', req: true, ph: '如 柳泉路(人民路-华光路段)——需与本地路网匹配才可上图层' },
      { k: 'level', l: '拥堵程度', kind: 'sel', req: true, opts: [{ v: 0, l: '0 严重' }, { v: 1, l: '1 中度' }, { v: 2, l: '2 轻度' }] },
      { k: 'level_name', l: '程度名称', kind: 'text', req: true, ph: '选择程度后自动生成' },
      { k: 'avg_speed', l: '平均车速 km/h', kind: 'num', req: true },
      { k: 'flow', l: '流量指数', kind: 'num', req: true },
      { k: 'area', l: '所属区县', kind: 'area', req: true, ph: AREA_PH },
      { k: 'lng', l: '经纬度', kind: 'coord', req: true }
    ]
  },
  {
    t: 'bus_routes', label: '公交线路', readonly: false,
    cols: [
      { p: 'ref', l: '线路号', w: 80 }, { p: 'name', l: '线路名', w: 160 }, { p: 'dep_stop', l: '起点', w: 130 },
      { p: 'arr_stop', l: '终点', w: 130 }, { p: 'via', l: '途经站', w: 90 }, { p: 'color', l: '颜色', w: 70 }
    ],
    fields: [
      { k: 'ref', l: '线路号', kind: 'text', req: true, ph: '如 2路' },
      { k: 'name', l: '线路名', kind: 'text', req: true, ph: '如 2路(客运中心-公交东站)' },
      { k: 'dep_stop', l: '起点站', kind: 'text', req: true },
      { k: 'arr_stop', l: '终点站', kind: 'text', req: true },
      { k: 'via', l: '途经站数', kind: 'num', req: true },
      { k: 'color', l: '线路颜色', kind: 'text', req: true, ph: '如 #00bfff' },
      { k: 'geometry', l: '线路走向', kind: 'draw', req: true }
    ]
  },
  {
    t: 'bus_stops', label: '公交站点', readonly: false,
    cols: [
      { p: 'stop_id', l: '编号', w: 100 }, { p: 'name', l: '站点名', w: 200 }, { p: 'lng', l: '经度', w: 110 }, { p: 'lat', l: '纬度', w: 110 }
    ],
    fields: [
      { k: 'stop_id', l: '站点编号', kind: 'text', req: true, ph: '站点编号' },
      { k: 'name', l: '站点名称', kind: 'text', req: true, ph: '如 火车站(公交枢纽)' },
      { k: 'lng', l: '经纬度', kind: 'coord', req: true }
    ]
  },
  {
    t: 'heat_points', label: '热力点(只读)', readonly: true,
    cols: [
      { p: 'lng', l: '经度', w: 150 }, { p: 'lat', l: '纬度', w: 150 }, { p: 'value', l: '热力值', w: 120 }
    ],
    fields: []
  }
]

/* 表 → 地图图层（增删改后重建） */
const LAYER_BY_TABLE = {
  cameras: 'camera', traffic_lights: 'trafficLight', police: 'police',
  congestion: 'congestion', bus_routes: 'busRoute', bus_stops: 'busStop'
}

/* ---------- 显示格式化 ---------- */
/* 状态色统一取自 palette（原来写死 #22c55e/#ff3b30/#ffd60a/#94a3b8 等一套 Tailwind 色，
 * 和全站 token 的 --ok/--warn/--danger 不是同一组值，换肤后表格与卡片会对不上） */
const MUTE = '#8C9AB0'
const ORANGE = '#EF6820'
const STATUS_STYLE = {
  cameras: { normal: ['正常', OK], fault: ['故障', DANGER] },
  traffic_lights: { green: ['绿灯', OK], red: ['红灯', DANGER], yellow: ['黄灯', WARN], fault: ['故障', MUTE] },
  alerts: { handling: ['处置中', WARN], pending: ['待处置', MUTE] }
}
const boolStyle = (b) => (b ? ['在勤', OK] : ['休班', MUTE])
const LEVEL_STYLE = [
  ['', MUTE], ['一般', OK], ['较大', WARN], ['重大', ORANGE], ['特别重大', DANGER]
]
const levelStyle = (lv) => {
  const n = Number(lv)
  // 0 号是空级别（'lv' 为 0/空），落到兜底分支而不是显示成一个多余的行
  return n > 0 && LEVEL_STYLE[n] ? LEVEL_STYLE[n] : [String(lv), MUTE]
}
const congStyle = (lv) => {
  const n = Number(lv)
  return ['严重', '中度', '轻度'][n] ? [[n + ' 严重', DANGER], [n + ' 中度', ORANGE], [n + ' 轻度', WARN]][n] : [String(lv), MUTE]
}
const fmtCell = (row, col) => {
  const v = row[col.p]
  if (col.p === 'on_duty') return { t: boolStyle(!!v)[0], c: boolStyle(!!v)[1] }
  const st = STATUS_STYLE[activeTab.value?.t]
  if (st && st[v]) return { t: st[v][0], c: st[v][1] }
  if (col.p === 'level') return activeTab.value.t === 'congestion' ? congStyle(v) : levelStyle(v)
  // 兜底色是内联 style，写 var() 也一样生效；原来是 #fff（深色皮肤遗留），白卡片上会看不见
  return { t: String(v ?? ''), c: 'var(--text)' }
}

/* ---------- 面板状态 ---------- */
const active = ref('cameras')
const activeTab = computed(() => TABS.find((x) => x.t === active.value))
const busy = ref(false)
const rowsOf = (t) => store.dbData[t] || []
const stateText = computed(() =>
  ({ idle: '未连接', loading: '连接中…', ok: '数据库已连接', fail: '连接失败' })[store.dbStatus] || store.dbStatus)
const areaOptions = computed(() => {
  const ds = rowsOf('districts').map((d) => d.name)
  return (ds.length ? ds : DISTRICTS.map((d) => d.name))
})

/* 表签切换：有未完成的弹窗先拦截，避免表单与表签错位 */
const beforeLeave = () => {
  if (dialog.show) { ElMessage.warning('请先完成或取消当前的「' + activeTab.value.label + '」编辑弹窗'); return false }
  return true
}

/* ---------- 全量重连（失败恢复/手动刷新） ---------- */
const retry = async () => {
  store.dbStatus = 'loading'
  try {
    const data = await api.fetchMapData()
    for (const t of Object.keys(store.dbData)) {
      if (Array.isArray(data[t])) store.dbData[t] = data[t]
    }
    store.dbStatus = 'ok'
    refreshVisibleTrafficLayers()
    ElMessage.success('数据库已连接，数据已刷新')
  } catch (e) {
    store.dbStatus = 'fail'
    store.dbError = e.message
    ElMessage.error('连接失败：' + e.message)
  }
}

/* 写库成功后：重取该表 → 替换缓存 → 重建图层（图层当前不可见则仅更新缓存） */
const reloadTable = async (t) => {
  try {
    store.dbData[t] = await api.table(t)
    const layer = LAYER_BY_TABLE[t]
    if (layer) refreshTrafficLayer(layer)
  } catch (e) {
    ElMessage.error('数据刷新失败：' + e.message)
  }
}

/* ---------- 新增 / 编辑 ---------- */
const LEVEL_NAME_OF = ['', '严重拥堵', '中度拥堵', '轻度拥堵']
const dialog = reactive({ show: false, mode: 'create', row: null })
const form = reactive({})
const saving = ref(false)

/* 建议业务编号：取现有同前缀编号的最大序号 +1（如 CAM1001 → CAM1002） */
const suggestId = (t) => {
  const col = { cameras: 'cam_id', traffic_lights: 'tl_id', police: 'pol_id', alerts: 'alert_id', events: 'event_num', bus_stops: 'stop_id' }[t]
  let prefix = null, max = 0, width = 0
  for (const r of rowsOf(t)) {
    const m = /^([A-Za-z]+)(\d+)$/.exec(String(r[col] ?? ''))
    if (!m) continue
    prefix = m[1]
    width = Math.max(width, m[2].length)
    max = Math.max(max, Number(m[2]))
  }
  return prefix ? prefix + String(max + 1).padStart(width, '0') : ''
}

const blank = () => {
  const f = {}
  for (const k of activeTab.value.fields) {
    if (k.kind === 'num') f[k.k] = 0
    else if (k.kind === 'bit') f[k.k] = true
    else if (k.k === 'lng') { f.lng = 118.05; f.lat = 36.81 }
    else f[k.k] = ''
  }
  return f
}

const openCreate = () => {
  cleanupPickers()
  const f = blank()
  const idKey = { cameras: 'cam_id', traffic_lights: 'tl_id', police: 'pol_id', alerts: 'alert_id', events: 'event_num', bus_stops: 'stop_id' }[active.value]
  if (idKey) {
    const s = suggestId(active.value)
    if (s) f[idKey] = s
  }
  dialog.mode = 'create'
  dialog.row = null
  Object.assign(form, f)
  dialog.show = true
  dialog.title = `新增${activeTab.value.label}`
}

const openEdit = (row) => {
  cleanupPickers()
  const f = {}
  for (const k of activeTab.value.fields) {
    const v = row[k.k]
    if (k.k === 'lng') { f.lng = Number(row.lng); f.lat = Number(row.lat) }
    else if (k.kind === 'num') f[k.k] = Number(v ?? 0)
    else if (k.k === 'geometry') f.geometry = v || null
    else f[k.k] = v ?? ''
  }
  dialog.mode = 'edit'
  dialog.row = row
  Object.assign(form, f)
  dialog.show = true
  dialog.title = `编辑${activeTab.value.label}（id=${row.id}）`
}

/* 拥堵程度下拉选择时自动带出 level_name */
const syncCongName = () => {
  if (active.value === 'congestion' && typeof form.level === 'number') form.level_name = LEVEL_NAME_OF[form.level]
}

const save = async () => {
  const t = active.value
  const f = activeTab.value.fields
  // 必填校验（经纬度非空数字；公交线路需有几何）
  const miss = []
  for (const k of f) {
    if (k.k === 'lng') {
      if (!Number.isFinite(Number(form.lng)) || !Number.isFinite(Number(form.lat))) miss.push(k.l)
    } else if (k.k === 'geometry') {
      if (!form.geometry) miss.push(k.l)
    } else if (k.req && String(form[k.k] ?? '').trim() === '') miss.push(k.l)
  }
  if (miss.length) return ElMessage.warning('请补全：' + miss.join('、'))
  // level_name 随程度选择联动
  syncCongName()
  saving.value = true
  try {
    const payload = {}
    for (const k of f) {
      if (k.k === 'geometry') { if (form.geometry) payload.geometry = form.geometry }
      else if (k.k === 'lng') { payload.lng = Number(form.lng); payload.lat = Number(form.lat) }
      else if (k.kind === 'num') payload[k.k] = Number(form[k.k])
      else if (k.kind === 'bit') payload[k.k] = !!form[k.k]
      else payload[k.k] = String(form[k.k] ?? '').trim()
    }
    if (dialog.mode === 'create') await api.create(t, payload)
    else await api.update(t, dialog.row.id, payload)
    ElMessage.success(`已${dialog.mode === 'create' ? '新增' : '保存'}`)
    closeDialog()
    await reloadTable(t)
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

const delRow = (row) => {
  const t = active.value
  ElMessageBox.confirm(
    `确定删除该条${activeTab.value.label}记录？写入数据库后将在地图上同步消失。`, '删除确认',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' }
  ).then(async () => {
    try {
      await api.remove(t, row.id)
      ElMessage.success('已删除')
      await reloadTable(t)
    } catch (e) {
      ElMessage.error(e.message)
    }
  }).catch(() => { /* 取消 */ })
}

const closeDialog = () => {
  cleanupPickers()
  dialog.show = false
}

/* ---------- 地图点选坐标 ---------- */
const picking = ref(false)
let pickMarker = null
const onMapPick = (e) => {
  const [lng, lat] = [e.lngLat.lng, e.lngLat.lat]
  form.lng = Number(lng.toFixed(6))
  form.lat = Number(lat.toFixed(6))
  if (pickMarker) pickMarker.setLngLat([lng, lat])
  // 取点标记用主色（原为青色 #00e5ff，在亮色底图上几乎看不见）
  else pickMarker = new mapboxgl.Marker({ color: PRIMARY }).setLngLat([lng, lat]).addTo(map())
  stopPick()
  ElMessage.success(`已取点：${form.lng.toFixed(6)}, ${form.lat.toFixed(6)}`)
}
const stopPick = () => {
  picking.value = false
  const m = map()
  if (m) m.off('click', onMapPick)
  const cv = m && m.getCanvas()
  if (cv) cv.style.cursor = ''
}
const startPick = () => {
  if (!map()) return ElMessage.warning('地图尚未就绪')
  cleanupDraw()
  picking.value = true
  const cv = map().getCanvas()
  cv.style.cursor = 'crosshair'
  map().on('click', onMapPick)
}

/* ---------- 公交线路地图画线（l7-draw） ---------- */
const drawBusy = ref(false)
let draw = null
const startDraw = () => {
  if (!sm.scene) return ElMessage.warning('地图尚未就绪')
  cleanupPickers()
  drawBusy.value = true
  draw = new DrawLine(sm.scene, {})
  draw.on(DrawEvent.Add, (e) => {
    // e.feature: GeoJSON Feature(LineString)；保存时原样入库（服务端转 JSON 文本）
    form.geometry = e.feature
    drawBusy.value = false
    if (draw) { draw.destroy(); draw = null }
    ElMessage.success(`线路已绘制（${e.feature.geometry.coordinates.length} 个节点）`)
  })
  draw.enable()
}
const clearGeom = () => { form.geometry = null }
const cleanupDraw = () => {
  if (draw) { try { draw.destroy() } catch (e) { /* 已销毁 */ } draw = null }
  drawBusy.value = false
}
const cleanupPickers = () => {
  stopPick()
  cleanupDraw()
  if (pickMarker) { try { pickMarker.remove() } catch (e) { /* 已移除 */ } pickMarker = null }
}

onUnmounted(cleanupPickers)

/* Esc 取消点选 */
const onKey = (e) => {
  if (e.key === 'Escape') { stopPick(); cleanupDraw() }
}
window.addEventListener('keydown', onKey)
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
/* ===== 右侧悬浮面板 ===== */
.dm-panel {
  position: fixed;
  right: 14px;
  top: calc(var(--header-h) + 20px);
  bottom: 118px;
  width: min(700px, 48vw);
  z-index: 96; /* 高于 --z-footer(90)，低于 --z-modal(100)：面板要在工具条之上，但不能盖过表单弹窗 */
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  color: var(--text);
}

.dm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sub);
}

.dm-title { font-size: 15px; font-weight: 700; letter-spacing: 1px; }
/* 标题图标：原为 🗄️ emoji（彩色位图、无法着色），换成底部工具条「数据管理」同一个字形，
 * 图标语义与入口一一对应，同时跟着主题色走 */
.dm-title .iconfont { color: var(--primary); font-size: 14px; margin-right: 4px; }
.dm-sub { font-size: 11px; color: var(--text-mute); margin-left: 6px; font-weight: 400; }
.dm-head-right { display: flex; align-items: center; gap: 6px; }
.dm-re, .dm-close { color: var(--text-sub); }
.dm-state { font-size: 12px; display: inline-flex; align-items: center; gap: 5px; margin-right: 4px; }
.dm-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.s-ok .dm-dot { background: var(--ok); }
.s-loading .dm-dot { background: var(--warn); animation: dm-blink 1s infinite; }
.s-fail .dm-dot { background: var(--danger); }
.s-idle .dm-dot { background: var(--text-mute); }
.s-ok { color: var(--ok); } .s-fail { color: var(--danger); }
.s-loading { color: var(--warn); } .s-idle { color: var(--text-mute); }
@keyframes dm-blink { 50% { opacity: 0.3; } }

.dm-alert { margin: 8px 12px 0; }
:deep(.dm-alert .el-alert__description) { font-size: 12px; }

.dm-tabs { flex: none; padding: 0 10px; }
:deep(.dm-tabs .el-tabs__header) { margin-bottom: 6px; }
:deep(.dm-tabs .el-tabs__item) { color: var(--text-sub); height: 34px; font-size: 12px; padding: 0 10px; }
:deep(.dm-tabs .el-tabs__item.is-active) { color: var(--primary); }
:deep(.dm-tabs .el-tabs__active-bar) { background: var(--primary); }
.dm-tablabel em {
  font-style: normal; font-size: 10px; margin-left: 3px; padding: 0 5px;
  border-radius: 8px; background: var(--primary-soft); color: var(--primary);
  vertical-align: 1px;
}

.dm-body { flex: 1; min-height: 0; padding: 0 12px; overflow: hidden; }
.dm-panel .dm-body :deep(.el-table) {
  --el-table-border-color: var(--border);
  background-color: transparent; height: 100%;
}
.dm-panel .dm-body :deep(.el-table tr), .dm-panel .dm-body :deep(.el-table th.el-table__cell),
.dm-panel .dm-body :deep(.el-table td.el-table__cell) { background-color: transparent; color: var(--text); }
.dm-panel .dm-body :deep(.el-table th.el-table__cell) { background: var(--bg-sub); font-weight: 600; }
.dm-panel .dm-body :deep(.el-table__inner-wrapper::before) { height: 0; }
.dm-panel .dm-body :deep(.el-table .el-button.is-link) { padding: 0 2px; }
.dm-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; }
.dm-chip-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.dm-swatch { display: inline-block; width: 14px; height: 14px; border-radius: 3px; vertical-align: middle; }

.dm-foot {
  flex: none; display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-top: 1px solid var(--border);
}
.dm-foot-tip { font-size: 11px; color: var(--text-mute); }

/* ===== 表单弹层 ===== */
.dm-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; }
.dm-frow { display: flex; align-items: center; gap: 8px; }
.dm-frow-wide { grid-column: 1 / -1; }
.dm-flabel { flex: none; width: 82px; text-align: right; font-size: 13px; color: var(--text-sub); }
.dm-frow > :not(.dm-flabel) { flex: 1; }
.dm-req { color: var(--danger); font-style: normal; margin-left: 2px; }
.dm-coord { display: flex; gap: 6px; align-items: center; }
.dm-coord .el-input-number { flex: 1; width: auto; }
.dm-bitrow { display: flex; align-items: center; gap: 8px; }
.dm-bit-txt { font-size: 12px; color: var(--text-mute); }
.dm-draw { display: flex; align-items: center; gap: 8px; }
.dm-draw-tip { font-size: 12px; color: var(--text-mute); }
.dm-picktip { grid-column: 1 / -1; margin: 0; font-size: 12px; color: var(--warn); text-align: center; }
/* 表单弹窗：Element Plus 的深色变量在亮色皮肤下反而更暗，这里显式拉回白卡片 */
:deep(.dm-dialog) {
  --el-dialog-bg-color: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}
:deep(.dm-dialog .el-dialog__title) { color: var(--text); font-size: 15px; font-weight: 600; }
:deep(.dm-dialog .el-dialog__body) { color: var(--text); }
:deep(.dm-dialog .el-input__wrapper), :deep(.dm-dialog .el-select__wrapper) {
  background: var(--bg-sub);
  box-shadow: 0 0 0 1px var(--border) inset;
}
:deep(.dm-dialog .el-input__inner), :deep(.dm-dialog .el-input-number) { color: var(--text); }
:deep(.dm-dialog .el-textarea__inner) { background: var(--bg-sub); color: var(--text); }
:deep(.dm-dialog .el-textarea__inner::placeholder), :deep(.dm-dialog .el-input__inner::placeholder) { color: var(--text-mute); }
</style>
