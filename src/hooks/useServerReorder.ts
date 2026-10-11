import { useCallback, useEffect, useId, useRef, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { useServers } from '../store/servers';
import { useServerReorder as useReorderState, type ServerReorderSurface } from '../store/serverReorder';
import { useBrowseActivity } from './useBrowseActivity';

const DRAG_THRESHOLD_PX = 6;
const SCROLL_EDGE_PX = 32;
const MAX_SCROLL_PER_FRAME_PX = 14;

function dropTarget(x: number, y: number): { id: string; placement: 'before' | 'after' } | null {
  const hit = document.elementFromPoint(x, y);
  if (!hit || hit.closest('[data-server-reorder-ignore]')) return null;
  const list = hit.closest<HTMLElement>('[data-server-reorder-list]');
  if (!list) return null;
  // Gaps between cards/rows are valid drop targets; choose the nearest real server.
  let nearest: HTMLElement | null = null;
  let distance = Infinity;
  for (const item of list.querySelectorAll<HTMLElement>('[data-server-reorder-id]')) {
    const rect = item.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const dx = Math.max(rect.left - x, 0, x - rect.right);
    const dy = Math.max(rect.top - y, 0, y - rect.bottom);
    const current = dx * dx + dy * dy;
    if (current < distance) { distance = current; nearest = item; }
  }
  if (!nearest) return null;
  const rect = nearest.getBoundingClientRect();
  const before = list.dataset.serverReorderList === 'sidebar'
    ? y < rect.top + rect.height / 2 : x < rect.left + rect.width / 2;
  return { id: nearest.dataset.serverReorderId!, placement: before ? 'before' : 'after' };
}

function autoScroll(x: number, y: number): boolean {
  let element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-server-reorder-list]') ?? null;
  while (element) {
    if (/auto|scroll/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight) {
      const rect = element.getBoundingClientRect();
      const edge = Math.min(SCROLL_EDGE_PX, rect.height / 3);
      const amount = y < rect.top + edge ? -MAX_SCROLL_PER_FRAME_PX * (1 - (y - rect.top) / edge)
        : y > rect.bottom - edge ? MAX_SCROLL_PER_FRAME_PX * (1 - (rect.bottom - y) / edge) : 0;
      const previous = element.scrollTop;
      element.scrollTop += amount;
      return element.scrollTop !== previous;
    }
    element = element.parentElement;
  }
  return false;
}

