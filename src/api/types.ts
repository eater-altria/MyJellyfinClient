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
  Tags?: string[];
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

export interface LibraryFilterOptions { genres: string[]; tags: string[]; years: number[]; }
