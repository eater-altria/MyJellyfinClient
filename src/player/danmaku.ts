import { danmakuDisplayDuration, type DanmakuSettings } from './danmakuSettings';

export const DANMAKU_MAX_BYTES = 16 * 1024 * 1024;
export const DANMAKU_MAX_COMMENTS = 50_000;
export interface DanmakuComment {
  time: number;
  mode: 1 | 4 | 5 | 6;
  color: number;
  text: string;
}

function comment(time: string, mode: string, color: string, text: unknown): DanmakuComment | null {
  const t = Number(time), m = Number(mode), c = Number(color);
  if (!time.trim() || !mode.trim() || !color.trim() || !Number.isFinite(t) || t < 0 || t > 604800
    || ![1, 2, 3, 4, 5, 6].includes(m) || !Number.isInteger(c) || c < 0 || c > 0xffffff || typeof text !== 'string') return null;
  const content = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
  return content ? { time: t, mode: (m <= 3 ? 1 : m) as DanmakuComment['mode'], color: c, text: content } : null;
}

/** Bilibili XML and Dandanplay JSON use different p-field positions. */
export function parseDanmaku(input: string): DanmakuComment[] {
  if (new TextEncoder().encode(input).length > DANMAKU_MAX_BYTES) throw new Error('弹幕文件超过 16 MB');
  const comments: DanmakuComment[] = [];
  if (input.trimStart().startsWith('<')) {
    if (/<!DOCTYPE|<!ENTITY/i.test(input)) throw new Error('不支持包含文档类型或实体声明的弹幕');
    const doc = new DOMParser().parseFromString(input, 'application/xml');
    if (doc.querySelector('parsererror') || doc.documentElement.tagName !== 'i') throw new Error('弹幕 XML 格式无效');
    const nodes = doc.getElementsByTagName('d');
    if (nodes.length > DANMAKU_MAX_COMMENTS) throw new Error('弹幕超过 50000 条，请先精简文件');
    for (const node of Array.from(nodes)) {
      const p = (node.getAttribute('p') ?? '').split(',');
      if (p.length < 4) continue;
      const value = comment(p[0], p[1], p[3], node.textContent);
      if (value) comments.push(value);
    }
  } else {
    let data: unknown;
    try { data = JSON.parse(input); } catch { throw new Error('弹幕响应格式无效'); }
    if (!data || typeof data !== 'object') throw new Error('弹幕响应格式无效');
    const fields = data as Record<string, unknown>;
    const entries = fields.comments ?? fields.Comments;
    if (!Array.isArray(entries) || fields.success === false || fields.Success === false) throw new Error('弹幕响应格式无效');
    if (entries.length > DANMAKU_MAX_COMMENTS) throw new Error('弹幕超过 50000 条，请先精简文件');
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const p = entry.p ?? entry.P;
      if (typeof p !== 'string') continue;
      const parts = p.split(',');
      if (parts.length < 3) continue;
      const value = comment(parts[0], parts[1], parts[2], entry.m ?? entry.text ?? entry.Text);
      if (value) comments.push(value);
    }
  }
  const unique = new Set<string>();
  return comments.sort((a, b) => a.time - b.time).filter(c => {
    const key = JSON.stringify([c.time, c.mode, c.color, c.text]);
    if (unique.has(key)) return false;
    unique.add(key); return true;
  });
}

export async function readDanmakuResponse(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (length > DANMAKU_MAX_BYTES) throw new Error('弹幕文件超过 16 MB');
  if (!response.body) return response.text();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > DANMAKU_MAX_BYTES) { await reader.cancel(); throw new Error('弹幕文件超过 16 MB'); }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

export interface PositionedDanmaku extends DanmakuComment { row: number; width: number; }

/** Deterministic lanes, independent of playback direction and frame frequency. */
export function layoutDanmaku(comments: DanmakuComment[], width: number, height: number, settings: DanmakuSettings,
  measure: (text: string) => number): PositionedDanmaku[] {
  const lineHeight = settings.danmakuFontSize * 1.4;
  const duration = danmakuDisplayDuration(settings.danmakuDuration);
  const totalRows = Math.max(1, Math.floor(Math.max(0, height - 100) / lineHeight));
  const rows = Math.max(1, Math.floor(totalRows * settings.danmakuArea));
  const lane = Array<PositionedDanmaku | undefined>(totalRows).fill(undefined);
  const result: PositionedDanmaku[] = [];
  for (const c of comments) {
    const size = Math.ceil(measure(c.text)) + 8;
    const available = (previous: PositionedDanmaku | undefined) => {
      if (!previous) return true;
      const delta = c.time - previous.time;
      if (c.mode !== previous.mode || c.mode === 4 || c.mode === 5) return delta >= duration;
      const oldSpeed = (width + previous.width) / duration;
      const newSpeed = (width + size) / duration;
      // The previous tail must have entered, and the new head must not catch it.
      return oldSpeed * delta >= previous.width + 12
        && (newSpeed <= oldSpeed || newSpeed * Math.max(0, duration - delta) <= width - 12);
    };
    let row = -1;
    for (let i = 0; i < rows; i++) {
      const candidate = c.mode === 4 ? totalRows - 1 - i : i;
      if (available(lane[candidate])) { row = candidate; break; }
    }
    if (row < 0) continue;
    const placed = { ...c, row, width: size };
    lane[row] = placed; result.push(placed);
  }
  return result;
}

export function danmakuAtTime(comments: PositionedDanmaku[], time: number, duration: number): PositionedDanmaku[] {
  let lo = 0, hi = comments.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (comments[mid].time <= time - duration) lo = mid + 1; else hi = mid; }
  const visible: PositionedDanmaku[] = [];
  for (let i = lo; i < comments.length && comments[i].time <= time; i++) visible.push(comments[i]);
  return visible;
}
