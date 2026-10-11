/** Test backend with unrelated endpoints and payloads; never registered in the app. */
import { DEFAULT_CLIENT_IDENTITY } from '../../src/utils/clientIdentityValues';
import { normalizeAddress, ApiError } from '../../src/api/helpers';
import { ServerDetectionError, type ApiConnection, type MediaServerApi, type ServerConnector } from '../../src/api/connectors/types';

const unsupported = (): never => { throw new Error('Unused fixture operation'); };

function createApi(connection: ApiConnection): MediaServerApi {
  const baseUrl = normalizeAddress(connection.address);
  const clientIdentity = () => connection.identity?.() ?? DEFAULT_CLIENT_IDENTITY;
  const request = async (path: string, body?: unknown, signal?: AbortSignal) => {
    const response = await fetch(baseUrl + path, { signal, method: body ? 'POST' : 'GET',
      headers: { ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}),
        'X-Fixture-Client': clientIdentity().name, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new ApiError(response.status, 'fixture failure');
    return response.json();
  };
  return {
    baseUrl, token: connection.token, userId: connection.userId, protocol: 'fixture', clientIdentity,
    get: unsupported, post: unsupported, del: unsupported,
    getPublicSystemInfo: async signal => {
      const info = await request('/about', undefined, signal);
      return { Id: info.instance, Version: info.build, ServerName: info.label };
    },
    authenticate: async (username, password) => {
      const auth = await request('/session', { login: username, secret: password });
      return { userId: auth.account, userName: username, token: auth.bearer, serverId: auth.instance };
    },
    getUserViews: async signal => ({ Items: await request('/catalog', undefined, signal), TotalRecordCount: 1, StartIndex: 0 }),
    search: async (term, _limit, signal) => ({ Items: await request('/find?q=' + encodeURIComponent(term), undefined, signal), TotalRecordCount: 1, StartIndex: 0 }),
    getLatest: unsupported, getResumeItems: unsupported, getNextUp: unsupported, queryItems: unsupported,
    getLibraryItems: unsupported, getItem: unsupported, getSeasons: unsupported, getEpisodes: unsupported,
    getLibraryFilters: unsupported, getSimilar: unsupported, getPersonItems: unsupported, getPlayedItems: unsupported,
    getPlaybackInfo: unsupported, resolveMediaUrl: unsupported, directStreamUrl: unsupported, hlsUrl: unsupported,
    reportPlaybackStart: unsupported, reportPlaybackProgress: unsupported, reportPlaybackStopped: unsupported,
    markPlayed: unsupported, markUnplayed: unsupported, setFavorite: unsupported, externalSubtitleUrls: unsupported,
    imageUrl: unsupported, posterUrl: unsupported, backdropUrl: unsupported, thumbUrl: unsupported,
    logoUrl: unsupported, personImageUrl: unsupported,
  };
}

export const fixtureConnector: ServerConnector & { readonly id: 'fixture' } = {
  id: 'fixture', name: 'Fixture Backend', clientNamePresets: ['Fixture Client'],
  supportsDeviceRegistration: false, requiresNativePlaybackInfo: true, createApi,
  publicHeaders: identity => ({ 'X-Fixture-Client': identity.name }),
  discover: async (address, options) => {
    const info = await createApi({ address, identity: () => options.clientIdentities?.fixture ?? DEFAULT_CLIENT_IDENTITY })
      .getPublicSystemInfo(options.signal);
    if (!info.Id || !info.Version) throw new ServerDetectionError('Invalid fixture discovery');
    return { address, protocol: 'fixture', info };
  },
};
