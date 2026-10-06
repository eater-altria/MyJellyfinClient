import { useEffect, useState } from 'react';
import { isTauri, windowStartResize, type ResizeDirection } from '../platform/window';

const EDGES: { direction: ResizeDirection; className: string }[] = [
  { direction: 'North', className: 'inset-x-2 top-0 h-1 cursor-ns-resize' },
  { direction: 'South', className: 'inset-x-2 bottom-0 h-1 cursor-ns-resize' },
  { direction: 'West', className: 'inset-y-2 left-0 w-1 cursor-ew-resize' },
  { direction: 'East', className: 'inset-y-2 right-0 w-1 cursor-ew-resize' },
  { direction: 'NorthWest', className: 'left-0 top-0 h-2 w-2 cursor-nwse-resize' },
  { direction: 'NorthEast', className: 'right-0 top-0 h-2 w-2 cursor-nesw-resize' },
  { direction: 'SouthWest', className: 'bottom-0 left-0 h-2 w-2 cursor-nesw-resize' },
  { direction: 'SouthEast', className: 'bottom-0 right-0 h-2 w-2 cursor-nwse-resize' },
];

/** Webview grips cover loading screens and the title bar; the native video
 * host forwards its own edge hits to the same Windows resize operation. */
export default function WindowResizeHandles() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      const update = async () => {
        const [maximized, fullscreen] = await Promise.all([w.isMaximized(), w.isFullscreen()]);
        if (!cancelled) setEnabled(!maximized && !fullscreen);
      };
      await update();
      const dispose = await w.onResized(update);
      if (cancelled) dispose(); else unlisten = dispose;
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);
  if (!isTauri || !enabled) return null;
  return <>{EDGES.map(({ direction, className }) => <div key={direction} aria-hidden="true"
    className={`fixed z-50 ${className}`} onMouseDown={e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation(); void windowStartResize(direction);
    }} />)}</>;
}
