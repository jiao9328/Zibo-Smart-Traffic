/* 配色 —— CSS 设计 token（src/assets/main.css）在 JS 侧的镜像。
 *
 * 为什么需要这个文件：G2Plot 的配置项是 JS 值，拿不到 CSS 变量，如果各图表各写一份
 * 裸色值，改主题时必然漏改。这里集中声明，色值与 main.css 中的同名 token 严格一致；
 * 车辆 marker / 车辆列表徽标也取自这里，保证「同一个编号在列表和地图上颜色相同」。
 *
 * 改色时请同时改 main.css 的同名变量。
 */

/** 主色（= --primary） */
export const PRIMARY = '#1769E0'
/** 语义色（= --ok / --warn / --danger） */
export const OK = '#12B76A'
export const WARN = '#F79009'
export const DANGER = '#F04438'
/** 次级文字（= --text-sub）：坐标轴刻度、数据标签、图例文字 */
export const AXIS_TEXT = '#5A6B85'
/** 分隔线（= --border） */
export const BORDER = '#E3E8EF'

/** 分类色板：饼图这类「无序类别」用。以主色打头，色相彼此拉开，白底上均可辨认 */
export const CATEGORICAL = [
  PRIMARY,
  OK,
  WARN,
  '#E2447E',
  '#7C4DFF',
  '#0E9AA7',
  '#EF6820',
  '#9333EA',
  '#2E90FA',
  '#059669'
]

/** 车辆专属色（按车辆 id 取模）。15 辆同屏，要求相邻色相拉开，
 *  且白底地图上都能看清 —— 这是「一眼认出是哪辆车」的主要手段。 */
export const CAR_COLORS = [
  '#1769E0',
  '#12B76A',
  '#F79009',
  '#E2447E',
  '#7C4DFF',
  '#0E9AA7',
  '#EF6820',
  '#9333EA',
  '#D92D20',
  '#2E90FA',
  '#16A34A',
  '#CA8A04',
  '#DB2777',
  '#4F46E5',
  '#059669'
]
