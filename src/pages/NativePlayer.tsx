import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { listen, type Event as TauriEvent, type UnlistenFn } from '@tauri-apps/api/event';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';
import { getAdjacentMedia, getPlaybackPreferences, rememberTrack, saveSubtitleSearchQueries, type TrackPreference } from '../player/playbackPreferences';
import type { BaseItem } from '../api/mediaServer';
import { PLAYER_EXIT_EVENT } from '../player/exitPlayback';

interface PositionPayload {
  position: number;
  duration: number;
  paused: boolean;
  active: boolean;
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
  const { serverId, itemId } = useParams<{ serverId: string; itemId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    if (!serverId || !itemId) return;
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
    setError(null);

    const api = useServers.getState().getApi(serverId);
    if (!api) {
      setError('未找到服务器，请先添加并连接服务器');
      setStarting(false);
      return;
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
        if (!await subscribe('mpv://ready', () => { loaded = true; setStarting(false); })) return;
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
              await invoke('player_message', { message: e.payload === 'next' ? '没有下一项媒体' : '没有上一项媒体' });
            }
          } catch {
            if (!cancelled && !done) await invoke('player_message', { message: '无法获取相邻媒体，请稍后重试' }).catch(() => {});
          } finally { switching = false; }
        })) return;
        if (!await subscribe<string>('mpv://error', (e) => {
          setError(e.payload);
          setStarting(false);
          invoke('stop_playback').catch(() => {});
        })) return;

        const it = await api.getItem(itemId, controller.signal);
        if (cancelled || done) return;
        item = it;

        const st = useSettings.getState();
        const posParam = searchParams.get('pos');
        let startTicks = posParam ? parseInt(posParam, 10) : NaN;
        if (Number.isNaN(startTicks)) {
          startTicks = st.resumeFromLastPosition ? it.UserData?.PlaybackPositionTicks ?? 0 : 0;
        }
        latestPos.position = startTicks / 10_000_000;

        // Preserve Jellyfin's fast path; Emby negotiates a profile and session before streaming.
        let source = it.MediaSources?.[0];
        let container = (source?.Container || '').toLowerCase();
        let directOk = !!source && source.SupportsDirectPlay && !['iso', 'm2ts'].includes(container);
        let playSessionId: string | undefined;

        if (!directOk || api.protocol === 'emby') {
          const info = await api.getPlaybackInfo(itemId, 'native', controller.signal);
          if (cancelled || done) return;
          source = info.MediaSources?.[0];
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
        mediaKey = `${itemId}:${source!.Id}`;

        const title =
          it.Type === 'Episode'
            ? `${it.SeriesName ? it.SeriesName + ' ' : ''}S${it.ParentIndexNumber ?? '?'}E${
                it.IndexNumber ?? '?'
              } · ${it.Name}`
            : it.Name;

        playbackRequested = true;
        await invoke('start_playback', {
          opts: {
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
            settings: { ...st, ...getPlaybackPreferences(serverId, mediaKey, st) },
            media_info: {
              title, filename: (source?.Path ?? it.Path)?.split(/[\\/]/).pop()?.split('?')[0],
              container: source?.Container, size: source?.Size, bitrate: source?.Bitrate,
              server: useServers.getState().servers.find((s) => s.id === serverId)?.name,
            },
          },
        });
        // mpv://ready ends the loading screen when the media is actually loaded.
      } catch (e) {
        if (!cancelled && !done) {
          setError(e instanceof Error ? e.message : String(e));
          setStarting(false);
        }
      }
    })();

    // ESC fallback when the webview (not the mpv window) has focus
    const onKey = async (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat) return;
      e.preventDefault();
      // The webview can keep focus after a title-bar interaction. Loaded
      // playback still delegates Escape to the OSC's modal/menu stack.
      if (!loaded) { finishAndBack(); return; }
      try { if (!await invoke<boolean>('player_escape')) finishAndBack(); }
      catch { finishAndBack(); }
    };
    window.addEventListener('keydown', onKey);
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
      cancelled = true;
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(PLAYER_EXIT_EVENT, onClose);
      unlistens.forEach((u) => u());
      reportStopped();
      if (playbackRequested) invoke('stop_playback').catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, itemId]);

  return (
    <div className="player-surface relative flex h-full w-full flex-col items-center justify-center bg-black text-white/50">
      {error ? (
        <div className="flex flex-col items-center gap-4">
          <div className="text-[16px] font-medium text-white">播放失败</div>
          <div className="max-w-md px-6 text-center text-[13px] text-white/60">{error}</div>
        </div>
      ) : starting ? (
        <>
          <div className="h-10 w-10 animate-spin rounded-full border-[3px] border-white/20 border-t-white" />
          <div className="mt-4 text-[13px]">正在加载视频…</div>
        </>
      ) : (
        <div className="text-[12px] text-white/30">
          ESC 退出 · ←/→ 快退/快进 · ↑/↓/滚轮 音量 · A 音轨 · S 字幕 · M 静音 · 空格 暂停/继续 · K 锁定/解锁控制 · 回车 全屏
        </div>
      )}
    </div>
  );
}
