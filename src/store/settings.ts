import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type AccentColor = '#0a84ff' | '#30b0c7' | '#34c759' | '#bf5af2' | '#ff9f0a' | '#ff6482' | '#ff453a' | '#7d7aff';

export interface AppSettings {
  // 通用
  accentColor: AccentColor;
  defaultModule: 'files' | 'servers' | 'iptv' | 'history' | 'search';
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
  reset: () => void;
}

export const useSettings = create<SettingsState>()(
  persist<SettingsState, [], [], AppSettings>(
    (set) => ({
      ...DEFAULTS,
      set: (key, value) => set({ [key]: value } as Partial<SettingsState>),
      reset: () => set(DEFAULTS),
    }),
    {
      name: 'mjc:settings',
      version: 2,
      partialize: ({ set: _set, reset: _reset, ...settings }) => settings,
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

/** Apply accent color CSS variables to :root. */
export function applyAccent(color: string) {
  const root = document.documentElement;
  root.style.setProperty('--accent', color);
  root.style.setProperty('--accent-soft', color + '1f');
}
