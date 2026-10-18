/** Shared REST implementation for the related Jellyfin and Emby protocols. */
import { DEFAULT_CLIENT_IDENTITY, resolveClientIdentity, type ClientIdentity } from '../../utils/clientIdentityValues';
import { updateBrowseUserData } from '../../utils/browseHistory';
import { ApiError, libraryItemTypes, matchesExternalSubtitleRule, normalizeAddress, safeText } from '../helpers';
import type { AuthResult, BaseItem, ItemsResult, LibraryFilterOptions, MediaSource, Person, PlaybackInfoResult, PublicSystemInfo } from '../types';
import type { MediaServerApi } from './types';
import type { ServerProtocol } from './index';
import { getDeviceId } from './mediaBrowserAuth';
import { mediaServerRequest } from '../../platform/mediaServerRequest';
import { readDanmakuResponse } from '../../player/danmaku';
import { SENPLAYER_USER_AGENT, senPlayerAuthHeader, senPlayerClientIdentity } from './senPlayerCompatibility';

const LIST_ITEM_FIELDS = 'Overview,PrimaryImageAspectRatio,DateCreated,MediaSources,MediaStreams,Chapters,ChildCount,RecursiveItemCount';

export abstract class MediaBrowserApi implements MediaServerApi {
  constructor(
    public readonly baseUrl: string,
    public readonly token?: string,
    public readonly userId?: string,
    public readonly protocol: ServerProtocol = 'jellyfin',
    private readonly identity: () => ClientIdentity = () => DEFAULT_CLIENT_IDENTITY,
    private readonly deviceIdOverride?: string,
    private readonly authorizationOnly = false,
  ) {
    this.baseUrl = normalizeAddress(baseUrl);
  }

  protected abstract readonly authScheme: 'Emby' | 'MediaBrowser';

  protected playbackInfoParams(_options: Record<string, unknown>): Record<string, unknown> | undefined { return undefined; }

  private headers(): Record<string, string> {
    const identity = this.clientIdentity();
    const authorization = senPlayerAuthHeader(identity, this.deviceId(), this.token, this.userId);
    return {
      ...(this.authScheme === 'MediaBrowser' || this.authorizationOnly ? { Authorization: authorization } : {}),
      ...(!this.authorizationOnly ? { 'X-Emby-Authorization': authorization,
        ...(this.token ? { 'X-Emby-Token': this.token } : {}) } : {}),
      'User-Agent': SENPLAYER_USER_AGENT,
      Accept: '*/*',
      'Content-Type': 'application/json',
    };
  }

  clientIdentity(): ClientIdentity {
    const identity = resolveClientIdentity(this.identity());
    return senPlayerClientIdentity(identity);
  }

  private deviceId(): string {
    return typeof this.deviceIdOverride === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(this.deviceIdOverride)
      ? this.deviceIdOverride : getDeviceId();
  }

