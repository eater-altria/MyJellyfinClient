/**
 * Shared Jellyfin / Emby REST API client.
 * Auth header format:
 *   X-Emby-Authorization: MediaBrowser Client="...", Device="...", DeviceId="...", Version="...", Token="..."
 */

export type ServerProtocol = 'jellyfin' | 'emby';
export const serverProtocolName = (protocol?: ServerProtocol) => protocol === 'emby' ? 'Emby' : 'Jellyfin';

export interface PublicSystemInfo {
  ServerName?: string;
  Id?: string;
  Version?: string;
  ProductName?: string;
  LocalAddress?: string;
  LocalAddresses?: string[];
  RemoteAddresses?: string[];
  StartupWizardCompleted?: boolean;
}

export interface ServerInfo {
  id: string;
  name: string;
  address: string; // normalized base URL without trailing slash
}

export interface AuthResult {
  userId: string;
  token: string;
  userName: string;
  serverId: string;
}

export interface UserData {
  Played?: boolean;
  PlayedPercentage?: number;
  PlaybackPositionTicks?: number;
  IsFavorite?: boolean;
  PlayCount?: number;
  UnplayedItemCount?: number;
  Rating?: number;
}

export interface Person {
  Name: string;
  Id: string;
  Role?: string;
  Type?: string; // Actor / Director / Producer ...
  PrimaryImageTag?: string;
}

export interface MediaStream {
  Type?: string; // Video / Audio / Subtitle
  Codec?: string;
  Width?: number;
  Height?: number;
  BitRate?: number;
  Language?: string;
  DisplayTitle?: string;
  IsDefault?: boolean;
  IsExternal?: boolean;
  Index?: number;
  DeliveryUrl?: string;
  Title?: string;
  ChannelLayout?: string;
  Channels?: number;
  SampleRate?: number;
  Profile?: string;
  Level?: number;
  BitDepth?: number;
  PixelFormat?: string;
  AspectRatio?: string;
  RealFrameRate?: number;
  AverageFrameRate?: number;
  VideoRange?: string;
  VideoRangeType?: string;
  ColorSpace?: string;
  ColorTransfer?: string;
  ColorPrimaries?: string;
  IsInterlaced?: boolean;
  IsForced?: boolean;
  Path?: string;
}

export interface MediaSource {
  Id: string;
  Container?: string;
  Size?: number;
  Bitrate?: number;
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  SupportsTranscoding?: boolean;
  TranscodingUrl?: string;
  DirectStreamUrl?: string;
  AddApiKeyToDirectStreamUrl?: boolean;
  RequiredHttpHeaders?: Record<string, string>;
  MediaStreams?: MediaStream[];
  Name?: string;
  Path?: string;
  RunTimeTicks?: number;
}

export interface BaseItem {
  Id: string;
  Name: string;
  Path?: string;
  Type?: string; // Movie / Series / Season / Episode / CollectionFolder ...
  CollectionType?: string;
  ServerId?: string;
  Overview?: string;
  ProductionYear?: number;
  PremiereDate?: string;
  DateCreated?: string;
  Size?: number;
  MediaStreams?: MediaStream[];
  Chapters?: { StartPositionTicks?: number; ImageTag?: string; Name?: string }[];
  OfficialRating?: string;
  CommunityRating?: number;
  CriticRating?: number;
  RunTimeTicks?: number;
  Genres?: string[];
  Studios?: { Name: string }[];
  People?: Person[];
  MediaSources?: MediaSource[];
  UserData?: UserData;
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  ParentThumbItemId?: string;
  ParentBackdropItemId?: string;
  ParentLogoItemId?: string;
  ParentId?: string;
  SeriesName?: string;
  SeriesId?: string;
  SeasonId?: string;
  SeasonName?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  ChildCount?: number;
  RecursiveItemCount?: number;
  MediaType?: string;
  IsFolder?: boolean;
  LocationType?: string;
  Width?: number;
  Height?: number;
  PrimaryImageAspectRatio?: number;
}

export interface ItemsResult {
  Items: BaseItem[];
  TotalRecordCount: number;
  StartIndex: number;
}

export interface PlaybackInfoResult {
  MediaSources: MediaSource[];
  PlaySessionId?: string;
  ErrorCode?: string;
}

const CLIENT_NAME = 'MyJellyfinClient';
const CLIENT_VERSION = '0.1.0';
const DEVICE_NAME = 'Windows PC';
const LIST_ITEM_FIELDS = 'Overview,PrimaryImageAspectRatio,DateCreated,MediaSources,MediaStreams,Chapters,ChildCount,RecursiveItemCount';

function getDeviceId(): string {
  let id = localStorage.getItem('mjc:deviceId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('mjc:deviceId', id);
  }
  return id;
}

