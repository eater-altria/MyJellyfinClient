import { getDeviceId } from './mediaBrowserAuth';
import { SENPLAYER_CLIENT_IDENTITY, SENPLAYER_USER_AGENT, senPlayerAuthHeader, senPlayerClientIdentity } from './senPlayerCompatibility';
import { MediaBrowserApi } from './MediaBrowserApi';
import { normalizeAddress, normalizeLibraryFilters } from '../helpers';
import type { LibraryFilterOptions } from '../types';
import type { ApiConnection, ServerConnector } from './types';
import { discoverMediaBrowser, type MediaBrowserDiscoveryConfig } from './mediaBrowserDiscovery';

export class JellyfinConnectorApi extends MediaBrowserApi {
  protected readonly authScheme = 'MediaBrowser';
  constructor(connection: ApiConnection) {
    super(connection.address, connection.token, connection.userId, 'jellyfin', connection.identity,
      connection.deviceId, connection.authorizationOnly);
  }

  async getLibraryFilters(parentId: string, includeItemTypes?: string, signal?: AbortSignal): Promise<LibraryFilterOptions> {
    // Filters2 omits years on some supported Jellyfin versions.
    return normalizeLibraryFilters(await this.get<unknown>('/Items/Filters', {
      UserId: this.userId, ParentId: parentId, IncludeItemTypes: includeItemTypes,
    }, signal));
  }
}

export const jellyfinConnector: ServerConnector & MediaBrowserDiscoveryConfig & { readonly id: 'jellyfin' } = {
  id: 'jellyfin', name: 'Jellyfin', icon: 'jellyfin',
  clientNamePresets: ['Jellyfin Media Player', 'Jellyfin Web', 'Jellyfin Android', 'Infuse', 'SenPlayer'],
  fixedClientIdentity: SENPLAYER_CLIENT_IDENTITY,
  supportsDeviceRegistration: false, requiresNativePlaybackInfo: false,
  discover: discoverMediaBrowser,
  loginAddress: normalizeAddress,
  publicHeaders: identity => ({ 'X-Emby-Authorization': senPlayerAuthHeader(senPlayerClientIdentity(identity), getDeviceId()), Accept: '*/*', 'User-Agent': SENPLAYER_USER_AGENT }),
  apiAliases: [{ path: '/jellyfin', order: 2 }],
  preferApiAlias: false,
  matchPublicInfo(info, headers) {
    const product = info.ProductName?.toLowerCase() ?? '';
    if (product.includes('jellyfin')) return 100;
    if (!product && headers.get('Server')?.toLowerCase().includes('jellyfin')) return 80;
    const major = Number(info.Version?.match(/^(\d+)\./)?.[1]);
    return !product && major >= 10 ? 10 : 0;
  },
  createApi: (connection: ApiConnection) => new JellyfinConnectorApi(connection),
};
