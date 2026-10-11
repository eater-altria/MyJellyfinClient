import { normalizeAddress } from '../helpers';
import type { PublicSystemInfo } from '../types';
import { DEFAULT_CLIENT_IDENTITY } from '../../utils/clientIdentityValues';
import { ServerDetectionError, type DetectedServer, type DiscoveryOptions, type ServerConnector } from './types';
import type { ServerProtocol } from './index';

export interface MediaBrowserDiscoveryConfig {
  readonly apiAliases: readonly { path: string; order: number }[];
  readonly preferApiAlias: boolean;
  /** Product > server banner > version fallback. ServerName is user-defined. */
  matchPublicInfo(info: PublicSystemInfo, headers: Headers): number;
}

function hasAlias(address: string, aliases: MediaBrowserDiscoveryConfig['apiAliases']): boolean {
  const path = new URL(address).pathname.toLowerCase();
  return aliases.some(alias => path.endsWith(alias.path.toLowerCase()));
}

function candidateAddresses(address: string, configs: readonly MediaBrowserDiscoveryConfig[]): string[] {
  const aliases = configs.flatMap(config => config.apiAliases).sort((a, b) => a.order - b.order);
  const path = new URL(address).pathname.toLowerCase();
  const suffix = aliases.find(alias => path.endsWith(alias.path.toLowerCase()));
  return [...new Set(suffix ? [address, address.slice(0, -suffix.path.length)] : [address, ...aliases.map(alias => address + alias.path)])];
}

function identifyProtocol(info: PublicSystemInfo, headers: Headers,
  configs: readonly (ServerConnector & MediaBrowserDiscoveryConfig)[]): ServerProtocol | null {
  let score = 0;
  let protocol: ServerProtocol | null = null;
  for (const config of configs) {
    const match = config.matchPublicInfo(info, headers);
    if (match > score) { score = match; protocol = config.id as ServerProtocol; }
  }
  return protocol;
}

/** Probe only public endpoints; credentials are sent after a supported server is identified. */
export async function discoverMediaBrowser(input: string, options: DiscoveryOptions, connectors: readonly ServerConnector[]): Promise<DetectedServer> {
  const configs = connectors as readonly (ServerConnector & MediaBrowserDiscoveryConfig)[];
  let address: string;
  try { address = normalizeAddress(input); }
  catch { throw new ServerDetectionError('服务器地址无效，请输入 HTTP 或 HTTPS 地址'); }
  let unrecognized = false;
  let rootFallback: DetectedServer | undefined;
  const identities = options.clientIdentities
    ? options.protocol ? [options.clientIdentities[options.protocol] ?? DEFAULT_CLIENT_IDENTITY] : configs.map(connector => options.clientIdentities?.[connector.id as ServerProtocol] ?? DEFAULT_CLIENT_IDENTITY)
    : [DEFAULT_CLIENT_IDENTITY];
  const distinctIdentities = [...new Map(identities.map(identity => [JSON.stringify(identity), identity])).values()];
  for (const candidate of candidateAddresses(address, configs)) {
    // Emby may expose public metadata at / while its media proxy expects
    // /emby. Prefer a validated prefix belonging to the same server.
    const fallbackProtocol = rootFallback?.protocol;
    if (fallbackProtocol && !hasAlias(candidate, configs.find(connector => connector.id === fallbackProtocol)!.apiAliases)) continue;
    // The product is unknown until discovery succeeds. Try each configured
    // identity against the public endpoint without sending account credentials.
    for (const identity of distinctIdentities) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, options.timeoutMs ?? 5000);
      try {
        // Legacy automatic discovery starts with Jellyfin's credential-free header.
        const headers = (configs.find(connector => connector.id === options.protocol) ?? configs[0]).publicHeaders(identity);
        let authorizationOnly = false;
        const request = (requestHeaders: Record<string, string>) => fetch(candidate + '/System/Info/Public', {
          headers: requestHeaders, signal: controller.signal, cache: 'no-store',
        });
        let response: Response;
        try { response = await request(headers); }
        catch (error) {
          if (!(error instanceof TypeError) || controller.signal.aborted) throw error;
          // Some media proxies permit Authorization but omit X-Emby-* from
          // their CORS allowlist. Retry only credential-free discovery; never
          // replay login or mutations after an ambiguous transport failure.
          response = await request({ Authorization: headers['X-Emby-Authorization'], Accept: headers.Accept });
          authorizationOnly = true;
        }
        if (!response.ok) continue;
        const info = await response.json() as PublicSystemInfo;
        if (!info || typeof info.Id !== 'string' || !info.Id || typeof info.Version !== 'string' || !info.Version) continue;
        const protocol = options.protocol ?? identifyProtocol(info, response.headers, configs);
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
        const detected = { address: normalizeAddress(sameOrigin || secureUpgrade ? endpoint.toString() : candidate), protocol, info,
          ...(authorizationOnly ? { authorizationOnly: true } : {}) };
        if (rootFallback && (info.Id !== rootFallback.info.Id || protocol !== rootFallback.protocol)) continue;
        const config = configs.find(connector => connector.id === protocol)!;
        if (config.preferApiAlias && candidate === address && !hasAlias(candidate, config.apiAliases)) {
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
    ? `无法识别服务器类型，请确认地址指向 ${connectors.map(connector => connector.name).join(' 或 ')} 服务器`
    : `未检测到 ${connectors.map(connector => connector.name).join(' 或 ')} 服务器，请检查地址、网络和反向代理路径`);
}
