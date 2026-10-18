import { Channel, invoke } from '@tauri-apps/api/core';
import { isTauri } from './window';

interface MediaServerRequestOptions extends Omit<RequestInit, 'body'> {
  body?: string;
  publicDiscovery?: boolean;
}

interface NativeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  url: string;
}

/** Desktop API traffic uses system TLS and a validated standard/compatibility UA.
 * Browser builds retain fetch/CORS; never retry a login through another transport.
 */
export async function mediaServerRequest(url: string, options: MediaServerRequestOptions = {}): Promise<Response> {
  const { publicDiscovery = false, ...init } = options;
  if (!isTauri) {
    // Browsers own User-Agent. Do not add an unsupported CORS request header.
    const headers = new Headers(init.headers);
    headers.delete('User-Agent');
    return fetch(url, { ...init, headers });
  }
  const signal = init.signal;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const requestId = crypto.randomUUID();
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let started = false;
    let cancelled = false;
    const cancelNative = () => { void invoke('cancel_media_server_request', { requestId }).catch(() => {}); };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      action();
    };
    const abort = () => {
      cancelled = true;
      finish(() => reject(new DOMException('Aborted', 'AbortError')));
      if (started) cancelNative();
    };
    const onResponse = new Channel<{ Ok: NativeResponse } | { Err: string }>();
    onResponse.onmessage = message => finish(() => {
      if ('Err' in message) { reject(new Error(message.Err)); return; }
      try {
        const data = message.Ok;
        const response = new Response([204, 205, 304].includes(data.status) ? null : data.body,
          { status: data.status, headers: data.headers });
        Object.defineProperties(response, { url: { value: data.url }, redirected: { value: data.url !== url } });
        resolve(response);
      } catch { reject(new Error('服务器响应无效')); }
    });
    signal?.addEventListener('abort', abort, { once: true });
    void invoke('start_media_server_request', {
      requestId, onResponse,
      request: { url, method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)),
        body: init.body, publicDiscovery, rejectRedirects: init.redirect === 'error' },
    }).then(() => {
      // Registration is acknowledged before cancelling, including aborts that
      // happen while the start command is still crossing IPC.
      started = true;
      if (cancelled) cancelNative();
    }).catch(() => finish(() => reject(new Error('无法启动服务器请求'))));
  });
}
