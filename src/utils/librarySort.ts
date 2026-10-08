export type LibrarySortKey = 'name' | 'date' | 'year' | 'rating' | 'premiere' | 'criticRating' | 'datePlayed' | 'playCount' | 'runtime';
export type LibrarySortOrder = 'Ascending' | 'Descending';

export interface LibrarySort {
  key: LibrarySortKey;
  order: LibrarySortOrder;
}

// Shared sort fields supported by both Jellyfin and Emby. Sorting stays on the
// server so the selected order applies to the whole library, including pagination.
export const LIBRARY_SORT_OPTIONS: {
  key: LibrarySortKey; label: string; sortBy: string; ascending: string; descending: string;
}[] = [
  { key: 'name', label: '名称', sortBy: 'SortName', ascending: '从 A 到 Z', descending: '从 Z 到 A' },
  { key: 'date', label: '添加日期', sortBy: 'DateCreated', ascending: '最早添加优先', descending: '最新添加优先' },
  { key: 'year', label: '年份', sortBy: 'ProductionYear', ascending: '最早年份优先', descending: '最新年份优先' },
  { key: 'premiere', label: '首播日期', sortBy: 'PremiereDate', ascending: '最早首播优先', descending: '最新首播优先' },
  { key: 'rating', label: '评分', sortBy: 'CommunityRating', ascending: '最低评分优先', descending: '最高评分优先' },
  { key: 'criticRating', label: '影评人评分', sortBy: 'CriticRating', ascending: '最低评分优先', descending: '最高评分优先' },
  { key: 'datePlayed', label: '播放日期', sortBy: 'DatePlayed', ascending: '最早播放优先', descending: '最近播放优先' },
  { key: 'playCount', label: '播放次数', sortBy: 'PlayCount', ascending: '最少播放优先', descending: '最多播放优先' },
  { key: 'runtime', label: '时长', sortBy: 'Runtime', ascending: '最短时长优先', descending: '最长时长优先' },
];

export const DEFAULT_LIBRARY_SORT: LibrarySort = { key: 'name', order: 'Ascending' };

export function normalizeLibrarySort(value: unknown): LibrarySort {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const option = LIBRARY_SORT_OPTIONS.find(item => item.key === saved.key);
  return {
    key: option?.key ?? DEFAULT_LIBRARY_SORT.key,
    order: saved.order === 'Ascending' || saved.order === 'Descending' ? saved.order : DEFAULT_LIBRARY_SORT.order,
  };
}

/** IDs only: never persist server addresses, credentials or artwork with preferences. */
export function librarySortScope(serverId: string, userId: string | undefined, libraryId: string): string {
  return JSON.stringify([serverId, userId ?? '', libraryId]);
}
