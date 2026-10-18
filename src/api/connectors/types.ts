import type { ClientIdentity } from '../../utils/clientIdentityValues';
import type { AuthResult, BaseItem, ItemsResult, LibraryFilterOptions, MediaSource, Person,
  PlaybackInfoResult, PublicSystemInfo } from '../types';
import type { ServerProtocol } from './index';

/** Application contract. A backend maps its wire format to these media models. */
export interface MediaServerApi {
  readonly baseUrl: string;
  readonly token?: string;
  readonly userId?: string;
  readonly protocol: ServerProtocol;
  clientIdentity(): ClientIdentity;
  get<T>(path: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  post<T = void>(path: string, body?: unknown, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  del(path: string, params?: Record<string, unknown>): Promise<void>;
  getPublicSystemInfo(signal?: AbortSignal): Promise<PublicSystemInfo>;
  authenticate(username: string, password: string): Promise<AuthResult>;
  getUserViews(signal?: AbortSignal): Promise<ItemsResult>;
  getLatest(parentId: string, limit?: number): Promise<BaseItem[]>;
  getResumeItems(limit?: number, startIndex?: number, signal?: AbortSignal): Promise<ItemsResult>;
  getNextUp(limit?: number, startIndex?: number, signal?: AbortSignal): Promise<ItemsResult>;
  queryItems(params: Record<string, unknown>, signal?: AbortSignal): Promise<ItemsResult>;
  getLibraryItems(view: BaseItem, startIndex?: number, limit?: number, signal?: AbortSignal): Promise<ItemsResult>;
  getItem(itemId: string, signal?: AbortSignal): Promise<BaseItem>;
  getSeasons(seriesId: string, signal?: AbortSignal): Promise<ItemsResult>;
  getEpisodes(seriesId: string, seasonId?: string, signal?: AbortSignal): Promise<ItemsResult>;
  getLibraryFilters(parentId: string, includeItemTypes?: string, signal?: AbortSignal): Promise<LibraryFilterOptions>;
  getSimilar(itemId: string, limit?: number | null, signal?: AbortSignal): Promise<ItemsResult>;
  getPersonItems(personId: string, startIndex?: number, limit?: number, signal?: AbortSignal): Promise<ItemsResult>;
  search(term: string, limit?: number, signal?: AbortSignal): Promise<ItemsResult>;
  getPlayedItems(limit?: number, signal?: AbortSignal): Promise<ItemsResult>;
  getPlaybackInfo(itemId: string, player?: 'native' | 'web', signal?: AbortSignal): Promise<PlaybackInfoResult>;
  getDanmakuXml?(itemId: string, signal?: AbortSignal): Promise<string | null>;
  resolveMediaUrl(input: string, authenticate?: boolean, allowExternalAuth?: boolean): string;
  directStreamUrl(itemId: string, mediaSourceId?: string, playSessionId?: string, source?: MediaSource): string;
  hlsUrl(itemId: string, mediaSourceId?: string, playSessionId?: string, source?: MediaSource): string;
  reportPlaybackStart(body: Record<string, unknown>): Promise<void>;
  reportPlaybackProgress(body: Record<string, unknown>): Promise<void>;
  reportPlaybackStopped(body: Record<string, unknown>): Promise<void>;
  markPlayed(itemId: string): Promise<void>;
  markUnplayed(itemId: string): Promise<void>;
  setFavorite(itemId: string, fav: boolean): Promise<void>;
  externalSubtitleUrls(itemId: string, source: MediaSource | undefined, rule?: 'sameFolderSameName' | 'sameFolder' | 'none'): string[];
  imageUrl(itemId: string, type?: 'Primary' | 'Backdrop' | 'Thumb' | 'Logo' | 'Chapter',
    opts?: { tag?: string; maxWidth?: number; maxHeight?: number; quality?: number; imageIndex?: number }): string;
  posterUrl(item: BaseItem, maxWidth?: number): string | null;
  backdropUrl(item: BaseItem, maxWidth?: number): string | null;
  thumbUrl(item: BaseItem, maxWidth?: number): string | null;
  logoUrl(item: BaseItem, maxWidth?: number): string | null;
  personImageUrl(person: Person, maxWidth?: number): string | null;
}

export interface ApiConnection {
  address: string;
  token?: string;
  userId?: string;
  identity?: () => ClientIdentity;
  deviceId?: string;
  authorizationOnly?: boolean;
  /** Legacy persisted flag; Jellyfin/Emby now always use the SenPlayer wire format. */
  connectionMode?: 'standard' | 'senplayer';
}

export interface DetectedServer {
  address: string;
  protocol: ServerProtocol;
  info: PublicSystemInfo;
  authorizationOnly?: boolean;
}

export interface DiscoveryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  clientIdentities?: Partial<Record<ServerProtocol, ClientIdentity>>;
  protocol?: ServerProtocol;
}

/** Shared discovery handlers can probe related protocols together without duplicate requests. */
export type DiscoverServers = (address: string, options: DiscoveryOptions,
  connectors: readonly ServerConnector[]) => Promise<DetectedServer>;

export interface ServerConnector {
  readonly id: string;
  readonly name: string;
  readonly icon?: 'jellyfin' | 'emby';
  readonly clientNamePresets: readonly string[];
  /** A connector may fix its wire identity while keeping the device name editable. */
  readonly fixedClientIdentity?: Pick<ClientIdentity, 'name' | 'version'>;
  readonly supportsDeviceRegistration: boolean;
  readonly requiresNativePlaybackInfo: boolean;
  readonly discover: DiscoverServers;
  /** Direct-login endpoint resolver; absent when discovery is required. */
  loginAddress?(address: string): string;
  publicHeaders(identity: ClientIdentity): Record<string, string>;
  createApi(connection: ApiConnection): MediaServerApi;
}

export class ServerDetectionError extends Error {}
