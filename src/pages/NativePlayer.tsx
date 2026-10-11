import { getServerConnector } from '../api/mediaServer';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { listen, type Event as TauriEvent, type UnlistenFn } from '@tauri-apps/api/event';
import { useServers } from '../store/servers';
import { getClientIdentity, useSettings } from '../store/settings';
import { createPlaybackDiagnostics, describePlaybackRoute, describePlaybackUrl, playbackErrorDetails } from '../player/playbackDiagnostics';
import { getAdjacentMedia, getPlaybackPreferences, rememberTrack, saveSubtitleSearchQueries, type TrackPreference } from '../player/playbackPreferences';
import type { BaseItem } from '../api/mediaServer';
import { PLAYER_EXIT_EVENT } from '../player/exitPlayback';
import { mediaTitle, usePlaybackTitle } from '../player/playbackTitle';
import LiquidGlass from '../components/LiquidGlass';
import { useBrowseActivity } from '../hooks/useBrowseActivity';
import { useDanmaku } from '../hooks/useDanmaku';
import { danmakuDisplaySettings } from '../player/danmakuSettings';
import '../player/liquid-glass.css';

interface PositionPayload {
  position: number;
  duration: number;
  paused: boolean;
  active: boolean;
}

function nativePlaybackKey(key: string): string | undefined {
  const named: Record<string, string> = { ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', ArrowUp: 'UP', ArrowDown: 'DOWN', Backspace: 'BS' };
  return named[key] ?? (/^[mfas0-9]$/i.test(key) ? key.toUpperCase() : undefined);
}

function mapAudioLang(pref: string): string | null {
  switch (pref) {
    case '中文':
      return 'chi,zho,zh';
    case '英文':
      return 'eng,en';
    case '日文':
      return 'jpn,ja';
    default:
      return null;
  }
}

function mapSubLang(pref: string): string | null {
  switch (pref) {
    case '简中':
      return 'zh-hans,chs,chi,zho,zh';
    case '繁中':
      return 'zh-hant,cht,chi,zho';
    case '英文':
      return 'eng,en';
    case '日文':
      return 'jpn,ja';
    default:
      return null;
  }
}

/** Native mpv-backed player page (Tauri). The web UI sits behind the embedded
 * mpv child window; this page only coordinates playback + media-server reporting. */
export default function NativePlayer() {
  const active = useBrowseActivity();
  const { serverId, itemId } = useParams<{ serverId: string; itemId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [diagnosticPath, setDiagnosticPath] = useState<string | null>(null);
  const [diagnosticId, setDiagnosticId] = useState('');
  const [danmakuItem, setDanmakuItem] = useState<BaseItem | null>(null);
  const [danmakuSession, setDanmakuSession] = useState('');
  const settings = useSettings();
  const danmaku = useDanmaku(serverId, danmakuItem?.Id === itemId ? danmakuItem : null, active && !error);
  const danmakuRef = useRef(danmaku);
  danmakuRef.current = danmaku;
  const danmakuFile = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!active || !danmakuSession) return;
    void invoke('player_danmaku', { diagnosticId: danmakuSession, comments: danmaku.comments,
      settings: { ...danmakuDisplaySettings(settings), danmakuSource: settings.danmakuSource, danmakuSelection: danmaku.selection }, choices: danmaku.choices, status: danmaku.status }).catch(() => {});
  }, [active, danmakuSession, danmaku.comments, danmaku.choices, danmaku.status, danmaku.selection, settings.danmakuEnabled,
    settings.danmakuSource, settings.danmakuOpacity, settings.danmakuFontSize, settings.danmakuArea, settings.danmakuDuration, settings.danmakuOffset]);

  useEffect(() => {
    if (!active || !serverId || !itemId) return;
    let cancelled = false;
    let started = false;
    let loaded = false;
    let stopped = false;
    let done = false;
    let playbackRequested = false;
    let item: BaseItem | undefined;
    let mediaKey = itemId;
    let switching = false;
    const controller = new AbortController();
    let session: { playSessionId?: string; mediaSourceId?: string; playMethod?: 'DirectPlay' | 'DirectStream' | 'Transcode' } = {};
    let latestPos: PositionPayload = { position: 0, duration: 0, paused: false, active: false };
    const unlistens: UnlistenFn[] = [];
    setStarting(true);
    setDanmakuItem(null); setDanmakuSession('');
    setError(null);
    usePlaybackTitle.getState().setTitle('');

    const api = useServers.getState().getApi(serverId);
    const secrets = api?.token ? [api.token] : [];
    const trace = createPlaybackDiagnostics(secrets);
    setDiagnosticId(trace.id);
    setDiagnosticPath(null);
    let stage = 'prepare';
    const identity = api?.clientIdentity() ?? getClientIdentity('jellyfin');
    trace.record('playback.prepare', { protocol: api?.protocol, client: identity });
    void invoke<string>('get_playback_log_path').then(path => {
      if (!cancelled && !done) setDiagnosticPath(path);
    }).catch(() => {});
    if (!api) {
      trace.record('playback.failed', { stage, message: '未找到服务器' });
      setError('未找到服务器，请先添加并连接服务器');
      setStarting(false);
      return () => { cancelled = true; trace.record('playback.cleanup', { loaded: false, playbackRequested: false }); };
    }

    const reportStopped = () => {
      if (stopped || !playbackRequested) return;
      stopped = true;
      const s = session;
      const ticks = Math.round(latestPos.position * 10_000_000);
      api
        .reportPlaybackStopped({
          ItemId: itemId,
          PlaySessionId: s.playSessionId,
          MediaSourceId: s.mediaSourceId,
          PlayMethod: s.playMethod,
          PositionTicks: ticks,
        })
        .catch(() => {});
    };

    const finishAndBack = () => {
      // A late callback from a disposed effect must never consume the active
      // effect's exit request (React StrictMode mounts effects twice in dev).
      if (cancelled || done) return;
      done = true;
      trace.record('playback.exit', { loaded, playbackRequested });
      controller.abort();
      reportStopped();
      navigate(-1);
    };

    const subscribe = async <T,>(name: string, handler: (event: TauriEvent<T>) => void) => {
      const unlisten = await listen<T>(name, (event) => {
        if (!cancelled && !done) handler(event);
      });
      // listen() resolves asynchronously, possibly after effect cleanup.
      if (cancelled || done) {
        unlisten();
        return false;
      }
      unlistens.push(unlisten);
      return true;
    };

    (async () => {
      try {
        if (!await subscribe<PositionPayload>('mpv://position', (e) => {
            // mpv observes time-pos before a slow stream has a first frame.
            // Its initial zero must not replace the server resume position.
            if (!loaded && e.payload.position === 0) return;
            latestPos = e.payload;
            if (loaded && !started && e.payload.position > 0) {
              started = true;
              const s = session;
              api
                .reportPlaybackStart({
                  ItemId: itemId,
                  PlaySessionId: s.playSessionId,
                  MediaSourceId: s.mediaSourceId,
                  PlayMethod: s.playMethod,
                  PositionTicks: Math.round(e.payload.position * 10_000_000),
                  CanSeek: e.payload.duration > 0,
                  IsPaused: e.payload.paused,
                })
                .catch(() => {});
            }
          })) return;
        if (!await subscribe<PositionPayload>('mpv://exit', (e) => {
            if (loaded || e.payload.position > 0) latestPos = e.payload;
            finishAndBack();
          })) return;
        if (!await subscribe('mpv://request-stop', finishAndBack)) return;
        if (!await subscribe('mpv://ready', () => { loaded = true; trace.record('playback.ready'); setStarting(false); })) return;
        if (!await subscribe<{ kind: 'audio' | 'sub'; track: TrackPreference }>('mpv://track-selected', (e) => {
          const settings = useSettings.getState();
          if ((e.payload.kind === 'audio' && settings.rememberAudioTrack) || (e.payload.kind === 'sub' && settings.rememberSubtitle)) {
            rememberTrack(serverId, mediaKey, e.payload.kind, e.payload.track);
          }
        })) return;
        if (!await subscribe<string[]>('mpv://subtitle-search-history', (e) => {
          if (useSettings.getState().subtitleSearchHistory) saveSubtitleSearchQueries(serverId, e.payload);
        })) return;
        if (!await subscribe<'prev' | 'next'>('mpv://switch-media', async (e) => {
          if (!item || switching) return;
          switching = true;
          try {
            const next = await getAdjacentMedia(api, item, e.payload);
            if (cancelled || done) return;
            if (next) {
              done = true;
              controller.abort();
              reportStopped();
              navigate(`/player/${serverId}/${next.Id}`, { replace: true });
            } else {
              await invoke('player_message', { diagnosticId: trace.id, message: e.payload === 'next' ? '没有下一项媒体' : '没有上一项媒体' });
            }
          } catch {
            if (!cancelled && !done) await invoke('player_message', { diagnosticId: trace.id, message: '无法获取相邻媒体，请稍后重试' }).catch(() => {});
          } finally { switching = false; }
        })) return;
        if (!await subscribe<{ diagnosticId: string; action: string; id?: string }>('mpv://danmaku-action', e => {
          if (e.payload.diagnosticId !== trace.id) return;
          if (e.payload.action === 'toggle') {
            const settings = useSettings.getState(); settings.set('danmakuEnabled', !settings.danmakuEnabled);
          } else if (e.payload.action === 'import') danmakuFile.current?.click();
          else if (e.payload.action === 'retry') danmakuRef.current.retry();
          else if (e.payload.action === 'search') danmakuRef.current.search();
          else if (e.payload.action === 'select' && typeof e.payload.id === 'string') danmakuRef.current.select(e.payload.id);
        })) return;
        if (!await subscribe<string>('mpv://error', (e) => {
          const details = playbackErrorDetails(e.payload, secrets);
          trace.record('playback.mpv-error', details);
          setError(details.message);
          setStarting(false);
          invoke('stop_playback', { diagnosticId: trace.id }).catch(() => {});
        })) return;

        stage = 'metadata';
        trace.record('metadata.request');
        const it = await api.getItem(itemId, controller.signal);
        if (cancelled || done) return;
        item = it;
        setDanmakuItem(it);
        trace.record('metadata.response', { type: it.Type, sourceCount: it.MediaSources?.length ?? 0 });
        const title = mediaTitle(it);
        usePlaybackTitle.getState().setTitle(title);

        const st = useSettings.getState();
        const { danmakuApiUrl: _danmakuApiUrl, ...playerSettings } = st;
        const posParam = searchParams.get('pos');
        let startTicks = posParam ? parseInt(posParam, 10) : NaN;
        if (Number.isNaN(startTicks)) {
          startTicks = st.resumeFromLastPosition ? it.UserData?.PlaybackPositionTicks ?? 0 : 0;
        }
        latestPos.position = startTicks / 10_000_000;

        // Connectors can require a negotiated profile/session before native streaming.
        let source = it.MediaSources?.[0];
        let container = (source?.Container || '').toLowerCase();
        let directOk = !!source && source.SupportsDirectPlay && !['iso', 'm2ts'].includes(container);
        let playSessionId: string | undefined;

        if (!directOk || getServerConnector(api.protocol).requiresNativePlaybackInfo) {
          stage = 'playback-info';
          trace.record('playback-info.request', { protocol: api.protocol });
          const info = await api.getPlaybackInfo(itemId, 'native', controller.signal);
          if (cancelled || done) return;
          source = info.MediaSources?.[0];
          trace.record('playback-info.response', { sourceCount: info.MediaSources?.length ?? 0, errorCode: info.ErrorCode });
          if (!source) throw new Error('没有可用的媒体源');
          container = (source.Container || '').toLowerCase();
          directOk = !!(source.SupportsDirectPlay || (source.SupportsDirectStream && source.DirectStreamUrl)) && !['iso'].includes(container);
          playSessionId = info.PlaySessionId;
        }
        playSessionId ??= crypto.randomUUID().replace(/-/g, '');
        session = { playSessionId, mediaSourceId: source!.Id,
          playMethod: directOk ? (source?.SupportsDirectPlay ? 'DirectPlay' : 'DirectStream') : 'Transcode' };

        const url = directOk
          ? api.directStreamUrl(itemId, source!.Id, playSessionId, source)
          : api.hlsUrl(itemId, source!.Id, playSessionId, source);

        const subFiles = api.externalSubtitleUrls(itemId, source, st.externalSubtitleRule);
        void describePlaybackRoute(url, api.baseUrl).then(details => trace.record('media.route', details)).catch(() => {});
        trace.record('media.selected', { playMethod: session.playMethod, container,
          supportsDirectPlay: source?.SupportsDirectPlay, supportsDirectStream: source?.SupportsDirectStream,
          supportsTranscoding: source?.SupportsTranscoding, subtitleCount: subFiles.length,
          headerNames: Object.keys(source?.RequiredHttpHeaders ?? {}), stream: describePlaybackUrl(url, api.baseUrl) });
        mediaKey = `${itemId}:${source!.Id}`;

        playbackRequested = true;
        stage = 'mpv-start';
        trace.record('playback.start.request', { cacheMB: st.playerCacheSizeMB, hardwareDecode: st.preferHwDecode });
        await invoke('start_playback', {
          opts: {
            diagnostic_id: trace.id,
            url,
            title,
            start_seconds: startTicks / 10_000_000,
            rewind_seconds: st.rewindSeconds,
            forward_seconds: st.forwardSeconds,
            hw_decode: st.preferHwDecode,
            audio_boost: st.audioBoost,
            precise_seek: st.preciseSeek,
            sub_files: subFiles,
            http_headers: source?.RequiredHttpHeaders,
            alang: mapAudioLang(st.preferredAudioLanguage),
            slang: mapSubLang(st.preferredSubtitleLanguage),
            settings: { ...playerSettings, ...getPlaybackPreferences(serverId, mediaKey, st) },
            media_info: {
              title, filename: (source?.Path ?? it.Path)?.split(/[\\/]/).pop()?.split('?')[0],
              container: source?.Container, size: source?.Size, bitrate: source?.Bitrate,
              server: useServers.getState().servers.find((s) => s.id === serverId)?.name,
            },
          },
        });
        if (!cancelled && !done) { trace.record('playback.start.accepted'); setDanmakuSession(trace.id); }
        // mpv://ready ends the loading screen when the media is actually loaded.
      } catch (e) {
        if (!cancelled && !done) {
          const details = playbackErrorDetails(e, secrets);
          trace.record('playback.failed', { stage, ...details });
          setError(details.message);
          setStarting(false);
        }
      }
    })();

    // The webview can regain keyboard focus after Alt+Tab or a title-bar action.
    const heldKeys = new Set<string>();
    const releaseKeys = () => {
      for (const key of heldKeys) void invoke('player_keyboard_input', { diagnosticId: trace.id, key, down: false }).catch(() => {});
      heldKeys.clear();
    };
    const onKey = async (e: KeyboardEvent) => {
      if (cancelled || done || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      if (typeof HTMLElement !== 'undefined' && e.target instanceof HTMLElement
        && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === ' ' || e.key === 'Enter') {
        if (!loaded) return;
        e.preventDefault();
        await invoke('player_keyboard_action', { diagnosticId: trace.id, key: e.key === ' ' ? 'SPACE' : 'ENTER' }).catch(() => {});
        return;
      }
      if (e.key !== 'Escape') {
        const key = nativePlaybackKey(e.key);
        if (!key || !loaded || heldKeys.has(key)) return;
        e.preventDefault(); heldKeys.add(key);
        await invoke('player_keyboard_input', { diagnosticId: trace.id, key, down: true }).catch(() => {});
        return;
      }
      e.preventDefault();
      // The webview can keep focus after a title-bar interaction. Loaded
      // playback still delegates Escape to the OSC's modal/menu stack.
      if (!loaded) { finishAndBack(); return; }
      try { if (!await invoke<boolean>('player_escape', { diagnosticId: trace.id })) finishAndBack(); }
      catch { finishAndBack(); }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = nativePlaybackKey(e.key);
      if (!key || !heldKeys.delete(key)) return;
      e.preventDefault();
      void invoke('player_keyboard_input', { diagnosticId: trace.id, key, down: false }).catch(() => {});
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseKeys);
    const onClose = (event: Event) => { event.preventDefault(); finishAndBack(); };
    window.addEventListener(PLAYER_EXIT_EVENT, onClose);

    // 10s media-server progress reporting
    const interval = window.setInterval(() => {
      if (!started || stopped) return;
      const s = session;
      api
        .reportPlaybackProgress({
          ItemId: itemId,
          PlaySessionId: s.playSessionId,
          MediaSourceId: s.mediaSourceId,
          PlayMethod: s.playMethod,
          IsPaused: latestPos.paused,
          PositionTicks: Math.round(latestPos.position * 10_000_000),
        })
        .catch(() => {});
    }, 10_000);

    return () => {
      trace.record('playback.cleanup', { loaded, playbackRequested });
      cancelled = true;
      controller.abort();
      usePlaybackTitle.getState().setTitle('');
      window.clearInterval(interval);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseKeys);
      releaseKeys();
      window.removeEventListener(PLAYER_EXIT_EVENT, onClose);
      unlistens.forEach((u) => u());
      reportStopped();
      if (playbackRequested) invoke('stop_playback', { diagnosticId: trace.id }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, itemId, active]);

  return (
    <div className="player-surface player-native-stage relative flex h-full w-full flex-col items-center justify-center bg-black px-6 text-white/50">
      <input ref={danmakuFile} type="file" accept=".xml,text/xml,application/xml" className="hidden" aria-label="导入 XML 弹幕"
        onChange={e => { const file = e.target.files?.[0]; if (file) void danmaku.importXml(file); e.target.value = ''; }} />
      {error ? (
        <LiquidGlass tone="dark" className="player-status-card player-error-card !justify-start max-h-full overflow-y-auto" role="alert">
          <div className="text-[18px] font-medium text-white">播放失败</div>
          <div className="max-w-md text-center text-[13px] leading-relaxed text-white/70">{error}</div>
          <div className="max-w-md break-all text-center text-[11px] leading-relaxed text-white/50 select-text">
            <div>诊断编号：{diagnosticId}</div>
            {diagnosticPath && <div className="mt-1">诊断日志：{diagnosticPath}</div>}
          </div>
        </LiquidGlass>
      ) : starting ? (
        <LiquidGlass tone="dark" className="player-status-card">
          <div className="h-9 w-9 animate-spin rounded-full border-[3px] border-white/20 border-t-white" />
          <div className="text-[13px] text-white/80" role="status">正在加载视频…</div>
        </LiquidGlass>
      ) : (
        <div className="text-[12px] text-white/30">
          ESC 退出 · ←/→ 快退/快进 · ↑/↓/滚轮 音量 · A 音轨 · S 字幕 · M 静音 · 空格 暂停/继续 · 回车 全屏
        </div>
      )}
    </div>
  );
}
