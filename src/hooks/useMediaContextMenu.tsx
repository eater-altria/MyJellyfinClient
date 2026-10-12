import { type BaseItem, type MediaServerApi } from '../api/mediaServer';
import { IconCheck, IconStar } from '../components/icons';
import { contextMenuProps } from '../components/ContextMenu';
import { updateBrowseUserData } from '../utils/browseHistory';

const pendingWrites = new WeakMap<MediaServerApi, Set<string>>();
async function commit(api: MediaServerApi, id: string, work: () => Promise<void>) {
  const pending = pendingWrites.get(api) ?? new Set<string>();
  pendingWrites.set(api, pending);
  if (pending.has(id)) throw new Error('此媒体正在保存');
  pending.add(id);
  try { await work(); } finally { pending.delete(id); }
}

/** Commit server-side state before notifying every retained view for this API identity. */
export function mediaContextMenuProps(api: MediaServerApi, item: BaseItem) {
  return contextMenuProps([
    { label: item.UserData?.IsFavorite ? '取消收藏' : '收藏', icon: <IconStar size={16} />, run: () => commit(api, item.Id, async () => {
      const favorite = !item.UserData?.IsFavorite;
      await api.setFavorite(item.Id, favorite);
      updateBrowseUserData(api, item.Id, { IsFavorite: favorite });
    }) },
    { label: item.UserData?.Played ? '标记为未观看' : '标记为已观看', icon: <IconCheck size={16} />, run: () => commit(api, item.Id, async () => {
      const played = !item.UserData?.Played;
      if (played) await api.markPlayed(item.Id); else await api.markUnplayed(item.Id);
      updateBrowseUserData(api, item.Id, { Played: played, PlaybackPositionTicks: 0, PlayedPercentage: played ? 100 : 0 });
    }) },
  ]);
}
