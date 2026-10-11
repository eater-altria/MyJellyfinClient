export interface DanmakuSettings {
  danmakuEnabled: boolean;
  danmakuSource: 'server' | 'api';
  danmakuApiUrl: string;
  danmakuOpacity: number;
  danmakuFontSize: number;
  danmakuArea: number;
  /** Saved base duration; use danmakuDisplayDuration for visible seconds. */
  danmakuDuration: number;
  danmakuOffset: number;
}

export const DANMAKU_DEFAULTS: DanmakuSettings = {
  danmakuEnabled: false, danmakuSource: 'server', danmakuApiUrl: '',
  danmakuOpacity: 0.85, danmakuFontSize: 24, danmakuArea: 0.5,
  danmakuDuration: 8, danmakuOffset: 0,
};

/** Keep saved duration choices stable; 70% speed takes 1 / 0.7 as long to cross. */
export function danmakuDisplayDuration(baseDuration: number): number {
  return baseDuration / 0.7;
}

export function normalizeDanmakuSettings(value: Partial<Record<keyof DanmakuSettings, unknown>>): DanmakuSettings {
  const number = (key: keyof DanmakuSettings, min: number, max: number) => {
    const n = value[key];
    return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : DANMAKU_DEFAULTS[key] as number;
  };
  return {
    danmakuEnabled: typeof value.danmakuEnabled === 'boolean' ? value.danmakuEnabled : DANMAKU_DEFAULTS.danmakuEnabled,
    danmakuSource: value.danmakuSource === 'api' ? 'api' : 'server',
    danmakuApiUrl: typeof value.danmakuApiUrl === 'string' ? value.danmakuApiUrl.trim().slice(0, 2048) : '',
    danmakuOpacity: number('danmakuOpacity', 0.1, 1),
    danmakuFontSize: Math.round(number('danmakuFontSize', 12, 48)),
    danmakuArea: number('danmakuArea', 0.25, 1),
    danmakuDuration: number('danmakuDuration', 4, 20),
    danmakuOffset: number('danmakuOffset', -600, 600),
  };
}

/** Only display preferences may cross the mpv boundary; API paths can contain tokens. */
export function danmakuDisplaySettings(value: DanmakuSettings) {
  const { danmakuApiUrl: _url, danmakuSource: _source, ...display } = normalizeDanmakuSettings(value);
  return display;
}
