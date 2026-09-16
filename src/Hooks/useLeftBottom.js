/* 各区县拥堵路段流量（横向条形图）
 * 数据源：22 条真实拥堵路段（按区县聚合流量指数），固定种子可复现
 * 注：原参考使用 RoseChart（极坐标玫瑰），G2Plot 2.4.31 极坐标渲染为空白
 *     （参考 dist 实测同为空），故改用 BarChart 同面板展示，数据相同。
 * 入参 rows：SQL Server congestion 表行（DB 就绪时传入，实时反映增删改）；
 *           省略时回退本地 mock 单例（口径与入库数据一致）。
 */
import { congestion as mockCongestion } from '@/tools/mockData'
import { PRIMARY, AXIS_TEXT } from '@/tools/palette'

export const useLeftBottom = (rows) => {
      const list = rows || mockCongestion
      // 按区县聚合拥堵流量
      const byArea = {}
      for (const c of list) {
            byArea[c.area] = (byArea[c.area] || 0) + c.flow
      }
      // 横向条形：xField=数值 yField=分类，按流量降序排列
      const data = Object.entries(byArea)
            .map(([type, value]) => ({ type, value }))
            .sort((a, b) => b.value - a.value);
      const config = {
            appendPadding: 10,
            xField: 'value',
            yField: 'type',
            seriesField: 'type',
            // 单一颜色：这是「一条量纲的排名」，条长已经编码了数值，
            // 再给 8 个不同色相只会让人以为颜色另有含义（原来是青色梯度）。
            color: PRIMARY,
            label: {
                  position: 'right',
                  style: { fill: AXIS_TEXT }
            },
            legend: false,
            interactions: [{ type: "element-active" }],
      };
      return {
            bus_data: data,
            bus_config: config
      }
}
