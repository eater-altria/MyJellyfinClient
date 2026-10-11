import type { BaseItem, LibraryFilterOptions } from './types';

export function normalizeAddress(input: string): string {
  let address = input.trim();
  if (!/^https?:\/\//i.test(address)) address = 'http://' + address;
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('请输入有效的 HTTP 或 HTTPS 服务器地址');
  }
  // Accept a copied web-client URL while preserving a reverse-proxy base path.
  url.pathname = url.pathname.replace(/\/web(?:\/.*)?$/i, '').replace(/\/+$/, '');
  url.search = ''; url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

export function normalizeLibraryFilters(value: unknown): LibraryFilterOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务器返回的筛选信息无效');
  const fields = value as Record<string, unknown>;
  if (!['Genres', 'Tags', 'Years'].some(key => Array.isArray(fields[key]))) throw new Error('服务器返回的筛选信息无效');
  const names = (key: string) => {
    if (!Array.isArray(fields[key])) return [];
    return [...new Set(fields[key].flatMap((entry: unknown) => {
      const name = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && 'Name' in entry ? entry.Name : null;
      return typeof name === 'string' && name.trim() ? [name] : [];
    }))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  };
  return { genres: names('Genres'), tags: names('Tags'), years: Array.isArray(fields.Years)
    ? [...new Set(fields.Years.filter((year: unknown): year is number => typeof year === 'number' && Number.isInteger(year) && year >= 1000 && year <= 9999))].sort((a, b) => b - a) : [] };
}

export function libraryItemTypes(view: BaseItem | null | undefined): string | undefined {
  if (view?.Type === 'BoxSet') return 'Movie,Series,Video,BoxSet';
  switch (view?.CollectionType) {
    case 'movies': return 'Movie';
    case 'tvshows': return 'Series';
    case 'boxsets': return 'BoxSet';
    case 'mixed': return 'Movie,Series,Video,BoxSet';
    case 'music': return 'MusicAlbum';
    case 'photos': return 'PhotoAlbum,Photo';
    default: return undefined;
  }
}

/** Metadata paths may be omitted by the server; its linked subtitle remains valid. */
export function matchesExternalSubtitleRule(videoPath: string | undefined, subtitlePath: string | undefined,
  rule: 'sameFolderSameName' | 'sameFolder' | 'none'): boolean {
  if (rule === 'none') return false;
  if (!videoPath || !subtitlePath) return true;
  const normalize = (path: string) => path.replace(/\\/g, '/').toLocaleLowerCase();
  const video = normalize(videoPath), subtitle = normalize(subtitlePath);
  const videoSlash = video.lastIndexOf('/'), subSlash = subtitle.lastIndexOf('/');
  if ((videoSlash < 0 ? '' : video.slice(0, videoSlash)) !== (subSlash < 0 ? '' : subtitle.slice(0, subSlash))) return false;
  if (rule === 'sameFolder') return true;
  const stem = video.slice(videoSlash + 1).replace(/\.[^.]+$/, '');
  const subName = subtitle.slice(subSlash + 1).replace(/\.[^.]+$/, '');
  return subName === stem || subName.startsWith(stem + '.');
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`Media server API error ${status}: ${body.slice(0, 200)}`);
  }
}

export async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// ---------- formatting helpers ----------
export function ticksToSeconds(ticks?: number): number {
  return ticks ? Math.round(ticks / 10_000_000) : 0;
}

export function formatDuration(ticks?: number): string {
  const s = ticksToSeconds(ticks);
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const min = Math.round(s / 60);
  if (h > 0) return `${h}小时${m}分钟`;
  return `${min}分钟`;
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const rr = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
}

export function formatSize(bytes?: number): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

export function formatRelativeDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const day = 86400000;
  if (diff < 3600000) return `${Math.max(1, Math.floor(diff / 60000))}分钟前`;
  if (diff < day) return `${Math.floor(diff / 3600000)}小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}天前`;
  return d.toLocaleDateString('zh-CN');
}
