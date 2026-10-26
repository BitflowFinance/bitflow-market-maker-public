import { useEffect, useMemo, useRef, useState } from 'react';
import { BinBar } from './api';
import { clock, usd } from './format';

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(120, Math.floor(w)));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return [ref, width];
}

export interface Point {
  t: string;
  value: number;
}

/** Sum the latest known value of each series at every timestamp, once every series has started. */
export const mergeSeries = (series: Point[][]): Point[] => {
  const events: Array<{ at: number; t: string; index: number; value: number }> = [];
  series.forEach((points, index) => {
    for (const point of points) {
      const at = new Date(point.t).getTime();
      if (Number.isFinite(at)) events.push({ at, t: point.t, index, value: point.value });
    }
  });
  events.sort((a, b) => a.at - b.at);
  const latest = new Map<number, number>();
  const out: Point[] = [];
  const live = series.filter((points) => points.length > 0).length;
  for (const event of events) {
    latest.set(event.index, event.value);
    if (latest.size < live) continue;
    let sum = 0;
    latest.forEach((value) => {
      sum += value;
    });
    out.push({ t: event.t, value: sum });
  }
  return out;
};

export function ValueChart({ points, height = 150, empty = 'The value line appears after a few checks.' }: { points: Point[]; height?: number; empty?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const layout = useMemo(() => {
    if (points.length < 2) return null;
    const values = points.map((point) => point.value);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (max - min < Math.abs(max) * 0.0005 || max === min) {
      const pad = Math.max(Math.abs(max) * 0.001, 0.01);
      min -= pad;
      max += pad;
    }
    const left = 4;
    const right = 64;
    const top = 10;
    const bottom = 20;
    const w = width - left - right;
    const h = height - top - bottom;
    const x = (i: number) => left + (i / (points.length - 1)) * w;
    const y = (v: number) => top + (1 - (v - min) / (max - min)) * h;
    const line = points.map((point, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ');
    const area = `${line} L${x(points.length - 1).toFixed(1)},${top + h} L${left},${top + h} Z`;
    return { min, max, x, y, line, area, left, right, top, h, w };
  }, [points, width, height]);

  if (!layout) {
    return (
      <div ref={ref} className="chart-empty" style={{ height }}>
        {empty}
      </div>
    );
  }
  const first = points[0];
  const last = points[points.length - 1];
  const up = last.value >= first.value;
  const at = hover != null ? points[hover] : null;
  return (
    <div ref={ref} className="chart-box">
      <svg
        width={width}
        height={height}
        className={`vchart2 ${up ? 'up' : 'down'}`}
        role="img"
        aria-label={`Value from ${usd(first.value)} to ${usd(last.value)}`}
        onMouseMove={(event) => {
          const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
          const rel = (event.clientX - rect.left - layout.left) / layout.w;
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(rel * (points.length - 1)))));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <line className="grid" x1={layout.left} x2={width - layout.right} y1={layout.top} y2={layout.top} />
        <line className="grid" x1={layout.left} x2={width - layout.right} y1={layout.top + layout.h} y2={layout.top + layout.h} />
        <text className="axis" x={width - layout.right + 6} y={layout.top + 4}>
          {usd(layout.max)}
        </text>
        <text className="axis" x={width - layout.right + 6} y={layout.top + layout.h + 4}>
          {usd(layout.min)}
        </text>
        <path className="area" d={layout.area} />
        <path className="line" d={layout.line} />
        <text className="axis" x={layout.left} y={height - 4}>
          {clock(first.t)}
        </text>
        <text className="axis" x={width - layout.right} y={height - 4} textAnchor="end">
          {clock(last.t)}
        </text>
        {at && hover != null ? (
          <g>
            <line className="cross" x1={layout.x(hover)} x2={layout.x(hover)} y1={layout.top} y2={layout.top + layout.h} />
            <circle className="hdot" cx={layout.x(hover)} cy={layout.y(at.value)} r={3.5} />
          </g>
        ) : null}
      </svg>
      {at && hover != null ? (
        <div className="ctip" style={{ left: Math.min(width - 120, Math.max(0, layout.x(hover) - 60)) }}>
          <b>{usd(at.value)}</b> · {clock(at.t)}
        </div>
      ) : null}
    </div>
  );
}

export function BinChart({ bins, havePoolDepth, height = 190 }: { bins: BinBar[]; havePoolDepth: boolean; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (!bins.length) {
    return (
      <div ref={ref} className="chart-empty" style={{ height }}>
        No bins yet. The chart appears after the bot reads the pool.
      </div>
    );
  }
  const activeIndex = bins.findIndex((bin) => bin.active);
  const max = Math.max(1e-9, ...bins.map((bin) => Math.max(havePoolDepth ? bin.pool : 0, bin.ours)));
  const top = 18;
  const bottom = 22;
  const h = height - top - bottom;
  const bw = width / bins.length;
  const gap = bw > 8 ? 2 : 1;
  const step = Math.max(1, Math.ceil(bins.length / 9));
  const hovered = hover != null ? bins[hover] : null;
  return (
    <div ref={ref} className="chart-box">
      <svg width={width} height={height} className="bchart" role="img" aria-label="Liquidity by bin" onMouseLeave={() => setHover(null)}>
        <line className="grid" x1={0} x2={width} y1={top + h} y2={top + h} />
        {bins.map((bin, i) => {
          const x = i * bw;
          const poolH = havePoolDepth ? (bin.pool / max) * h : 0;
          const oursH = havePoolDepth ? (bin.ours / max) * h : bin.ours > 0 ? h * 0.55 : 0;
          return (
            <g key={bin.id} onMouseEnter={() => setHover(i)}>
              <rect className="hit" x={x} y={top} width={bw} height={h} />
              {poolH > 0 ? <rect className={`pool${bin.active ? ' act' : ''}`} x={x + gap / 2} y={top + h - poolH} width={Math.max(1, bw - gap)} height={poolH} rx={1.5} /> : null}
              {oursH > 0 ? <rect className="ours" x={x + gap / 2} y={top + h - oursH} width={Math.max(1, bw - gap)} height={oursH} rx={1.5} /> : null}
              {(i - activeIndex) % step === 0 ? (
                <text className="axis" x={x + bw / 2} y={height - 6} textAnchor="middle">
                  {i === activeIndex ? '0' : i - activeIndex > 0 ? `+${i - activeIndex}` : i - activeIndex}
                </text>
              ) : null}
            </g>
          );
        })}
        {activeIndex >= 0 ? (
          <g>
            <line className="active" x1={activeIndex * bw + bw / 2} x2={activeIndex * bw + bw / 2} y1={top - 4} y2={top + h} />
            <text className="active-l" x={activeIndex * bw + bw / 2} y={top - 7} textAnchor="middle">
              price
            </text>
          </g>
        ) : null}
      </svg>
      {hovered ? (
        <div className="ctip" style={{ left: Math.min(width - 260, Math.max(0, (hover as number) * bw - 90)) }}>
          <b>{hovered.active ? 'Current price' : `${(hover as number) - activeIndex > 0 ? '+' : ''}${(hover as number) - activeIndex} bins from price`}</b>
          {havePoolDepth ? <> · Pool {usd(hovered.pool)}</> : null}
          {hovered.ours > 0 ? <> · Yours {havePoolDepth ? usd(hovered.ours) : 'in this bin'}</> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Tiny view of where our bins sit against the active bin. */
export function RangeStrip({ bins, width = 120 }: { bins: BinBar[]; width?: number }) {
  if (!bins.length) return <span className="na">—</span>;
  const activeIndex = bins.findIndex((bin) => bin.active);
  const bw = width / bins.length;
  const owned = bins.map((bin, i) => (bin.ours > 0 ? i : -1)).filter((i) => i >= 0);
  const inRange = activeIndex >= 0 && owned.length > 0 && activeIndex >= owned[0] && activeIndex <= owned[owned.length - 1];
  return (
    <svg width={width} height={16} className="rstrip" role="img" aria-label={inRange ? 'Price is inside your range' : 'Price is outside your range'}>
      <line className="axisl" x1={0} x2={width} y1={8} y2={8} />
      {owned.length ? <rect className="mine" x={owned[0] * bw} y={4} width={(owned[owned.length - 1] - owned[0] + 1) * bw} height={8} rx={2} /> : null}
      {activeIndex >= 0 ? <line className={`act ${inRange ? 'in' : 'out'}`} x1={activeIndex * bw + bw / 2} x2={activeIndex * bw + bw / 2} y1={1} y2={15} /> : null}
    </svg>
  );
}

export function Sparkline({ points, width = 120, height = 32 }: { points: Point[]; width?: number; height?: number }) {
  if (points.length < 2) return <span className="na">—</span>;
  const values = points.map((point) => point.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max === min) {
    min -= 1;
    max += 1;
  }
  const d = points
    .map((point, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = 2 + (1 - (point.value - min) / (max - min)) * (height - 4);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={width} height={height} className="spark" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
