import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { normalizeClientIdentities, normalizeClientIdentityText, resolveClientIdentity,
  type ClientIdentities, type ClientIdentity, type ClientIdentityProtocol } from '../utils/clientIdentity';
export { CLIENT_IDENTITY_MAX_LENGTH, CLIENT_NAME_PRESETS, DEFAULT_CLIENT_IDENTITY } from '../utils/clientIdentity';

export type AccentColor = '#0a84ff' | '#30b0c7' | '#34c759' | '#bf5af2' | '#ff9f0a' | '#ff6482' | '#ff453a' | '#7d7aff';

export const PLAYER_CACHE_MIN_MB = 1;
export const PLAYER_CACHE_MAX_MB = 8192;
export const PLAYER_CACHE_DEFAULT_MB = 150;

export function normalizePlayerCacheSizeMB(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(PLAYER_CACHE_MAX_MB, Math.max(PLAYER_CACHE_MIN_MB, Math.round(value)))
    : PLAYER_CACHE_DEFAULT_MB;
}

export interface AppSettings {
  // 通用
  accentColor: AccentColor;
  defaultModule: 'files' | 'servers' | 'iptv' | 'history' | 'search';
  clientIdentities: ClientIdentities; // Empty overrides follow the application's defaults.
  // 列表
  showItemCountInTitle: boolean;
  showFolderTime: boolean;
  sortFoldersSeparately: boolean;
  thumbnailFill: boolean; // 缩略图铺满
  showPreviewImage: boolean;
  previewTimePercent: number; // 视频预览图时间 %
  preferEmbeddedCover: boolean;
  showPlayProgress: boolean;
  showMediaDuration: boolean;
  showFileSize: boolean;
  showNewBadge: boolean;
  showHdrBadge: boolean;
  showFrameRate: boolean;
  showResolution: boolean;
  simplifyResolution: boolean;
  // 播放
  resumeFromLastPosition: boolean;
  preciseSeek: boolean;
  rewindSeconds: number;
  forwardSeconds: number;
  playerCacheSizeMB: number; // mpv forward cache limit; 1 MB = 1,000,000 bytes.
  // 界面
  autoHideControlsSeconds: number;
  autoFullscreenOnPlay: boolean;
  matchWindowToVideoRatio: boolean;
  showSkipButtons: boolean;
  showSwitchMediaButton: boolean;
  showScreenshotButton: boolean;
  showPlayTitleToast: boolean;
  // 手势
  longPressLeftRate: number;
  longPressRightRate: number;
  numberKeyRateSwitch: boolean;
  mouseLeftClick: 'playpause' | 'none';
  mouseLeftDoubleClick: 'playpause' | 'none';
  mouseRightClick: 'toggleControls' | 'none';
  // 视频
  preferHwDecode: boolean;
  screenshotFormat: 'jpg' | 'png';
  jpegQuality: number;
  copyScreenshotToClipboard: boolean;
  // 音频
  rememberAudioTrack: boolean;
  preferredAudioLanguage: string;
  audioBoost: boolean;
  // 字幕
  rememberSubtitle: boolean;
  subtitleSearchHistory: boolean;
  preferredSubtitleLanguage: string;
  externalSubtitleRule: 'sameFolderSameName' | 'sameFolder' | 'none';
  hdrSubtitle: boolean;
}