  private url(path: string, params?: Record<string, unknown>): string {
    const u = new URL(this.baseUrl + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '') continue;
        u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  async get<T>(path: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await mediaServerRequest(this.url(path, params), { headers: this.headers(), signal });
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
    return res.json() as Promise<T>;
  }

  async getDanmakuXml(itemId: string, signal?: AbortSignal): Promise<string | null> {
    // Read through the configured entry, not the plugin's absolute Url, which
    // omits reverse-proxy prefixes. Reject redirects before sending credentials.
    const response = await mediaServerRequest(this.url(`/api/danmu/${encodeURIComponent(itemId)}/raw`), {
      headers: { ...this.headers(), Accept: 'application/xml,text/xml' }, signal, redirect: 'error',
    });
    if (response.status === 404 || response.status === 204) return null;
    if (!response.ok) throw new Error(`服务器弹幕读取失败（HTTP ${response.status}）`);
    return readDanmakuResponse(response);
  }

  async post<T = void>(path: string, body?: unknown, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await mediaServerRequest(this.url(path, params), {
      method: 'POST',
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async del(path: string, params?: Record<string, unknown>): Promise<void> {
    const res = await mediaServerRequest(this.url(path, params), { method: 'DELETE', headers: this.headers() });
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
  }

  // ---------- Server ----------
  async getPublicSystemInfo(signal?: AbortSignal): Promise<PublicSystemInfo> {
    const res = await mediaServerRequest(this.url('/System/Info/Public'), { headers: this.headers(), signal, cache: 'no-store' });
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
    return res.json();
  }

  // ---------- Auth ----------
  async authenticate(username: string, password: string): Promise<AuthResult> {
    const res = await mediaServerRequest(this.url('/Users/AuthenticateByName'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ Username: username, Pw: password, Password: password }),
      redirect: 'error',
    });
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
    const data = await res.json();
    if (typeof data?.User?.Id !== 'string' || !data.User.Id.trim()
      || typeof data.AccessToken !== 'string' || !data.AccessToken.trim()) throw new Error('服务器登录响应无效');
    return {
      userId: data.User.Id,
      userName: typeof data.User.Name === 'string' && data.User.Name.trim() ? data.User.Name : username,
      token: data.AccessToken,
      serverId: typeof data.ServerId === 'string' && data.ServerId.trim() ? data.ServerId : undefined,
    };
  }

  // ---------- Libraries / views ----------
  getUserViews(signal?: AbortSignal): Promise<ItemsResult> {
    return this.get(`/Users/${this.userId}/Views`, { IncludeHidden: false, Fields: LIST_ITEM_FIELDS }, signal);
  }

  getLatest(parentId: string, limit = 16): Promise<BaseItem[]> {
    return this.get(`/Users/${this.userId}/Items/Latest`, {
      ParentId: parentId,
      Limit: limit,
      Fields: LIST_ITEM_FIELDS,
      ImageTypeLimit: 1,
    });
  }

  getResumeItems(limit = 12, startIndex = 0, signal?: AbortSignal): Promise<ItemsResult> {
    return this.get(`/Users/${this.userId}/Items/Resume`, {
      Limit: limit,
      StartIndex: startIndex,
      Recursive: true,
      Fields: LIST_ITEM_FIELDS,
      MediaTypes: 'Video',
      ImageTypeLimit: 1,
    }, signal);
  }

  getNextUp(limit = 12, startIndex = 0, signal?: AbortSignal): Promise<ItemsResult> {
    return this.get(`/Shows/NextUp`, {
      UserId: this.userId,
      Limit: limit,
      StartIndex: startIndex,
      Fields: LIST_ITEM_FIELDS + ',SeriesName',
      ImageTypeLimit: 1,
    }, signal);
  }

  queryItems(params: Record<string, unknown>, signal?: AbortSignal): Promise<ItemsResult> {
    return this.get(`/Users/${this.userId}/Items`, {
      ImageTypeLimit: 1,
      ...params,
      Fields: [...new Set((LIST_ITEM_FIELDS + ',' + String(params.Fields ?? '')).split(',').filter(Boolean))].join(','),
    }, signal);
  }

  /** Page through a view using the regular item query, which supplies a total
   * and supports StartIndex in both protocols, including collection containers. */
  getLibraryItems(view: BaseItem, startIndex = 0, limit = 24, signal?: AbortSignal): Promise<ItemsResult> {
    return this.queryItems({
      ParentId: view.Id,
      Recursive: true,
      IncludeItemTypes: libraryItemTypes(view),
      SortBy: 'DateCreated,SortName',
      SortOrder: 'Descending,Ascending',
      GroupItemsIntoCollections: false,
      StartIndex: startIndex,
      Limit: limit,
      EnableTotalRecordCount: true,
    }, signal);
  }

  getItem(itemId: string, signal?: AbortSignal): Promise<BaseItem> {
    return this.get(`/Users/${this.userId}/Items/${itemId}`, {
      Fields: LIST_ITEM_FIELDS + ',People,Genres,Tags,Studios',
    }, signal);
  }

  getSeasons(seriesId: string, signal?: AbortSignal): Promise<ItemsResult> {
    return this.get(`/Shows/${seriesId}/Seasons`, {
      UserId: this.userId,
      Fields: LIST_ITEM_FIELDS,
    }, signal);
  }

  getEpisodes(seriesId: string, seasonId?: string, signal?: AbortSignal): Promise<ItemsResult> {
    return this.get(`/Shows/${seriesId}/Episodes`, {
      UserId: this.userId,
      SeasonId: seasonId,
      Fields: LIST_ITEM_FIELDS,
    }, signal);
  }

  abstract getLibraryFilters(parentId: string, includeItemTypes?: string, signal?: AbortSignal): Promise<LibraryFilterOptions>;

  getSimilar(itemId: string, limit: number | null = 12, signal?: AbortSignal): Promise<ItemsResult> {
    return this.get(`/Items/${itemId}/Similar`, {
      UserId: this.userId,
      Limit: limit,
      Fields: LIST_ITEM_FIELDS,
    }, signal);
  }

  getPersonItems(personId: string, startIndex = 0, limit = 60, signal?: AbortSignal): Promise<ItemsResult> {
    return this.queryItems({
      PersonIds: personId,
      Recursive: true,
      IncludeItemTypes: 'Movie,Series,Episode',
      Fields: 'Overview,PrimaryImageAspectRatio,SeriesName',
      SortBy: 'ProductionYear,SortName',
      SortOrder: 'Descending',
      StartIndex: startIndex,
      Limit: limit,
    }, signal);
  }

  search(term: string, limit = 48, signal?: AbortSignal): Promise<ItemsResult> {
    return this.get(`/Users/${this.userId}/Items`, {
      SearchTerm: term,
      Recursive: true,
      Limit: limit,
      IncludeItemTypes: 'Movie,Series,Episode',
      Fields: LIST_ITEM_FIELDS,
      ImageTypeLimit: 1,
    }, signal);
  }

  getPlayedItems(limit = 60, signal?: AbortSignal): Promise<ItemsResult> {
    return this.get(`/Users/${this.userId}/Items`, {
      Recursive: true,
      Filters: 'IsPlayed',
      IncludeItemTypes: 'Movie,Episode',
      SortBy: 'DatePlayed',
      SortOrder: 'Descending',
      Limit: limit,
      Fields: LIST_ITEM_FIELDS,
    }, signal);
  }

  // ---------- Playback ----------
  async getPlaybackInfo(itemId: string, player: 'native' | 'web' = 'web', signal?: AbortSignal): Promise<PlaybackInfoResult> {
    const native = player === 'native';
    const maxBitrate = native ? 1_000_000_000 : 120_000_000;
    const options = {
      UserId: this.userId, MaxStreamingBitrate: maxBitrate,
      IsPlayback: true, EnableDirectPlay: true, EnableDirectStream: true, EnableTranscoding: true,
    };
    const result = await this.post<PlaybackInfoResult>(`/Items/${itemId}/PlaybackInfo`, {
      ...options,
      DeviceProfile: {
        Name: `${this.clientIdentity().name} ${native ? 'mpv' : 'HTML5'}`,
        MaxStreamingBitrate: maxBitrate, MaxStaticBitrate: maxBitrate,
        MusicStreamingTranscodingBitrate: 384000,
        DirectPlayProfiles: native ? [
          { Container: 'mp4,m4v,mkv,avi,mov,wmv,ts,m2ts,webm', Type: 'Video' },
          { Container: 'mp3,aac,flac,wav,ogg,m4a', Type: 'Audio' },
        ] : [
          { Container: 'mp4,m4v,mov', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac,mp3' },
          { Container: 'mp3,aac', Type: 'Audio' },
        ],
        TranscodingProfiles: [{
          Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac,mp3',
          Protocol: 'hls', Context: 'Streaming', MaxAudioChannels: '6',
        }],
        SubtitleProfiles: native
          ? ['srt', 'ass', 'ssa', 'vtt'].map((Format) => ({ Format, Method: 'External' }))
          : [{ Format: 'vtt', Method: 'External' }],
      },
    }, this.playbackInfoParams(options), signal);
    if (!result.MediaSources?.length) {
      throw new Error(result.ErrorCode ? `服务器无法提供可播放的媒体：${result.ErrorCode}` : '没有可用的媒体源');
    }
    return result;
  }

  /** Resolve advertised stream/subtitle URLs without duplicating /emby or a proxy prefix. */
  resolveMediaUrl(input: string, authenticate = true, allowExternalAuth = false): string {
    const base = new URL(this.baseUrl);
    let url: URL;
    if (/^(?:https?:)?\/\//i.test(input)) {
      url = new URL(input, base);
    } else {
      const advertised = new URL(input, base.origin);
      const basePath = base.pathname.replace(/\/+$/, '');
      let path = advertised.pathname;
      if (basePath && (path === basePath || path.startsWith(basePath + '/'))) {
        url = advertised;
      } else {
        // Emby's media paths often include /emby even behind /proxy/emby.
        if (/\/(?:emby|mediabrowser)$/i.test(basePath)) {
          path = path.replace(/^\/(?:emby|mediabrowser)(?=\/|$)/i, '');
        }
        url = new URL(this.baseUrl + '/' + path.replace(/^\/+/, ''));
        url.search = advertised.search;
      }
    }
    if (authenticate && this.token && (url.origin === base.origin || allowExternalAuth)) {
      const hasToken = [...url.searchParams.keys()].some((key) => ['api_key', 'x-emby-token'].includes(key.toLowerCase()));
      if (!hasToken) url.searchParams.set('api_key', this.token);
    }
    return url.toString();
  }

  directStreamUrl(itemId: string, mediaSourceId?: string, playSessionId?: string, source?: MediaSource): string {
    if (source?.DirectStreamUrl) {
      return this.resolveMediaUrl(source.DirectStreamUrl, source.AddApiKeyToDirectStreamUrl !== false,
        source.AddApiKeyToDirectStreamUrl === true);
    }
    return this.url(`/Videos/${itemId}/stream`, {
      Static: true, MediaSourceId: mediaSourceId, PlaySessionId: playSessionId,
      DeviceId: this.deviceId(), api_key: this.token,
    });
  }

  hlsUrl(itemId: string, mediaSourceId: string | undefined, playSessionId: string | undefined, source?: MediaSource): string {
    if (source?.TranscodingUrl) return this.resolveMediaUrl(source.TranscodingUrl);
    return this.url(`/Videos/${itemId}/master.m3u8`, {
      MediaSourceId: mediaSourceId, PlaySessionId: playSessionId, DeviceId: this.deviceId(),
      api_key: this.token, VideoCodec: 'h264', AudioCodec: 'aac,mp3',
      VideoBitrate: 100000000, AudioBitrate: 384000, MaxWidth: 3840,
    });
  }

  reportPlaybackStart(body: Record<string, unknown>): Promise<void> {
    return this.post('/Sessions/Playing', body);
  }

  reportPlaybackProgress(body: Record<string, unknown>): Promise<void> {
    return this.post('/Sessions/Playing/Progress', body);
  }

  reportPlaybackStopped(body: Record<string, unknown>): Promise<void> {
    return this.post('/Sessions/Playing/Stopped', body);
  }

  markPlayed(itemId: string): Promise<void> {
    return this.post(`/Users/${this.userId}/PlayedItems/${itemId}`).then(() => updateBrowseUserData(this, itemId, { Played: true }));
  }

  markUnplayed(itemId: string): Promise<void> {
    return this.del(`/Users/${this.userId}/PlayedItems/${itemId}`).then(() => updateBrowseUserData(this, itemId, { Played: false }));
  }

  setFavorite(itemId: string, fav: boolean): Promise<void> {
    const request = fav ? this.post(`/Users/${this.userId}/FavoriteItems/${itemId}`) : this.del(`/Users/${this.userId}/FavoriteItems/${itemId}`);
    return request.then(() => updateBrowseUserData(this, itemId, { IsFavorite: fav }));
  }

  /** External (sidecar) subtitle URLs playable by mpv via --sub-file. */
  externalSubtitleUrls(itemId: string, source: MediaSource | undefined,
    rule: 'sameFolderSameName' | 'sameFolder' | 'none' = 'sameFolder'): string[] {
    if (!source?.MediaStreams) return [];
    const EXT: Record<string, string> = {
      subrip: 'srt',
      srt: 'srt',
      webvtt: 'vtt',
      vtt: 'vtt',
      ass: 'ass',
      ssa: 'ssa',
      mov_text: 'srt',
    };
    return source.MediaStreams.filter(
      (ms) =>
        ms.Type === 'Subtitle' &&
        (ms.IsExternal || ms.DeliveryUrl) &&
        EXT[(ms.Codec || '').toLowerCase()] &&
        (!ms.IsExternal || matchesExternalSubtitleRule(source.Path, ms.Path, rule)),
    ).map((ms) => {
      if (ms.DeliveryUrl) {
        return this.resolveMediaUrl(ms.DeliveryUrl);
      }
      const ext = EXT[(ms.Codec || '').toLowerCase()];
      return this.resolveMediaUrl(`/Videos/${itemId}/${source.Id}/Subtitles/${ms.Index}/0/Stream.${ext}`);
    });
  }

  // ---------- Images ----------
  imageUrl(
    itemId: string,
    type: 'Primary' | 'Backdrop' | 'Thumb' | 'Logo' | 'Chapter' = 'Primary',
    opts: { tag?: string; maxWidth?: number; maxHeight?: number; quality?: number; imageIndex?: number } = {},
  ): string {
    const indexedType = opts.imageIndex == null ? type : `${type}/${opts.imageIndex}`;
    return this.url(`/Items/${itemId}/Images/${indexedType}`, {
      tag: opts.tag,
      maxWidth: opts.maxWidth,
      maxHeight: opts.maxHeight,
      quality: opts.quality ?? 90,
      imageIndex: opts.imageIndex,
      // <img> tags cannot send the auth header, so authenticate via query param
      api_key: this.token,
    });
  }

  /** Best poster URL for an item (episodes use series primary). */
  posterUrl(item: BaseItem, maxWidth = 400): string | null {
    if (item.ImageTags?.Primary) {
      return this.imageUrl(item.Id, 'Primary', { tag: item.ImageTags.Primary, maxWidth });
    }
    if (item.Type === 'Episode' && item.SeriesId) {
      return this.imageUrl(item.SeriesId, 'Primary', { maxWidth });
    }
    if (item.ParentThumbItemId) {
      return this.imageUrl(item.ParentThumbItemId, 'Thumb', { maxWidth });
    }
    return null;
  }

  backdropUrl(item: BaseItem, maxWidth = 1920): string | null {
    if (item.BackdropImageTags?.length) {
      return this.imageUrl(item.Id, 'Backdrop', {
        tag: item.BackdropImageTags[0],
        maxWidth,
        imageIndex: 0,
      });
    }
    if (item.ParentBackdropItemId) {
      return this.imageUrl(item.ParentBackdropItemId, 'Backdrop', { maxWidth, imageIndex: 0 });
    }
    return null;
  }

  thumbUrl(item: BaseItem, maxWidth = 600): string | null {
    if (item.ImageTags?.Thumb) {
      return this.imageUrl(item.Id, 'Thumb', { tag: item.ImageTags.Thumb, maxWidth });
    }
    if (item.ParentThumbItemId) {
      return this.imageUrl(item.ParentThumbItemId, 'Thumb', { maxWidth });
    }
    return this.backdropUrl(item, maxWidth);
  }

  logoUrl(item: BaseItem, maxWidth = 500): string | null {
    if (item.ImageTags?.Logo) {
      return this.imageUrl(item.Id, 'Logo', { tag: item.ImageTags.Logo, maxWidth });
    }
    if (item.ParentLogoItemId) {
      return this.imageUrl(item.ParentLogoItemId, 'Logo', { maxWidth });
    }
    return null;
  }

  personImageUrl(person: Person, maxWidth = 200): string | null {
    if (!person.PrimaryImageTag) return null;
    return this.imageUrl(person.Id, 'Primary', { tag: person.PrimaryImageTag, maxWidth });
  }
}