export function normalizeAddress(input: string): string {
  let address = input.trim();
  if (!/^https?:\/\//i.test(address)) address = 'http://' + address;
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('请输入有效的 HTTP 或 HTTPS 服务器地址');
  }
  // Accept a copied web-client URL while preserving a reverse-proxy base path.
  url.pathname = url.pathname.replace(/\/web(?:\/.*)?$/i, '').replace(/\/+$/, '');
  url.search = ''; url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function authHeader(token?: string, protocol: ServerProtocol = 'jellyfin', userId?: string): string {
  const parts = [
    `Client="${CLIENT_NAME}"`,
    `Device="${DEVICE_NAME}"`,
    `DeviceId="${getDeviceId()}"`,
    `Version="${CLIENT_VERSION}"`,
  ];
  if (userId) parts.push(`UserId="${userId}"`);
  if (token) parts.push(`Token="${token}"`);
  return `${protocol === 'emby' ? 'Emby' : 'MediaBrowser'} ${parts.join(', ')}`;
}

export class MediaServerApi {
  constructor(
    public readonly baseUrl: string,
    public readonly token?: string,
    public readonly userId?: string,
    public readonly protocol: ServerProtocol = 'jellyfin',
  ) {
    this.baseUrl = normalizeAddress(baseUrl);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: authHeader(this.token, this.protocol, this.userId),
      'X-Emby-Authorization': authHeader(this.token, 'jellyfin', this.userId),
      ...(this.token ? { 'X-Emby-Token': this.token } : {}),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
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
    const res = await fetch(this.url(path, params), { headers: this.headers(), signal });
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
    return res.json() as Promise<T>;
  }

  async post<T = void>(path: string, body?: unknown, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.url(path, params), {
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
    const res = await fetch(this.url(path, params), { method: 'DELETE', headers: this.headers() });
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
  }

  // ---------- Server ----------
  async getPublicSystemInfo(signal?: AbortSignal): Promise<PublicSystemInfo> {
    const res = await fetch(this.url('/System/Info/Public'), { headers: this.headers(), signal, cache: 'no-store' });
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
    return res.json();
  }

  // ---------- Auth ----------
  async authenticate(username: string, password: string): Promise<AuthResult> {
    const res = await fetch(this.url('/Users/AuthenticateByName'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ Username: username, Pw: password }),
    });
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
    const data = await res.json();
    if (!data?.User?.Id || !data.AccessToken) throw new Error('服务器登录响应无效');
    return {
      userId: data.User.Id,
      userName: data.User.Name || username,
      token: data.AccessToken,
      serverId: data.ServerId,
    };
  }

  // ---------- Libraries / views ----------
  getUserViews(): Promise<ItemsResult> {
    return this.get(`/Users/${this.userId}/Views`, { IncludeHidden: false, Fields: LIST_ITEM_FIELDS });
  }

  getLatest(parentId: string, limit = 16): Promise<BaseItem[]> {
    return this.get(`/Users/${this.userId}/Items/Latest`, {
      ParentId: parentId,
      Limit: limit,
      Fields: LIST_ITEM_FIELDS,
      ImageTypeLimit: 1,
    });
  }

  getResumeItems(limit = 12): Promise<ItemsResult> {
    return this.get(`/Users/${this.userId}/Items/Resume`, {
      Limit: limit,
      Recursive: true,
      Fields: LIST_ITEM_FIELDS,
      MediaTypes: 'Video',
      ImageTypeLimit: 1,
    });
  }

  getNextUp(limit = 12): Promise<ItemsResult> {
    return this.get(`/Shows/NextUp`, {
      UserId: this.userId,
      Limit: limit,
      Fields: LIST_ITEM_FIELDS + ',SeriesName',
      ImageTypeLimit: 1,
    });
  }

  queryItems(params: Record<string, unknown>): Promise<ItemsResult> {
    return this.get(`/Users/${this.userId}/Items`, {
      ImageTypeLimit: 1,
      ...params,
      Fields: [...new Set((LIST_ITEM_FIELDS + ',' + String(params.Fields ?? '')).split(',').filter(Boolean))].join(','),
    });
  }

  getItem(itemId: string, signal?: AbortSignal): Promise<BaseItem> {
    return this.get(`/Users/${this.userId}/Items/${itemId}`, {
      Fields: LIST_ITEM_FIELDS + ',People,Genres,Studios',
    }, signal);
  }

  getSeasons(seriesId: string): Promise<ItemsResult> {
    return this.get(`/Shows/${seriesId}/Seasons`, {
      UserId: this.userId,
      Fields: LIST_ITEM_FIELDS,
    });
  }

  getEpisodes(seriesId: string, seasonId?: string): Promise<ItemsResult> {
    return this.get(`/Shows/${seriesId}/Episodes`, {
      UserId: this.userId,
      SeasonId: seasonId,
      Fields: LIST_ITEM_FIELDS,
    });
  }

  getSimilar(itemId: string, limit: number | null = 12): Promise<ItemsResult> {
    return this.get(`/Items/${itemId}/Similar`, {
      UserId: this.userId,
      Limit: limit,
      Fields: LIST_ITEM_FIELDS,
    });
  }

  getPersonItems(personId: string, startIndex = 0, limit = 60): Promise<ItemsResult> {
    return this.queryItems({
      PersonIds: personId,
      Recursive: true,
      IncludeItemTypes: 'Movie,Series,Episode',
      Fields: 'Overview,PrimaryImageAspectRatio,SeriesName',
      SortBy: 'ProductionYear,SortName',
      SortOrder: 'Descending',
      StartIndex: startIndex,
      Limit: limit,
    });
  }

  search(term: string, limit = 48): Promise<ItemsResult> {
    return this.get(`/Users/${this.userId}/Items`, {
      SearchTerm: term,
      Recursive: true,
      Limit: limit,
      IncludeItemTypes: 'Movie,Series,Episode',
      Fields: LIST_ITEM_FIELDS,
      ImageTypeLimit: 1,
    });
  }

  getPlayedItems(limit = 60): Promise<ItemsResult> {
    return this.get(`/Users/${this.userId}/Items`, {
      Recursive: true,
      Filters: 'IsPlayed',
      IncludeItemTypes: 'Movie,Episode',
      SortBy: 'DatePlayed',
      SortOrder: 'Descending',
      Limit: limit,
      Fields: LIST_ITEM_FIELDS,
    });
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
        Name: native ? 'MyJellyfinClient mpv' : 'MyJellyfinClient HTML5',
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
    }, this.protocol === 'emby' ? options : undefined, signal);
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
      DeviceId: getDeviceId(), api_key: this.token,
    });
  }

  hlsUrl(itemId: string, mediaSourceId: string | undefined, playSessionId: string | undefined, source?: MediaSource): string {
    if (source?.TranscodingUrl) return this.resolveMediaUrl(source.TranscodingUrl);
    return this.url(`/Videos/${itemId}/master.m3u8`, {
      MediaSourceId: mediaSourceId, PlaySessionId: playSessionId, DeviceId: getDeviceId(),
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
    return this.post(`/Users/${this.userId}/PlayedItems/${itemId}`);
  }

  markUnplayed(itemId: string): Promise<void> {
    return this.del(`/Users/${this.userId}/PlayedItems/${itemId}`);
  }

  setFavorite(itemId: string, fav: boolean): Promise<void> {
    if (fav) return this.post(`/Users/${this.userId}/FavoriteItems/${itemId}`).then(() => {});
    return this.del(`/Users/${this.userId}/FavoriteItems/${itemId}`);
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

/** Metadata paths may be omitted by the server; its linked subtitle remains valid. */
export function matchesExternalSubtitleRule(videoPath: string | undefined, subtitlePath: string | undefined,
  rule: 'sameFolderSameName' | 'sameFolder' | 'none'): boolean {
  if (rule === 'none') return false;
  if (!videoPath || !subtitlePath) return true;
  const normalize = (path: string) => path.replace(/\\/g, '/').toLocaleLowerCase();
  const video = normalize(videoPath), subtitle = normalize(subtitlePath);
  const videoSlash = video.lastIndexOf('/'), subSlash = subtitle.lastIndexOf('/');
  if ((videoSlash < 0 ? '' : video.slice(0, videoSlash)) !== (subSlash < 0 ? '' : subtitle.slice(0, subSlash))) return false;
  if (rule === 'sameFolder') return true;
  const stem = video.slice(videoSlash + 1).replace(/\.[^.]+$/, '');
  const subName = subtitle.slice(subSlash + 1).replace(/\.[^.]+$/, '');
  return subName === stem || subName.startsWith(stem + '.');
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`Media server API error ${status}: ${body.slice(0, 200)}`);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// ---------- formatting helpers ----------
export function ticksToSeconds(ticks?: number): number {
  return ticks ? Math.round(ticks / 10_000_000) : 0;
}

export function formatDuration(ticks?: number): string {
  const s = ticksToSeconds(ticks);
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const min = Math.round(s / 60);
  if (h > 0) return `${h}小时${m}分钟`;
  return `${min}分钟`;
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const rr = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
}

export function formatSize(bytes?: number): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

export function formatRelativeDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const day = 86400000;
  if (diff < 3600000) return `${Math.max(1, Math.floor(diff / 60000))}分钟前`;
  if (diff < day) return `${Math.floor(diff / 3600000)}小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}天前`;
  return d.toLocaleDateString('zh-CN');
}
