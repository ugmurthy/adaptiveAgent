<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import * as echarts from 'echarts/core';
  import { BarChart, PieChart } from 'echarts/charts';
  import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
  import { CanvasRenderer } from 'echarts/renderers';
  import type { ECharts } from 'echarts/core';
  import type { TopToolMetric, TraceReport } from '@adaptive-agent/trace-session';

  echarts.use([BarChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

  let { report } = $props<{ report: TraceReport | null }>();
  let spendEl: HTMLDivElement;
  let toolEl: HTMLDivElement;
  let spendChart: ECharts | null = null;
  let toolChart: ECharts | null = null;

  onMount(() => {
    spendChart = echarts.init(spendEl, 'dark');
    toolChart = echarts.init(toolEl, 'dark');
    render();
    const resize = () => {
      spendChart?.resize();
      toolChart?.resize();
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  });

  onDestroy(() => {
    spendChart?.dispose();
    toolChart?.dispose();
  });

  $effect(() => {
    report;
    render();
  });

  function render() {
    if (!spendChart || !toolChart) return;
    const brief = report?.diagnostics?.brief;
    const performance = report?.diagnostics?.performance;
    spendChart.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, textStyle: { color: '#aab6c7' } },
      series: [{
        type: 'pie',
        radius: ['48%', '72%'],
        center: ['50%', '44%'],
        label: { color: '#e5eefc', formatter: '{b}\n{c}ms' },
        data: [
          { name: 'model', value: Math.max(brief?.cumulativeModelDurationMs ?? 0, 0) },
          { name: 'tools', value: Math.max(brief?.cumulativeToolDurationMs ?? 0, 0) },
          { name: 'snapshots', value: Math.max(brief?.cumulativeSnapshotSaveMs ?? 0, 0) },
        ],
        color: ['#8bd3ff', '#f6c177', '#a6e3a1'],
      }],
    });

    const tools: TopToolMetric[] = performance?.topToolsByDuration.slice(0, 8) ?? [];
    toolChart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 10, right: 20, top: 18, bottom: 12, containLabel: true },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'value', axisLabel: { color: '#9fb0c7' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.08)' } } },
      yAxis: { type: 'category', inverse: true, data: tools.map((tool) => tool.toolName), axisLabel: { color: '#d7e7ff' } },
      series: [{
        type: 'bar',
        data: tools.map((tool) => Math.round(tool.durationMs.total)),
        itemStyle: { color: '#e0af68', borderRadius: [0, 10, 10, 0] },
      }],
    });
  }
</script>

<section class="grid gap-4 xl:grid-cols-[.9fr_1.1fr]">
  <div class="panel min-h-[320px]">
    <p class="eyebrow">Resource split</p>
    <div bind:this={spendEl} class="h-[280px]"></div>
  </div>
  <div class="panel min-h-[320px]">
    <p class="eyebrow">Slowest tools</p>
    <div bind:this={toolEl} class="h-[280px]"></div>
  </div>
</section>
