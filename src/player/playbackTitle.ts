import { create } from 'zustand';
import type { BaseItem } from '../api/mediaServer';

export function mediaTitle(item: BaseItem): string {
  const name = item.Name?.trim() || '未知媒体';
  if (item.Type !== 'Episode') return name;
  const episode = [
    item.ParentIndexNumber != null ? `S${item.ParentIndexNumber}` : '',
    item.IndexNumber != null ? `E${item.IndexNumber}` : '',
  ].join('');
  return [item.SeriesName?.trim(), episode, name].filter(Boolean).join(' · ');
}

/** Current metadata title for the shared window header; never persisted. */
export const usePlaybackTitle = create<{ title: string; setTitle(title: string): void }>((set) => ({
  title: '',
  setTitle: (title) => set({ title }),
}));