/** Pointer sorting works inside WebView2 without depending on the shell's native file-drop mode. */
export function useServerReorder(surface: ServerReorderSurface) {
  const active = useBrowseActivity();
  const instructionId = useId();
  const drag = useReorderState(state => state.drag);
  const ids = useServers(state => JSON.stringify(state.servers.map(server => server.id)));
  const pending = useRef<{ sourceId: string; finish: (commit: boolean) => void } | null>(null);
  const clearClickSuppression = useRef<(() => void) | null>(null);
  const cancel = useCallback(() => pending.current?.finish(false), []);

  useEffect(() => {
    if (!active) cancel();
    return () => { cancel(); clearClickSuppression.current?.(); };
  }, [active, cancel]);
  useEffect(() => {
    if (!pending.current) return;
    const servers = useServers.getState().servers;
    const targetId = useReorderState.getState().drag?.targetId;
    if (!servers.some(server => server.id === pending.current!.sourceId)
      || targetId && !servers.some(server => server.id === targetId)) cancel();
  }, [ids, cancel]);

  const announce = () => {
    const state = useServers.getState();
    const sourceId = useReorderState.getState().drag?.sourceId;
    const index = state.servers.findIndex(server => server.id === sourceId);
    if (index >= 0) useReorderState.setState({ announcement: { owner: instructionId,
      text: `${state.servers[index].name} 已移至第 ${index + 1} 位，共 ${state.servers.length} 个服务器` } });
  };

  const onPointerDown = (id: string, event: PointerEvent<HTMLElement>) => {
    if (!active || event.button !== 0 || !event.isPrimary || event.target instanceof Element
      && event.target.closest('[data-server-reorder-ignore]')) return;
    if (useReorderState.getState().owner) return;
    clearClickSuppression.current?.();
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX, startY = event.clientY;
    const rect = element.getBoundingClientRect();
    const width = surface === 'grid' ? Math.min(rect.width, 360) : Math.max(200, Math.min(rect.width, 260));
    const height = surface === 'grid' ? rect.height : 68;
    const preview = { surface, width, height, offsetX: (startX - rect.left) / rect.width * width,
      offsetY: (startY - rect.top) / rect.height * height };
    let x = startX, y = startY, started = false, finished = false, frame = 0;
    let clickTimer: ReturnType<typeof setTimeout> | undefined;
    const suppressClick = (click: MouseEvent) => { click.preventDefault(); click.stopImmediatePropagation(); };
    const clearClick = () => {
      clearTimeout(clickTimer);
      document.removeEventListener('click', suppressClick, true);
      document.removeEventListener('pointerdown', clearClick, true);
      document.removeEventListener('pointerup', releaseClick);
      if (clearClickSuppression.current === clearClick) clearClickSuppression.current = null;
    };
    const releaseClick = (next: globalThis.PointerEvent) => {
      if (next.pointerId === pointerId) clickTimer = setTimeout(clearClick, 0);
    };
    const updateTarget = () => {
      const target = dropTarget(x, y);
      const current = useReorderState.getState().drag;
      const targetId = target?.id === id ? null : target?.id ?? null;
      const placement = target?.placement ?? 'before';
      if (!current || current.targetId !== targetId || current.placement !== placement || current.x !== x || current.y !== y) {
        useReorderState.setState({ drag: { owner: instructionId, sourceId: id, targetId, placement, x, y, ...preview } });
      }
    };
    const scrollFrame = () => {
      if (finished) return;
      if (autoScroll(x, y)) updateTarget();
      frame = requestAnimationFrame(scrollFrame);
    };
    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      const current = useReorderState.getState().drag;
      if (commit && started && current?.owner === instructionId && current.targetId) {
        useServers.getState().reorderServer(id, current.targetId, current.placement);
        announce();
      }
      pending.current = null;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', pointerCancel);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', blur);
      element.removeEventListener('lostpointercapture', lostCapture);
      cancelAnimationFrame(frame);
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      if (started) {
        document.body.classList.remove('server-reordering');
      }
      if (useReorderState.getState().owner === instructionId) useReorderState.setState({ owner: null, drag: null });
    };
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      x = next.clientX; y = next.clientY;
      if (!started && Math.hypot(x - startX, y - startY) < DRAG_THRESHOLD_PX) return;
      if (!started) {
        started = true;
        // Capture only after the threshold: normal clicks still target the original button.
        try { element.setPointerCapture(pointerId); } catch { /* Pointer may already have been cancelled. */ }
        document.addEventListener('click', suppressClick, true);
        // Esc/blur may cancel while the button is still held. Suppress that release's click,
        // then clear immediately on the next pointer sequence so ordinary actions still work.
        document.addEventListener('pointerdown', clearClick, true);
        document.addEventListener('pointerup', releaseClick);
        clearClickSuppression.current = clearClick;
        document.body.classList.add('server-reordering');
        frame = requestAnimationFrame(scrollFrame);
      }
      next.preventDefault();
      updateTarget();
    };
    const up = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (started) { x = next.clientX; y = next.clientY; updateTarget(); }
      finish(true);
    };
    const pointerCancel = (next: globalThis.PointerEvent) => { if (next.pointerId === pointerId) finish(false); };
    const key = (next: globalThis.KeyboardEvent) => {
      if (next.key !== 'Escape') return;
      if (started) { next.preventDefault(); next.stopImmediatePropagation(); }
      finish(false);
    };
    const visibility = () => { if (document.hidden) finish(false); };
    const blur = () => finish(false);
    const lostCapture = () => finish(false);
    pending.current = { sourceId: id, finish };
    useReorderState.setState({ owner: instructionId });
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', pointerCancel);
    document.addEventListener('keydown', key, true);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', blur);
    element.addEventListener('lostpointercapture', lostCapture);
  };

  const onKeyDown = (id: string, event: KeyboardEvent<HTMLElement>) => {
    if (!active || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || !['ArrowUp', 'ArrowDown'].includes(event.key) || useReorderState.getState().owner
      || event.target instanceof Element && event.target.closest('[data-server-reorder-ignore]')) return;
    event.preventDefault(); event.stopPropagation();
    const state = useServers.getState();
    const index = state.servers.findIndex(server => server.id === id);
    if (index < 0) return;
    const adjacent = state.servers[index + (event.key === 'ArrowUp' ? -1 : 1)];
    if (!adjacent) return;
    state.reorderServer(id, adjacent.id, event.key === 'ArrowUp' ? 'before' : 'after');
    const next = useServers.getState().servers.findIndex(server => server.id === id);
    useReorderState.setState({ announcement: { owner: instructionId,
      text: `${state.servers[index].name} 已移至第 ${next + 1} 位，共 ${state.servers.length} 个服务器` } });
  };

  return {
    instructionId,
    itemProps: (id: string) => ({
      'data-server-reorder-id': id,
      'data-server-reorder-surface': surface,
      'data-server-reorder-source': drag?.sourceId === id ? 'true' : undefined,
      'data-server-reorder-placement': drag?.targetId === id ? drag.placement : undefined,
      'aria-describedby': instructionId,
      onPointerDown: (event: PointerEvent<HTMLElement>) => onPointerDown(id, event),
      onKeyDownCapture: (event: KeyboardEvent<HTMLElement>) => onKeyDown(id, event),
      onDragStart: (event: DragEvent<HTMLElement>) => event.preventDefault(),
    }),
  };
}
