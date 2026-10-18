import { Channel, invoke } from '@tauri-apps/api/core';
import { isTauri } from './window';
import { SYNC_MAX_BYTES } from '../sync/serverSync';

export const WEBDAV_FILE = 'myjellyfinclient-servers-v1.json';
export interface WebDavCredentials { directory: string; username: string; password: string; }
export interface WebDavResponse { status: number; etag?: string; body: string; }
export type WebDavWrite = { body: string; etag: string | null };

function permitsHttp(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const privateIpv4 = (parts: number[]) => parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    && (parts[0] === 10 || parts[0] === 127 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 169 && parts[1] === 254));
  // URL has already canonicalized IP literals. Classify the address, never a DNS-name prefix.
  if (!hostname.startsWith('[')) return privateIpv4(hostname.split('.').map(Number));
  const mapped = /^\[::ffff:([0-9a-f]+):([0-9a-f]+)\]$/.exec(hostname);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return privateIpv4([high >> 8, high & 255, low >> 8, low & 255]);
  }
  const first = parseInt(hostname.slice(1).split(':')[0], 16);
  return Number.isFinite(first) && ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80);
}

export function webDavFileUrl(directory: string): string {
  let url: URL;
  try { url = new URL(directory.trim()); } catch { throw new Error('请输入完整的 WebDAV HTTP 或 HTTPS 目录地址'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && permitsHttp(url.hostname)))
    || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('WebDAV 公网目录须使用 HTTPS（内网 IP 和本机地址允许 HTTP），地址不能包含账号、查询参数或片段');
  }
  url.pathname = url.pathname.replace(/\/*$/, '/') + WEBDAV_FILE;
  return url.toString();
}

export function requireStrongEtag(value: string | undefined): string {
  if (!value || !/^"[\x21\x23-\x7e]{1,512}"$/.test(value)) {
    throw new Error('WebDAV 未提供可用的强 ETag，无法安全覆盖；网页版请检查是否暴露 ETag 响应头');
  }
  return value;
}

function authorization(username: string, password: string): string {
  if (!username || username.length > 1024 || username.includes(':') || /[\r\n]/.test(username)
    || !password || password.length > 8192 || /[\r\n]/.test(password)) throw new Error('请输入有效的 WebDAV 账号和密码');
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

async function browserRequest(url: string, auth: string, write: WebDavWrite | undefined, signal: AbortSignal): Promise<WebDavResponse> {
  const response = await fetch(url, { method: write ? 'PUT' : 'GET', signal,
    credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: { Authorization: auth, Accept: 'application/json', ...(write ? {
      'Content-Type': 'application/json', ...(write.etag === null ? { 'If-None-Match': '*' } : { 'If-Match': write.etag }),
    } : {}) }, body: write?.body });
  const result: WebDavResponse = { status: response.status, etag: response.headers.get('ETag') ?? undefined, body: '' };
  if (response.status !== 200 || write) { await response.body?.cancel(); return result; }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('WebDAV 响应为空');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > SYNC_MAX_BYTES) throw new Error('WebDAV 配置文件过大');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { result.body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('WebDAV 配置不是有效的 UTF-8 文件'); }
  return result;
}

function nativeRequest(url: string, auth: string, write: WebDavWrite | undefined, signal: AbortSignal): Promise<WebDavResponse> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false, started = false, cancelled = false;
    const cancel = () => { void invoke('cancel_webdav_request', { requestId }).catch(() => {}); };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); action();
    };
    const abort = () => {
      cancelled = true;
      finish(() => reject(new DOMException('Aborted', 'AbortError')));
      if (started) cancel();
    };
    if (signal.aborted) { abort(); return; }
    const onResponse = new Channel<{ Ok: WebDavResponse } | { Err: string }>();
    onResponse.onmessage = message => finish(() => 'Ok' in message ? resolve(message.Ok) : reject(new Error(message.Err)));
    signal.addEventListener('abort', abort, { once: true });
    void invoke('start_webdav_request', { requestId, onResponse, request: {
      url, authorization: auth, body: write?.body, etag: write?.etag,
    } }).then(() => { started = true; if (cancelled) cancel(); })
      .catch(() => finish(() => reject(new Error('无法启动 WebDAV 请求'))));
  });
}

export async function webDavRequest(credentials: WebDavCredentials, signal: AbortSignal, write?: WebDavWrite): Promise<WebDavResponse> {
  const url = webDavFileUrl(credentials.directory);
  const auth = authorization(credentials.username, credentials.password);
  if (write) {
    if (new TextEncoder().encode(write.body).length > SYNC_MAX_BYTES) throw new Error('同步配置过大');
    if (write.etag !== null) requireStrongEtag(write.etag);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
  try {
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const result = await (isTauri ? nativeRequest : browserRequest)(url, auth, write, controller.signal);
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (result.status === 401 || result.status === 403) throw new Error('WebDAV 账号、密码或访问权限不正确');
    if (result.status === 412) throw new Error('云端配置已改变，请重新读取后再上传');
    if (result.status === 409) throw new Error('WebDAV 目录不存在，请先创建目录');
    if (result.status === 423) throw new Error('WebDAV 文件被锁定，请稍后重试');
    if (result.status === 507) throw new Error('WebDAV 存储空间不足');
    if (write ? ![200, 201, 204].includes(result.status) : ![200, 404].includes(result.status)) {
      throw new Error(`WebDAV 请求失败（HTTP ${result.status}）`);
    }
    return result;
  } catch (error) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (timedOut) throw new Error('WebDAV 请求超时，请重试；上传超时后请先下载核对云端结果');
    if (error instanceof TypeError) throw new Error('无法连接 WebDAV，请检查网络、证书及网页跨域配置');
    throw error;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
