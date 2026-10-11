import { create } from 'zustand';

export type ServerReorderSurface = 'grid' | 'sidebar';
export interface ServerDrag {
  owner: string;
  sourceId: string;
  targetId: string | null;
  placement: 'before' | 'after';
  surface: ServerReorderSurface;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  x: number;
  y: number;
}

/** Transient feedback shared across both surfaces; only servers.ts persists the committed order. */
export const useServerReorder = create<{
  owner: string | null;
  drag: ServerDrag | null;
  announcement: { owner: string; text: string } | null;
}>(() => ({ owner: null, drag: null, announcement: null }));
