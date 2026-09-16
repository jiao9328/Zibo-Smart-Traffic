/* 各区县车辆密度指数（柱状图）
 * 数据源：模拟数据（人口比例 + 市中心偏高），8 区县固定种子可复现
 * 注：不设 height —— G2Plot 的尺寸是 height || 容器高度 || 400，一旦写死像素值就
 *     会完全无视容器，面板按百分比缩放时必然溢出（原 height:270 就是这么撑破面板的）。
 *     交给 autoFit（默认 true，走 ResizeObserver）跟随容器即可。
 */
import { vehicleDensity } from '@/tools/mockData'
import { AXIS_TEXT, OK, WARN, DANGER } from '@/tools/palette'

export const useLeftTop = () => {
      const data = vehicleDensity.map((d) => ({ type: d.name, value: d.value }));
      const config = {
            xField: 'type',
            yField: 'value',
            seriesField: 'value',
            label: {
                  // 可手动配置 label 数据标签位置
                  position: 'top', // 'top', 'bottom', 'middle',
                  // 配置样式
                  style: {
                        fill: AXIS_TEXT,
                  },
            },
            // 密度指数带阈值语义：绿色正常 / 黄色偏忙 / 红色拥堵
            color: ({ value }) => {
                  if (value > 10500) {
                        return DANGER;
                  } else if (value > 8500) {
                        return WARN;
                  } else {
                        return OK;
                  }
            },
            legend: false,
      };
      return {
            config,
            data
      }
}
