import type { BaseItem, MediaServerApi } from '../api/mediaServer';

export interface TrackPreference {
  id?: string | number;
  lang?: string;
  title?: string;
  codec?: string;
  external?: boolean;
}

interface RememberedTrack { mediaKey: string; track: TrackPreference }
interface Preferences { audio?: RememberedTrack; sub?: RememberedTrack; searches?: string[] }
type Store = Record<string, Preferences>;
const KEY = 'mjc:playback-preferences';

function read(): Store {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Store : {};
  }
  catch { return {}; }
}
function write(value: Store) {
  try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* Storage can be unavailable. */ }
}

export function getPlaybackPreferences(serverId: string, mediaKey: string, settings: {
  rememberAudioTrack: boolean; rememberSubtitle: boolean; subtitleSearchHistory: boolean;
}) {
  const saved = read()[serverId] ?? {};
  const track = (value?: RememberedTrack): TrackPreference | undefined => {
    if (!value?.track || typeof value.track !== 'object') return undefined;
    if (value.mediaKey === mediaKey || value.track.id === 'no') return value.track;
    // mpv track IDs are per media source. Only language/title/codec can carry
    // over to another video without accidentally selecting an unrelated track.
    const { id: _id, ...metadata } = value.track;
    return Object.values(metadata).some(Boolean) ? metadata : undefined;
  };
  return {
    rememberedAudio: settings.rememberAudioTrack ? track(saved.audio) : undefined,
    rememberedSubtitle: settings.rememberSubtitle ? track(saved.sub) : undefined,
    subtitleSearchQueries: settings.subtitleSearchHistory && Array.isArray(saved.searches) ? saved.searches.filter(q => typeof q === 'string') : [],
  };
}

export function rememberTrack(serverId: string, mediaKey: string, kind: 'audio' | 'sub', track: TrackPreference) {
  const all = read();
  all[serverId] = { ...all[serverId], [kind]: { mediaKey, track } };
  write(all);
}

export function saveSubtitleSearchQueries(serverId: string, queries: string[]) {
  const all = read();
  all[serverId] = { ...all[serverId], searches: [...new Set(queries.filter(q => typeof q === 'string' && q.trim()).map(q => q.trim().slice(0, 100)))].slice(0, 10) };
  write(all);
}

/** Resolve neighbors only within the same server folder or episode series. */
export async function getAdjacentMedia(api: MediaServerApi, item: BaseItem, direction: 'prev' | 'next'): Promise<BaseItem | undefined> {
  if (item.Type === 'Episode' && item.SeriesId) {
    const { Items } = await api.getEpisodes(item.SeriesId);
    const sorted = [...Items].sort((a, b) => (a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0) || (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0));
    const index = sorted.findIndex(other => other.Id === item.Id);
    return index < 0 ? undefined : sorted[index + (direction === 'next' ? 1 : -1)];
  }
  if (!item.ParentId) return undefined;
  // Walk folder pages rather than applying an arbitrary first-page cutoff.
  let previous: BaseItem | undefined;
  let found = false;
  for (let start = 0; ; start += 200) {
    const { Items, TotalRecordCount } = await api.queryItems({ ParentId: item.ParentId,
      IncludeItemTypes: 'Movie,Video', SortBy: 'SortName', SortOrder: 'Ascending', StartIndex: start, Limit: 200 });
    for (const other of Items) {
      if (found) return other;
      if (other.Id === item.Id) {
        if (direction === 'prev') return previous;
        found = true;
      }
      previous = other;
    }
    if (Items.length < 200 || (TotalRecordCount !== undefined && start + Items.length >= TotalRecordCount)) return undefined;
  }
}
