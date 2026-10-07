import { createElement, useEffect, useId, useRef, useState, type CSSProperties, type HTMLAttributes, type PointerEvent } from 'react';
import { glassDisplacementMap } from '../utils/liquidGlass';

interface LiquidGlassProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'span';
  intensity?: 'subtle' | 'regular' | 'prominent';
  tone?: 'light' | 'dark';
  interactive?: boolean;
}

const displacementScales = {
  subtle: [10, 9, 8],
  regular: [22, 20, 18],
  prominent: [48, 43, 38],
} as const;

/** Inspired by rdev/liquid-glass-react: refract the backdrop, keep content sharp. */
export default function LiquidGlass({ as = 'div', children, className = '', intensity = 'regular', tone = 'light',
  interactive = false, style, onPointerMove, onPointerLeave, ...props }: LiquidGlassProps) {
  const surface = useRef<HTMLElement>(null);
  const filterId = `glass-${useId().replace(/:/g, '')}`;
  const [lens, setLens] = useState<{ url: string; width: number; height: number }>();
  const lensProfile = intensity === 'prominent' ? 'prominent' : 'regular';
  const [redScale, greenScale, blueScale] = displacementScales[intensity];

  useEffect(() => {
    const node = surface.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    // Chromium/WebView2 supports this filtered backdrop layer. Other engines retain the frosted material.
    const chromium = /Chrome|Chromium|Edg\//.test(navigator.userAgent);
    if (!chromium) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = Math.round(node.clientWidth);
        const height = Math.round(node.clientHeight);
        if (width < 2 || height < 2) return;
        const radius = parseFloat(getComputedStyle(node).borderTopLeftRadius) || 24;
        const url = glassDisplacementMap(width, height, radius, lensProfile);
        if (url) setLens(previous => previous?.width === width && previous?.height === height && previous.url === url
          ? previous : { url, width, height });
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    update();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [lensProfile, as]);

  const resetHighlight = () => {
    const node = surface.current;
    node?.style.removeProperty('--glass-pointer-x');
    node?.style.removeProperty('--glass-pointer-y');
  };
  const filterStyle = lens ? { '--glass-filter': `url("#${filterId}")` } as CSSProperties : undefined;

  return createElement(as, {
    ...props,
    ref: surface,
    'data-glass-tone': tone,
    'data-glass-intensity': intensity,
    className: `liquid-glass liquid-glass-${intensity} ${interactive ? 'liquid-glass-interactive' : ''} ${className}`,
    style: { ...filterStyle, ...style },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (interactive && event.pointerType !== 'touch') {
        const rect = event.currentTarget.getBoundingClientRect();
        event.currentTarget.style.setProperty('--glass-pointer-x', `${((event.clientX - rect.left) / rect.width) * 100}%`);
        event.currentTarget.style.setProperty('--glass-pointer-y', `${((event.clientY - rect.top) / rect.height) * 100}%`);
      }
      onPointerMove?.(event);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => { resetHighlight(); onPointerLeave?.(event); },
  },
    <span className="liquid-glass-warp" aria-hidden="true" />,
    lens && <svg className="liquid-glass-defs" aria-hidden="true" focusable="false">
      <defs>
        <filter id={filterId} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feImage href={lens.url} x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="lens" />
          <feDisplacementMap in="SourceGraphic" in2="lens" scale={redScale}
            xChannelSelector="R" yChannelSelector="G" result="red" />
          <feDisplacementMap in="SourceGraphic" in2="lens" scale={greenScale}
            xChannelSelector="R" yChannelSelector="G" result="green" />
          <feDisplacementMap in="SourceGraphic" in2="lens" scale={blueScale}
            xChannelSelector="R" yChannelSelector="G" result="blue" />
          <feColorMatrix in="red" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="r" />
          <feColorMatrix in="green" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="g" />
          <feColorMatrix in="blue" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="b" />
          <feBlend in="r" in2="g" mode="screen" result="rg" />
          <feBlend in="rg" in2="b" mode="screen" />
        </filter>
      </defs>
    </svg>,
    children,
  );
}
