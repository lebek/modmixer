import { useMemo } from 'react';

export function Sparkline({
  values,
  height = 28,
  width = 240,
  min,
  max,
  color = 'currentColor',
  fill = false,
}: {
  values: number[];
  height?: number;
  width?: number;
  min?: number;
  max?: number;
  color?: string;
  fill?: boolean;
}) {
  const path = useMemo(() => {
    if (values.length === 0) return '';
    const lo = min ?? Math.min(...values);
    const hi = max ?? Math.max(...values);
    const range = hi - lo || 1;
    const step = values.length > 1 ? width / (values.length - 1) : 0;
    return values
      .map((v, i) => {
        const x = i * step;
        const y = height - ((v - lo) / range) * height;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [values, height, width, min, max]);

  const areaPath = useMemo(() => {
    if (!fill || !path) return '';
    return `${path} L${width},${height} L0,${height} Z`;
  }, [path, fill, width, height]);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="block"
    >
      {fill && areaPath && (
        <path d={areaPath} fill={color} fillOpacity={0.12} />
      )}
      {path && (
        <path
          d={path}
          stroke={color}
          strokeWidth={1.25}
          fill="none"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
