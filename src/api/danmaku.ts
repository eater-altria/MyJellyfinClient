import type { BaseItem, MediaServerApi } from './mediaServer';
import { parseDanmaku, readDanmakuResponse } from '../player/danmaku';

export interface DanmakuChoice { id: string; label: string; title: string; episode: string; }

export function danmakuApiBase(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('请在设置中填写有效的弹幕 API 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('弹幕 API 地址需为 HTTP / HTTPS，不含查询参数、账号或密码');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api\/v2$/i, '') + '/api/v2';
  return url.toString().replace(/\/+$/, '');
}

class DanmakuHttpError extends Error {
  constructor(readonly status: number) { super(`弹幕服务请求失败（HTTP ${status}）`); }
}

async function request(url: string, signal: AbortSignal, body?: Record<string, unknown>): Promise<string> {
  // Custom services receive no media-server credentials, cookies or headers.
  const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer',
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new DanmakuHttpError(response.status);
  return readDanmakuResponse(response);
}

export async function searchDanmaku(base: string, keyword: string, signal: AbortSignal): Promise<DanmakuChoice[]> {
  const url = `${danmakuApiBase(base)}/search/episodes?anime=${encodeURIComponent(keyword)}`;
  let data: Record<string, unknown>;
  try { data = JSON.parse(await request(url, signal)); } catch (e) {
    if (e instanceof SyntaxError) throw new Error('弹幕搜索响应格式无效');
    throw e;
  }
  if (!data || typeof data !== 'object' || data.success === false || data.Success === false) throw new Error('弹幕搜索失败');
  const animes = data.animes ?? data.Animes;
  if (!Array.isArray(animes)) throw new Error('弹幕搜索响应格式无效');
  const choices: DanmakuChoice[] = [];
  for (const anime of animes) {
    const title = anime?.animeTitle ?? anime?.AnimeTitle;
    const episodes = anime?.episodes ?? anime?.Episodes;
    if (typeof title !== 'string' || !Array.isArray(episodes)) continue;
    for (const episode of episodes) {
      const id = episode?.episodeId ?? episode?.EpisodeId;
      const name = episode?.episodeTitle ?? episode?.EpisodeTitle;
      if ((typeof id !== 'string' && typeof id !== 'number') || typeof name !== 'string') continue;
      if (String(id).length > 512 || name.length > 300 || title.length > 300) continue;
      choices.push({ id: String(id), title, episode: name, label: `${name} · ${title}` });
      if (choices.length > 20_000) throw new Error('弹幕搜索结果过多，请使用更具体的片名');
    }
  }
  return choices;
}

export async function loadDanmakuChoice(base: string, id: string, signal: AbortSignal) {
  return parseDanmaku(await request(`${danmakuApiBase(base)}/comment/${encodeURIComponent(id)}?format=xml`, signal));
}

export async function loadServerDanmaku(api: MediaServerApi, itemId: string, signal: AbortSignal) {
  if (!api.getDanmakuXml) throw new Error('当前服务器不支持读取弹幕');
  const xml = await api.getDanmakuXml(itemId, signal);
  if (xml === null) throw new Error('服务器没有此视频的 XML 弹幕，请安装弹幕插件并匹配，或导入 XML');
  return parseDanmaku(xml);
}

export function danmakuKeyword(item: BaseItem): string { return item.SeriesName || item.Name; }

/** Metadata-only identification: no video download, hash, file path or media credentials. */
export function danmakuMatchRequest(item: BaseItem): Record<string, unknown> | null {
  const title = danmakuKeyword(item).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!title) return null;
  const episode = item.Type === 'Episode' || !!item.SeriesName;
  if (episode && (!Number.isInteger(item.ParentIndexNumber) || item.ParentIndexNumber! < 0
    || !Number.isInteger(item.IndexNumber) || item.IndexNumber! <= 0)) return null;
  const year = Number.isInteger(item.ProductionYear) && item.ProductionYear! >= 1900 && item.ProductionYear! <= 2100
    ? ` (${item.ProductionYear})` : '';
  const numbering = episode ? ` S${String(item.ParentIndexNumber).padStart(2, '0')}E${String(item.IndexNumber).padStart(2, '0')}` : '';
  const duration = (item.RunTimeTicks ?? item.MediaSources?.[0]?.RunTimeTicks ?? 0) / 10_000_000;
  return { fileName: `${title}${year}${numbering}`, matchMode: 'fileNameOnly',
    ...(Number.isFinite(duration) && duration > 0 ? { videoDuration: Math.round(duration) } : {}) };
}

export async function matchDanmaku(base: string, item: BaseItem, signal: AbortSignal): Promise<DanmakuChoice | null> {
  const body = danmakuMatchRequest(item);
  if (!body) return null;
  let text: string;
  try { text = await request(`${danmakuApiBase(base)}/match`, signal, body); }
  catch (e) { if (e instanceof DanmakuHttpError && [404, 405, 501].includes(e.status)) return null; throw e; }
  let data: Record<string, unknown>;
  try { data = JSON.parse(text); } catch { throw new Error('弹幕匹配响应格式无效'); }
  if (!data || typeof data !== 'object' || data.success === false || data.Success === false) throw new Error('弹幕自动匹配失败');
  const matches = data.matches ?? data.Matches;
  if (!Array.isArray(matches) || typeof (data.isMatched ?? data.IsMatched) !== 'boolean') throw new Error('弹幕匹配响应格式无效');
  if (!(data.isMatched ?? data.IsMatched) || matches.length !== 1) return null;
  const match = matches[0];
  const id = match?.episodeId ?? match?.EpisodeId, title = match?.animeTitle ?? match?.AnimeTitle,
    episode = match?.episodeTitle ?? match?.EpisodeTitle;
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id) || String(id).length > 512
    || typeof title !== 'string' || title.length > 300 || typeof episode !== 'string' || episode.length > 300) {
    throw new Error('弹幕匹配响应格式无效');
  }
  return { id: String(id), title, episode, label: `${episode} · ${title}` };
}
