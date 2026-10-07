import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../platform/window';

const sensitiveKey = /token|password|authorization|cookie|secret|api[_-]?key|^pw$/i;

export function redactPlaybackText(value: string, secrets: string[] = []): string {
  let text = value;
  for (const secret of secrets.filter(Boolean)) {
    for (const form of [secret, encodeURIComponent(secret)]) text = text.split(form).join('[redacted]');
  }
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>,]+/gi, '$1 [redacted]')
    .replace(/(["']?(?:authorization|x-emby-token|cookie|set-cookie|api[_-]?key|access[_-]?token|token|password|pwd|pw|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[redacted]');
}

export function sanitizePlaybackDetails(value: unknown, secrets: string[] = [], depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return redactPlaybackText(value, secrets).slice(0, 1024);
  if (Array.isArray(value)) return value.slice(0, 32).map(entry => sanitizePlaybackDetails(entry, secrets, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 48)
    .map(([key, entry]) => [key, sensitiveKey.test(key) ? '[redacted]' : sanitizePlaybackDetails(entry, secrets, depth + 1)]));
  return value;
}

export function playbackErrorDetails(error: unknown, secrets: string[] = []) {
  const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
  const body = error && typeof error === 'object' && 'body' in error && typeof error.body === 'string' ? error.body : undefined;
  const message = status != null && body != null ? `服务器请求失败（HTTP ${status}）：${redactPlaybackText(body, secrets).slice(0, 200)}`
    : redactPlaybackText(error instanceof Error ? error.message : String(error), secrets).slice(0, 1024);
  return { name: error instanceof Error ? error.name : 'Error', httpStatus: status, message };
}

export function describePlaybackUrl(value: string, base: string) {
  try {
    const url = new URL(value), server = new URL(base);
    return { scheme: url.protocol, sameServerOrigin: url.origin === server.origin,
      kind: /\.m3u8$/i.test(url.pathname) ? 'hls' : /\/stream(?:\.[^/]*)?$/i.test(url.pathname) ? 'direct' : 'other',
      queryParameterCount: [...url.searchParams.keys()].length };
  } catch { return { kind: 'invalid' }; }
}

/** Compare routing without persisting hostnames, media IDs, or signed URLs. */
export async function describePlaybackRoute(value: string, base: string) {
  const url = new URL(value), server = new URL(base);
  const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const route = url.pathname.match(/^(.*?)\/(Videos|Items)\/[^/]+\/(.*)$/i);
  const leaf = route?.[3]?.toLowerCase();
  return {
    ...describePlaybackUrl(value, base),
    originFingerprint: await digest(url.origin), serverOriginFingerprint: await digest(server.origin),
    collection: route?.[2]?.toLowerCase() ?? 'other',
    endpoint: ['original.mkv', 'stream', 'stream.mkv', 'download', 'master.m3u8'].includes(leaf ?? '') ? leaf : 'other',
    prefixSegments: route?.[1]?.split('/').filter(Boolean).length ?? null,
    embyPrefix: /\/emby(?:\/|$)/i.test(url.pathname),
    queryNames: [...url.searchParams.keys()].filter(key => ['deviceid','mediasourceid','playsessionid','api_key','x-emby-token','static'].includes(key.toLowerCase())),
  };
}

export function createPlaybackDiagnostics(secrets: string[] = []) {
  const id = crypto.randomUUID(), startedAt = performance.now();
  return {
    id,
    record(stage: string, details: Record<string, unknown> = {}) {
      const safe = sanitizePlaybackDetails({ ...details, elapsedMs: Math.round(performance.now() - startedAt) }, secrets);
      if (isTauri) void invoke('record_playback_diagnostic', { traceId: id, stage, details: safe }).catch(() => {});
      else console.debug('[playback]', id, stage, safe);
    },
  };
}
