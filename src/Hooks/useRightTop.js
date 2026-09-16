/* 近期警情类型分布（饼图）
 * 数据源：28 条模拟警情（事故/拥堵/违章/管制/故障），固定种子可复现
 * 入参 rows：SQL Server alerts 表行（DB 就绪时传入，实时反映增删改）；
 *           省略时回退本地 mock 单例（口径与入库数据一致）。
 */
import { alerts as mockAlerts } from '@/tools/mockData'
import { CATEGORICAL, AXIS_TEXT } from '@/tools/palette'

export const useRightTop = (rows) => {
      const list = rows || mockAlerts
      // 按警情类型聚合
      const byType = {}
      for (const a of list) {
            byType[a.type] = (byType[a.type] || 0) + 1
      }
      const total = Object.values(byType).reduce((s, v) => s + v, 0) || 1;
      /* 占比直接并进类别名，图例天然显示成「设备故障 17%」。
       *
       * 为什么不用 legend.itemValue 的 formatter：@antv/component 0.8 里该回调拿到的
       * item.value 并非数值（实测渲染成 NaN），要绕开得先摸清 ListItem 的内部结构，
       * 不值当。并进名字最简单，且 tooltip 也顺带能看到占比。 */
      const data = Object.entries(byType).map(([type, value]) => ({
            type: `${type} ${Math.round((value / total) * 100)}%`,
            value
      }));
      const config = {
            appendPadding: 10,
            angleField: "value",
            colorField: "type",
            // 警情类型是无序类别 → 用分类色板（原来没给 color，走 G2Plot 默认色）
            color: CATEGORICAL,
            radius: 0.8,
            /* 不在扇形上画任何标签，名称和占比全部交给右侧图例。
             *
             * 原因是这块卡片只有约 326×180 的绘图区：G2Plot 的标签直接画在 canvas 上，
             * 一旦超出 canvas 就整段不画（不是省略号，是彻底没有）。实测过两种写法：
             *   spider + {name}\n{percentage} → 中文类别名被切（「设备故」「交通事」）
             *   spider + {percentage}        → 连百分比都被切（用「{percentage}(end)」
             *                                  探针验证，只画出「17」，(end) 完全不出现）
             * 图例是 DOM 布局，会自己换行/自适应，不存在被裁的问题，故改为图例承载数值。 */
            label: false,
            interactions: [{ type: "element-active" }],
            data,
            legend: {
                  position: 'right',
                  itemName:{
                        style:{
                              fill: AXIS_TEXT
                        }
                  }
            },
      }
      return {
            people_config: config
      }
}