const DEFAULTS: AppSettings = {
  accentColor: '#0a84ff',
  defaultModule: 'files',
  clientIdentities: normalizeClientIdentities(null),
  showItemCountInTitle: false,
  showFolderTime: false,
  sortFoldersSeparately: false,
  thumbnailFill: true,
  showPreviewImage: true,
  previewTimePercent: 10,
  preferEmbeddedCover: true,
  showPlayProgress: true,
  showMediaDuration: true,
  showFileSize: true,
  showNewBadge: true,
  showHdrBadge: true,
  showFrameRate: true,
  showResolution: true,
  simplifyResolution: true,
  resumeFromLastPosition: true,
  preciseSeek: false,
  rewindSeconds: 15,
  forwardSeconds: 15,
  playerCacheSizeMB: PLAYER_CACHE_DEFAULT_MB,
  autoHideControlsSeconds: 3,
  autoFullscreenOnPlay: false,
  matchWindowToVideoRatio: true,
  showSkipButtons: false,
  showSwitchMediaButton: true,
  showScreenshotButton: true,
  showPlayTitleToast: true,
  longPressLeftRate: 0.5,
  longPressRightRate: 2.0,
  numberKeyRateSwitch: false,
  mouseLeftClick: 'none',
  mouseLeftDoubleClick: 'playpause',
  mouseRightClick: 'toggleControls',
  preferHwDecode: true,
  screenshotFormat: 'jpg',
  jpegQuality: 80,
  copyScreenshotToClipboard: true,
  rememberAudioTrack: true,
  preferredAudioLanguage: '默认',
  audioBoost: true,
  rememberSubtitle: true,
  subtitleSearchHistory: true,
  preferredSubtitleLanguage: '默认',
  externalSubtitleRule: 'sameFolderSameName',
  hdrSubtitle: true,
};

interface SettingsState extends AppSettings {
  set: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  setClientIdentity: (protocol: ClientIdentityProtocol, field: keyof ClientIdentity, value: string) => void;
  reset: () => void;
}

export const useSettings = create<SettingsState>()(
  persist<SettingsState, [], [], AppSettings>(
    (set) => ({
      ...DEFAULTS,
      set: (key, value) => set({ [key]: key === 'playerCacheSizeMB' ? normalizePlayerCacheSizeMB(value)
        : key === 'clientIdentities' ? normalizeClientIdentities(value) : value } as Partial<SettingsState>),
      setClientIdentity: (protocol, field, value) => set(state => ({
        clientIdentities: { ...state.clientIdentities, [protocol]: {
          ...state.clientIdentities[protocol], [field]: normalizeClientIdentityText(value),
        } },
      })),
      reset: () => set(DEFAULTS),
    }),
    {
      name: 'mjc:settings',
      version: 2,
      partialize: ({ set: _set, setClientIdentity: _setIdentity, reset: _reset, ...settings }) => settings,
      merge: (persisted, current) => {
        const saved = persisted && typeof persisted === 'object' && !Array.isArray(persisted) ? persisted : {};
        const legacyIdentity = {
          name: 'clientName' in saved ? saved.clientName : '',
          version: 'clientVersion' in saved ? saved.clientVersion : '',
          deviceName: 'clientDeviceName' in saved ? saved.clientDeviceName : '',
        };
        const identities = 'clientIdentities' in saved ? saved.clientIdentities
          : 'clientName' in saved || 'clientVersion' in saved || 'clientDeviceName' in saved
            ? { jellyfin: legacyIdentity, emby: legacyIdentity } : current.clientIdentities;
        const retained = Object.fromEntries(Object.entries(saved)
          .filter(([key]) => !['clientName', 'clientVersion', 'clientDeviceName'].includes(key)));
        return {
          ...current,
          ...retained,
          playerCacheSizeMB: normalizePlayerCacheSizeMB('playerCacheSizeMB' in saved ? saved.playerCacheSizeMB : current.playerCacheSizeMB),
          clientIdentities: normalizeClientIdentities(identities),
        };
      },
      // Adopt the requested 3-second interval once for existing installations.
      // Later user changes remain configurable and survive subsequent launches.
      migrate: (persisted, version) => {
        const previous: Record<string, unknown> = persisted && typeof persisted === 'object' ? { ...persisted } : {};
        delete previous.autoLockOnPause;
        return {
          ...DEFAULTS,
          ...previous,
          autoHideControlsSeconds: version < 1 ? 3
            : typeof previous.autoHideControlsSeconds === 'number' ? previous.autoHideControlsSeconds : 3,
        };
      },
    },
  ),
);

/** Read at request time so cached API instances immediately use saved overrides. */
export const getClientIdentity = (protocol: ClientIdentityProtocol) => resolveClientIdentity(useSettings.getState().clientIdentities[protocol]);

/** Apply accent color CSS variables to :root. */
export function applyAccent(color: string) {
  const root = document.documentElement;
  root.style.setProperty('--accent', color);
  root.style.setProperty('--accent-soft', color + '1f');
}
