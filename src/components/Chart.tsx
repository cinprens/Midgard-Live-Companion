import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);
export default function Chart({ option, label, height = 240 }: { option: EChartsCoreOption; label: string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const chart = echarts.init(ref.current!, undefined, { renderer: 'canvas' });
    chart.setOption({ backgroundColor: 'transparent', textStyle: { color: '#8591a8', fontFamily: 'Segoe UI, sans-serif' }, tooltip: { trigger: 'axis', backgroundColor: '#172131', borderColor: '#354159', textStyle: { color: '#e5eaf4' }, renderMode: 'richText' }, ...option });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(ref.current!);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [option]);
  return <div className="chart" ref={ref} style={{ height }} role="img" aria-label={label} />;
}
