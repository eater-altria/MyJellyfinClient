import { getDeviceId } from './mediaBrowserAuth';
import { SENPLAYER_CLIENT_IDENTITY, SENPLAYER_USER_AGENT, senPlayerAuthHeader, senPlayerClientIdentity } from './senPlayerCompatibility';
import { MediaBrowserApi } from './MediaBrowserApi';
import { ApiError, normalizeLibraryFilters } from '../helpers';
import type { LibraryFilterOptions } from '../types';
import type { ApiConnection, ServerConnector } from './types';
import { discoverMediaBrowser, type MediaBrowserDiscoveryConfig } from './mediaBrowserDiscovery';
import { senPlayerEmbyApiAddress } from './senPlayerCompatibility';

export class EmbyConnectorApi extends MediaBrowserApi {
  protected readonly authScheme = 'Emby';
  constructor(connection: ApiConnection) {
    super(connection.address,
      connection.token, connection.userId, 'emby', connection.identity,
      connection.deviceId, connection.authorizationOnly);
  }

  protected playbackInfoParams(options: Record<string, unknown>): Record<string, unknown> { return options; }

  async getLibraryFilters(parentId: string, includeItemTypes?: string, signal?: AbortSignal): Promise<LibraryFilterOptions> {
    const scope = { UserId: this.userId, ParentId: parentId, IncludeItemTypes: includeItemTypes };
    const legacy = async () => normalizeLibraryFilters(await this.get<unknown>('/Items/Filters', scope, signal));
    const namedItems = async (path: string) => {
      const names = new Set<string>();
      const limit = 100;
      let startIndex = 0;
      while (!signal?.aborted) {
        const value = await this.get<unknown>(path, { ...scope, Recursive: true, EnableImages: false,
          EnableUserData: false, EnableTotalRecordCount: true, Limit: limit, StartIndex: startIndex }, signal);
        const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
        const items = Array.isArray(value) ? value : record?.Items ?? record?.items;
        if (!Array.isArray(items)) throw new Error('服务器返回的筛选信息无效');
        const before = names.size;
        let validNames = 0;
        for (const item of items) {
          const name = typeof item === 'string' || typeof item === 'number' ? String(item)
            : item && typeof item === 'object' ? item.Name ?? item.name : null;
          if (typeof name === 'string' && name.trim()) { names.add(name); validNames++; }
        }
        if (items.length && !validNames) throw new Error('服务器返回的筛选信息无效');
        startIndex += items.length;
        const total = record?.TotalRecordCount ?? record?.totalRecordCount;
        // Some versions return an unwrapped array or ignore paging. Detect a
        // repeated page by its names rather than repeatedly fetching forever.
        if (!items.length || names.size === before || (typeof total === 'number' && Number.isFinite(total) && total >= 0
          ? startIndex >= total : items.length < limit)) break;
      }
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return [...names];
    };
    const music = includeItemTypes?.split(',').every(type => ['MusicAlbum', 'Audio', 'MusicVideo', 'MusicArtist'].includes(type));
    const results = await Promise.allSettled([
      namedItems(music ? '/MusicGenres' : '/Genres'), namedItems('/Tags'), namedItems('/Years'),
    ]);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // Inspect every failure: a fast 404 must not hide a simultaneous 401/403
    // from another named service by silently selecting a legacy endpoint.
    const failure = results.find(result => result.status === 'rejected'
      && !(result.reason instanceof ApiError && [404, 405, 501].includes(result.reason.status)));
    if (failure?.status === 'rejected') throw failure.reason;
    if (results.some(result => result.status === 'rejected')) return legacy();
    const [genres, tags, years] = results.map(result => result.status === 'fulfilled' ? result.value : []);
    return normalizeLibraryFilters({ Genres: genres, Tags: tags, Years: years.filter(year => /^\d{4}$/.test(year)).map(Number) });
  }

}

export const embyConnector: ServerConnector & MediaBrowserDiscoveryConfig & { readonly id: 'emby' } = {
  id: 'emby', name: 'Emby', icon: 'emby',
  clientNamePresets: ['Emby Theater', 'Emby Web', 'Emby for Android', 'Infuse', 'SenPlayer'],
  fixedClientIdentity: SENPLAYER_CLIENT_IDENTITY,
  supportsDeviceRegistration: true, requiresNativePlaybackInfo: true,
  discover: discoverMediaBrowser,
  loginAddress: senPlayerEmbyApiAddress,
  publicHeaders: identity => ({ 'X-Emby-Authorization': senPlayerAuthHeader(senPlayerClientIdentity(identity), getDeviceId()), Accept: '*/*', 'User-Agent': SENPLAYER_USER_AGENT }),
  apiAliases: [{ path: '/emby', order: 1 }, { path: '/mediabrowser', order: 3 }],
  preferApiAlias: true,
  matchPublicInfo(info, headers) {
    const product = info.ProductName?.toLowerCase() ?? '';
    if (product.includes('emby') || product.includes('mediabrowser')) return 100;
    if (!product && headers.get('Server')?.toLowerCase().includes('emby')) return 80;
    // Some Emby proxies replace the product name with custom branding.
    const major = Number(info.Version?.match(/^(\d+)\./)?.[1]);
    return major === 3 || major === 4 ? 10 : 0;
  },
  createApi: (connection: ApiConnection) => new EmbyConnectorApi(connection),
};
