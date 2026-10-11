import { useEffect, useRef, type RefObject } from 'react';
import { danmakuAtTime, layoutDanmaku, type DanmakuComment } from '../player/danmaku';
import { danmakuDisplayDuration, normalizeDanmakuSettings, type DanmakuSettings } from '../player/danmakuSettings';

export default function DanmakuCanvas({ video, comments, settings, active }: {
  video: RefObject<HTMLVideoElement>; comments: DanmakuComment[]; settings: DanmakuSettings; active: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current, media = video.current;
    if (!element || !media) return;
    const ctx = element.getContext('2d');
    if (!ctx) return;
    const st = normalizeDanmakuSettings(settings);
    const duration = danmakuDisplayDuration(st.danmakuDuration);
    let width = 0, height = 0, frame = 0, lastTime = -Infinity;
    let layout: ReturnType<typeof layoutDanmaku> = [];
    const resize = () => {
      const rect = element.getBoundingClientRect(); width = rect.width; height = rect.height;
      const ratio = window.devicePixelRatio || 1;
      element.width = Math.round(width * ratio); element.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.font = `600 ${st.danmakuFontSize}px "Microsoft YaHei", sans-serif`;
      layout = layoutDanmaku(comments, width, height, st, text => ctx.measureText(text).width);
      lastTime = -Infinity;
    };
    resize();
    if (!active || !st.danmakuEnabled || !comments.length) return;
    const observer = new ResizeObserver(resize); observer.observe(element);
    const render = () => {
      const time = media.currentTime - st.danmakuOffset;
      // Read the real media clock, including pauses, stalls, seeks and speed.
      if (time !== lastTime) {
        lastTime = time; ctx.clearRect(0, 0, width, height);
        ctx.globalAlpha = st.danmakuOpacity; ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.9)'; ctx.textBaseline = 'top';
        for (const c of danmakuAtTime(layout, time, duration)) {
          const progress = (time - c.time) / duration;
          const x = c.mode === 1 ? width - (width + c.width) * progress
            : c.mode === 6 ? -c.width + (width + c.width) * progress : (width - c.width) / 2;
          const y = 12 + c.row * st.danmakuFontSize * 1.4;
          ctx.fillStyle = `#${c.color.toString(16).padStart(6, '0')}`;
          ctx.strokeText(c.text, x, y); ctx.fillText(c.text, x, y);
        }
      }
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); ctx.clearRect(0, 0, width, height); };
  }, [video, comments, active, settings.danmakuEnabled, settings.danmakuOpacity, settings.danmakuFontSize,
    settings.danmakuArea, settings.danmakuDuration, settings.danmakuOffset]);
  return <canvas ref={canvas} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />;
}
