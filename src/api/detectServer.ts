import { clientIdentityHeaders, normalizeAddress, type PublicSystemInfo, type ServerProtocol } from './mediaServer';
import { DEFAULT_CLIENT_IDENTITY, type ClientIdentities } from '../utils/clientIdentity';

export interface DetectedServer {
  address: string;
  protocol: ServerProtocol;
  info: PublicSystemInfo;
}

export class ServerDetectionError extends Error {}

function identifyProtocol(info: PublicSystemInfo, headers: Headers): ServerProtocol | null {
  // ServerName is user-defined, so never use it (or the port) to identify a product.
  const product = info.ProductName?.toLowerCase() ?? '';
  if (product.includes('jellyfin')) return 'jellyfin';
  if (product.includes('emby') || product.includes('mediabrowser')) return 'emby';
  if (product) return null;
  const banner = headers.get('Server')?.toLowerCase() ?? '';
  if (banner.includes('jellyfin')) return 'jellyfin';
  if (banner.includes('emby')) return 'emby';
  // Emby public system info has no ProductName. Legacy servers use these version families.
  const major = Number(info.Version?.match(/^(\d+)\./)?.[1]);
  if (major >= 10) return 'jellyfin';
  if (major === 3 || major === 4) return 'emby';
  return null;
}

function candidateAddresses(address: string): string[] {
  const candidates = [address];
  if (/\/(?:emby|mediabrowser|jellyfin)$/i.test(new URL(address).pathname)) {
    candidates.push(address.replace(/\/(?:emby|mediabrowser|jellyfin)$/i, ''));
  } else {
    candidates.push(address + '/emby', address + '/jellyfin', address + '/mediabrowser');
  }
  return [...new Set(candidates)];
}

/** Probe only public endpoints; credentials are sent after a supported server is identified. */
export async function detectServer(input: string, options: { signal?: AbortSignal; timeoutMs?: number; clientIdentities?: ClientIdentities } = {}): Promise<DetectedServer> {
  let address: string;
  try { address = normalizeAddress(input); }
  catch { throw new ServerDetectionError('服务器地址无效，请输入 HTTP 或 HTTPS 地址'); }
  let unrecognized = false;
  let rootFallback: DetectedServer | undefined;
  const identities = options.clientIdentities ? Object.values(options.clientIdentities) : [DEFAULT_CLIENT_IDENTITY];
  const distinctIdentities = [...new Map(identities.map(identity => [JSON.stringify(identity), identity])).values()];
  for (const candidate of candidateAddresses(address)) {
    // Emby may expose public metadata at / while its media proxy expects
    // /emby. Prefer a validated prefix belonging to the same server.
    if (rootFallback && !/\/(?:emby|mediabrowser)$/i.test(new URL(candidate).pathname)) continue;
    // The product is unknown until discovery succeeds. Try each configured
    // identity against the public endpoint without sending account credentials.
    for (const identity of distinctIdentities) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, options.timeoutMs ?? 5000);
      try {
        const response = await fetch(candidate + '/System/Info/Public', {
          headers: clientIdentityHeaders(identity), signal: controller.signal, cache: 'no-store',
        });
        if (!response.ok) continue;
        const info = await response.json() as PublicSystemInfo;
        if (!info || typeof info.Id !== 'string' || !info.Id || typeof info.Version !== 'string' || !info.Version) continue;
        const protocol = identifyProtocol(info, response.headers);
        if (!protocol) { unrecognized = true; continue; }
        // Same-origin redirects can reveal a required API prefix. A public
        // metadata redirect to another host must not replace the chosen media
        // route or move later account credentials to that host.
        const finalUrl = response.url || candidate + '/System/Info/Public';
        const endpoint = new URL(finalUrl);
        if (!/\/System\/Info\/Public\/?$/i.test(endpoint.pathname)) continue;
        endpoint.pathname = endpoint.pathname.replace(/\/System\/Info\/Public\/?$/i, '');
        endpoint.search = ''; endpoint.hash = '';
        const requested = new URL(candidate);
        const sameOrigin = endpoint.origin === requested.origin;
        const secureUpgrade = requested.protocol === 'http:' && endpoint.protocol === 'https:'
          && requested.hostname === endpoint.hostname && !requested.port && !endpoint.port;
        const detected = { address: normalizeAddress(sameOrigin || secureUpgrade ? endpoint.toString() : candidate), protocol, info };
        if (rootFallback && (info.Id !== rootFallback.info.Id || protocol !== rootFallback.protocol)) continue;
        if (protocol === 'emby' && candidate === address && !/\/(?:emby|mediabrowser)$/i.test(requested.pathname)) {
          rootFallback = detected;
          break;
        }
        return detected;
      } catch {
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        // Changing identity cannot fix a transport/JSON failure. Try the next
        // API prefix without doubling the timeout for this same endpoint.
        break;
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
      }
    }
  }
  if (rootFallback) return rootFallback;
  throw new ServerDetectionError(unrecognized
    ? '无法识别服务器类型，请确认地址指向 Jellyfin 或 Emby 服务器'
    : '未检测到 Jellyfin 或 Emby 服务器，请检查地址、网络和反向代理路径');
}
