import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

export interface Series {
  name: string;
  x: number[];
  /** null leaves a gap. */
  y: Array<number | null>;
}

interface ChartProps {
  series: Series[];
  xLabel: string;
  yLabel: string;
  height?: number;
  /** For quantities spanning decades, such as the convergence delta. */
  logY?: boolean;
  /** Draws a dot at every point, for short series such as one point per adaptive pass. */
  points?: boolean;
  /** A horizontal reference line, such as the convergence target. */
  reference?: { y: number; label: string };
  formatX?: (x: number) => string;
  formatY?: (y: number) => string;
}

const MARGIN = { top: 12, right: 16, bottom: 36, left: 56 };
const SERIES_COLORS = 8;

/** Ticks at 1, 2 or 5 times a power of ten, about `count` of them. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10].map((m) => m * power);
  let index = steps.findIndex((s) => s >= raw);
  if (index < 0) index = steps.length - 1;
  const at = (step: number) => {
    const ticks: number[] = [];
    for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) ticks.push(Number(t.toPrecision(12)));
    return ticks;
  };
  // A round step can overshoot so far that one tick is left, which tells nothing: step down.
  let ticks = at(steps[index]!);
  while (ticks.length < 2 && index > 0) ticks = at(steps[--index]!);
  return ticks;
}

function logTicks(min: number, max: number): number[] {
  const ticks: number[] = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e += 1) ticks.push(10 ** e);
  return ticks.filter((t) => t >= min / 1.0001 && t <= max * 1.0001);
}

const defaultFormat = (value: number) =>
  Math.abs(value) >= 1e4 || (Math.abs(value) < 1e-3 && value !== 0) ? value.toExponential(1) : String(Number(value.toPrecision(6)));

/** A line chart drawn as SVG, sized to its container: no chart library, works in both themes. */
export function Chart({ series, xLabel, yLabel, height = 240, logY, points, reference, formatX, formatY }: ChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.floor(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fx = formatX ?? defaultFormat;
  const fy = formatY ?? defaultFormat;
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;

  const scale = useMemo(() => {
    const xs = series.flatMap((s) => s.x);
    const ys = series.flatMap((s) => s.y.filter((v): v is number => v !== null && (!logY || v > 0)));
    if (reference && (!logY || reference.y > 0)) ys.push(reference.y);
    if (!xs.length || !ys.length) return null;
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    let y0 = Math.min(...ys);
    let y1 = Math.max(...ys);
    if (logY) {
      y0 = 10 ** Math.floor(Math.log10(y0));
      y1 = 10 ** Math.ceil(Math.log10(y1));
    } else {
      const pad = (y1 - y0 || Math.abs(y1) || 1) * 0.06;
      y0 -= pad;
      y1 += pad;
    }
    const ty = (v: number) =>
      logY
        ? plotH - ((Math.log10(v) - Math.log10(y0)) / (Math.log10(y1) - Math.log10(y0) || 1)) * plotH
        : plotH - ((v - y0) / (y1 - y0 || 1)) * plotH;
    const tx = (v: number) => ((v - x0) / (x1 - x0 || 1)) * plotW;
    return { x0, x1, y0, y1, tx, ty, xTicks: niceTicks(x0, x1, Math.max(2, Math.floor(plotW / 90))), yTicks: logY ? logTicks(y0, y1) : niceTicks(y0, y1, 5) };
  }, [series, logY, reference, plotW, plotH]);

  if (!scale) return <div className="chart-empty">没有可画的数据</div>;
  const { tx, ty } = scale;

  const paths = series.map((s) => {
    let d = "";
    let pen = false;
    s.x.forEach((x, i) => {
      const y = s.y[i];
      if (y === null || y === undefined || (logY && y <= 0)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${tx(x).toFixed(1)},${ty(y).toFixed(1)}`;
      pen = true;
    });
    return d;
  });

  // The hovered x: the nearest sample of the first series, read off every series at the same index
  // when they share x values, or at each one's own nearest point otherwise.
  function onMove(event: MouseEvent<SVGRectElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientX - rect.left) / rect.width;
    setHover(scale!.x0 + fraction * (scale!.x1 - scale!.x0));
  }
  const readout =
    hover === null
      ? null
      : series.map((s) => {
          let best = 0;
          s.x.forEach((x, i) => {
            if (Math.abs(x - hover) < Math.abs((s.x[best] ?? Infinity) - hover)) best = i;
          });
          return { name: s.name, x: s.x[best], y: s.y[best] };
        });
  const hoverX = readout?.[0]?.x;

  return (
    <div className="chart" ref={box}>
      <svg width={width} height={height} role="img" aria-label={`${yLabel} 随 ${xLabel} 的变化`}>
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {scale.yTicks.map((t) => (
            <g key={`y${t}`} transform={`translate(0,${ty(t)})`}>
              <line className="chart-grid" x2={plotW} />
              <text className="chart-tick" x={-6} dy="0.32em" textAnchor="end">
                {fy(t)}
              </text>
            </g>
          ))}
          {scale.xTicks.map((t) => (
            <text key={`x${t}`} className="chart-tick" x={tx(t)} y={plotH + 16} textAnchor="middle">
              {fx(t)}
            </text>
          ))}
          <line className="chart-axis" y1={plotH} y2={plotH} x2={plotW} />
          <text className="chart-label" x={plotW / 2} y={plotH + 32} textAnchor="middle">
            {xLabel}
          </text>
          <text className="chart-label" transform={`translate(${-44},${plotH / 2}) rotate(-90)`} textAnchor="middle">
            {yLabel}
          </text>
          {reference && (!logY || reference.y > 0) && (
            <g transform={`translate(0,${ty(reference.y)})`}>
              <line className="chart-reference" x2={plotW} />
              <text className="chart-tick" x={plotW - 4} dy="-0.4em" textAnchor="end">
                {reference.label}
              </text>
            </g>
          )}
          {paths.map((d, i) => (
            <path key={series[i]!.name} className={`chart-line series-${i % SERIES_COLORS}`} d={d} />
          ))}
          {points &&
            series.map((s, i) =>
              s.x.map((x, j) => {
                const y = s.y[j];
                return y === null || y === undefined || (logY && y <= 0) ? null : (
                  <circle key={`${s.name}-${j}`} className={`chart-dot series-${i % SERIES_COLORS}`} cx={tx(x)} cy={ty(y)} r={3} />
                );
              }),
            )}
          {hoverX !== undefined && <line className="chart-cursor" x1={tx(hoverX)} x2={tx(hoverX)} y2={plotH} />}
          <rect width={plotW} height={plotH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </g>
      </svg>
      <div className="chart-legend">
        {series.map((s, i) => (
          <span key={s.name}>
            <i className={`series-${i % SERIES_COLORS}`} aria-hidden="true" />
            {s.name}
            {readout && readout[i]?.y !== null && readout[i]?.y !== undefined && (
              <b>
                {" "}
                {fy(readout[i]!.y!)} @ {fx(readout[i]!.x!)}
              </b>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
