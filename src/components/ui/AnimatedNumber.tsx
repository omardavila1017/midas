import { useEffect, useRef, useState } from 'react';

interface Props {
  value: number;
  format: (n: number) => string;
  duration?: number;
  className?: string;
  style?: React.CSSProperties;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function AnimatedNumber({ value, format, duration = 520, className, style }: Props) {
  const [display, setDisplay] = useState(value);
  const startRef = useRef<number | null>(null);
  const fromRef = useRef(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (prefersReducedMotion() || !Number.isFinite(value)) {
      setDisplay(value);
      return;
    }
    if (Math.abs(value - fromRef.current) < 0.5) {
      setDisplay(value);
      fromRef.current = value;
      return;
    }
    startRef.current = null;
    const from = fromRef.current;
    const to = value;
    const step = (t: number) => {
      if (startRef.current === null) startRef.current = t;
      const elapsed = t - startRef.current;
      const p = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (to - from) * eased);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = to;
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [value, duration]);

  return (
    <span className={className} style={style}>
      {format(display)}
    </span>
  );
}
