import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import Hls from 'hls.js';
import { BaseItem, MediaServerApi, type MediaSource, formatTime, matchesExternalSubtitleRule } from '../api/mediaServer';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';
import {
  IconFullscreen,
  IconPause,
  IconPlay,
  IconSkipBack,
  IconSkipForward,
  IconVolume,
} from '../components/icons';
import { isTauri, windowIsFullscreen, windowSetFullscreen } from '../platform/window';
import { bindBrowserPlaybackKeys } from '../player/browserKeyboard';
import { getAdjacentMedia, getPlaybackPreferences, rememberTrack, saveSubtitleSearchQueries } from '../player/playbackPreferences';
import { preferredTrack } from '../player/trackSelection';
import { PLAYER_EXIT_EVENT } from '../player/exitPlayback';

const DIRECT_PLAY_CONTAINERS = ['mp4', 'm4v', 'mkv', 'mov', 'webm'];

interface Session {
  playSessionId?: string;
  mediaSourceId?: string;
}

/** Custom seek slider with buffered ranges and hover time tooltip. */
function SeekBar({
  current,
  duration,
  buffered,
  onSeek,
  disabled = false,
}: {
  current: number;
  duration: number;
  buffered: [number, number][];
  onSeek: (t: number) => void;
  disabled?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState(0);

  const frac = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;

  return (
    <div
      className={`group relative flex h-5 items-center ${disabled || duration <= 0 ? 'cursor-not-allowed' : 'cursor-pointer'}`}
      onPointerDown={(e) => {
        if (disabled || duration <= 0) return;
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        if (duration > 0) onSeek(frac(e.clientX) * duration);
      }}
      onPointerMove={(e) => {
        const f = frac(e.clientX);
        setHoverX(f * 100);
        setHoverT(duration > 0 ? f * duration : null);
        if (draggingRef.current && duration > 0) onSeek(f * duration);
      }}
      onPointerUp={() => {
        draggingRef.current = false;
      }}
      onPointerLeave={() => {
        setHoverT(null);
        draggingRef.current = false;
      }}
    >
      <div
        ref={trackRef}
        className="relative h-1 w-full rounded bg-white/30 transition-all duration-150 group-hover:h-1.5"
      >
        {duration > 0 &&
          buffered.map(([s, e], i) => (
            <div
              key={i}
              className="absolute inset-y-0 rounded bg-white/20"
              style={{
                left: `${(s / duration) * 100}%`,
                width: `${Math.max(0, ((e - s) / duration) * 100)}%`,
              }}
            />
          ))}
        <div className="absolute inset-y-0 left-0 rounded bg-accent" style={{ width: `${pct}%` }} />
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent opacity-0 shadow transition-opacity group-hover:opacity-100"
          style={{ left: `${pct}%` }}
        />
      </div>
      {hoverT != null && duration > 0 && (
        <div
          className="pointer-events-none absolute -top-8 -translate-x-1/2 rounded-md bg-black/80 px-2 py-1 text-[11px] tabular-nums text-white"
          style={{ left: `${hoverX}%` }}
        >
          {formatTime(hoverT)}
        </div>
      )}
    </div>
  );
}

/** Slim volume slider. */
function VolumeSlider({
  volume,
  muted,
  onChange,
  disabled = false,
}: {
  volume: number;
  muted: boolean;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const set = (clientX: number) => {
    if (disabled) return;
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    onChange(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
  };
  const pct = (muted ? 0 : volume) * 100;
  return (
    <div
      className={`flex h-6 w-20 items-center ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        set(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) set(e.clientX);
      }}
    >
      <div ref={trackRef} className="relative h-1 w-full rounded bg-white/30">
        <div className="absolute inset-y-0 left-0 rounded bg-white" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function PlayerPage() {
  const { serverId, itemId } = useParams<{ serverId: string; itemId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const settings = useSettings();

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const apiRef = useRef<MediaServerApi | null>(null);
  const sessionRef = useRef<Session>({});
  const startPosRef = useRef(0); // ticks
  const startedRef = useRef(false);
  const hideTimerRef = useRef<number | undefined>(undefined);
  const controlsRef = useRef(true);
  const fsRef = useRef(false);
  const sourceRef = useRef<MediaSource | null>(null);
  const clickTimerRef = useRef<number | undefined>();
  const lockedRef = useRef(false);
  const generationRef = useRef(0);
  const switchingRef = useRef(false);
  const corsRetriedRef = useRef(false);

  const [item, setItem] = useState<BaseItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [controlsVisible, setControlsVisibleState] = useState(true);
  const [isFullscreen, setIsFullscreenState] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [buffered, setBuffered] = useState<[number, number][]>([]);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState('');
  const [audioTracks, setAudioTracks] = useState<{ id: number; title: string; lang?: string }[]>([]);
  const [subTracks, setSubTracks] = useState<{ id: number; title: string; lang?: string; url?: string }[]>([]);
  const [audioTrack, setAudioTrack] = useState(-1);
  const [subTrack, setSubTrack] = useState(-1);
  const [subSearch, setSubSearch] = useState('');
  const [subSearches, setSubSearches] = useState<string[]>([]);
  const mediaKey = () => `${itemId}:${sourceRef.current?.Id ?? ''}:web`;
  const setLock = useCallback((value: boolean) => { lockedRef.current = value; setLocked(value); }, []);

  useEffect(() => { if (!settings.autoLockOnPause) setLock(false); }, [settings.autoLockOnPause, setLock]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const setControls = useCallback((v: boolean) => {
    controlsRef.current = v;
    setControlsVisibleState(v);
  }, []);

  const setFullscreen = useCallback((v: boolean) => {
    fsRef.current = v;
    setIsFullscreenState(v);
  }, []);

  const poke = useCallback(() => {
    setControls(true);
    window.clearTimeout(hideTimerRef.current);
    const secs = useSettings.getState().autoHideControlsSeconds;
    hideTimerRef.current = window.setTimeout(() => setControls(false), Math.max(1, secs) * 1000);
  }, [setControls]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (useSettings.getState().autoFullscreenOnPlay && !startedRef.current && !isTauri && !document.fullscreenElement) {
        containerRef.current?.requestFullscreen().then(() => setFullscreen(true)).catch(() => {});
      }
      v.play().catch(() => {});
    }
    else v.pause();
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (isTauri) {
      const fs = await windowIsFullscreen();
      await windowSetFullscreen(!fs);
      setFullscreen(!fs);
    } else if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
      setFullscreen(false);
    } else {
      await containerRef.current?.requestFullscreen().catch(() => {});
      setFullscreen(!!document.fullscreenElement);
    }
  }, [setFullscreen]);

  const changeVolume = useCallback((nv: number) => {
    const v = videoRef.current;
    if (!v || lockedRef.current) return;
    v.volume = nv;
    if (nv > 0) v.muted = false;
  }, []);

  const reportStopped = useCallback(() => {
    const api = apiRef.current;
    const v = videoRef.current;
    const s = sessionRef.current;
    if (!api || !v || !s.mediaSourceId || !startedRef.current) return;
    const ticks = Math.round(v.currentTime * 10_000_000);
    startedRef.current = false;
    api
      .reportPlaybackStopped({
        ItemId: itemId,
        PlaySessionId: s.playSessionId,
        MediaSourceId: s.mediaSourceId,
        PositionTicks: ticks,
      })
      .catch(() => {});
    try {
      localStorage.setItem(`mjc:pos:${serverId}:${itemId}`, String(ticks));
    } catch {
      /* ignore */
    }
  }, [itemId, serverId]);

  const reportStoppedRef = useRef(reportStopped);
  reportStoppedRef.current = reportStopped;

  // ---------- Load item + playback info, wire up the source ----------
  useEffect(() => {
    if (!serverId || !itemId) return;
    generationRef.current++;
    switchingRef.current = false;
    corsRetriedRef.current = false;
    setLoading(true); setError(null); setBuffering(false); setItem(null);
    setAudioTracks([]); setSubTracks([]); setAudioTrack(-1); setSubTrack(-1); setSubSearch(''); setLock(false);
    startedRef.current = false; sessionRef.current = {}; sourceRef.current = null;
    let cancelled = false;
    const controller = new AbortController();
    const video = videoRef.current;
    const api = useServers.getState().getApi(serverId);
    apiRef.current = api;
    if (!api) {
      setError('未找到服务器，请先添加并连接服务器');
      setLoading(false);
      return;
    }

    (async () => {
      try {
        const [it, info] = await Promise.all([
          api.getItem(itemId, controller.signal),
          api.getPlaybackInfo(itemId, 'web', controller.signal),
        ]);
        if (cancelled) return;
        const source = info.MediaSources?.[0];
        if (!source) throw new Error('没有可用的媒体源');
        setItem(it);
        sourceRef.current = source;
        const prefs = getPlaybackPreferences(serverId, `${itemId}:${source.Id}:web`, useSettings.getState());
        setSubSearches(prefs.subtitleSearchQueries);
        sessionRef.current = { playSessionId: info.PlaySessionId ?? crypto.randomUUID().replace(/-/g, ''), mediaSourceId: source.Id };

        const st = useSettings.getState();
        const posParam = searchParams.get('pos');
        let startTicks = posParam ? parseInt(posParam, 10) : NaN;
        if (Number.isNaN(startTicks)) {
          startTicks = st.resumeFromLastPosition ? it.UserData?.PlaybackPositionTicks ?? 0 : 0;
        }
        startPosRef.current = startTicks;

        const v = videoRef.current;
        if (!v) return;
        const container = (source.Container || '').toLowerCase();
        if (source.SupportsDirectPlay && DIRECT_PLAY_CONTAINERS.includes(container)) {
          v.src = api.directStreamUrl(itemId, source.Id, sessionRef.current.playSessionId, source);
        } else if (Hls.isSupported()) {
          const hls = new Hls({ maxBufferLength: 30, xhrSetup: (xhr) => {
            for (const [name, value] of Object.entries(source.RequiredHttpHeaders ?? {})) xhr.setRequestHeader(name, value);
          } });
          hlsRef.current = hls;
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return;
            const audio = hls.audioTracks.map((t, id) => ({ id, title: t.name || t.lang || `音轨 ${id + 1}`, lang: t.lang }));
            const streams = (source.MediaStreams ?? []).filter(s => s.Type === 'Subtitle');
            const subs = hls.subtitleTracks.map((t, id) => ({ id, title: t.name || t.lang || `字幕 ${id + 1}`, lang: t.lang }))
              .filter(t => {
                const stream = streams.find(s => s.DisplayTitle === t.title || s.Title === t.title) ?? streams[t.id];
                return stream?.IsExternal === false || (stream && !stream.IsExternal) || matchesExternalSubtitleRule(source.Path, stream?.Path, st.externalSubtitleRule);
              });
            setAudioTracks(audio); setSubTracks(subs);
            const a = preferredTrack(audio, prefs.rememberedAudio, st.preferredAudioLanguage);
            const s = preferredTrack(subs, prefs.rememberedSubtitle, st.preferredSubtitleLanguage);
            if (a) hls.audioTrack = a.id;
            if (!subs.length || prefs.rememberedSubtitle?.id === 'no') hls.subtitleTrack = -1;
            else if (s) hls.subtitleTrack = s.id;
            else if (!subs.some(t => t.id === hls.subtitleTrack)) hls.subtitleTrack = -1;
            setAudioTrack(hls.audioTrack); setSubTrack(hls.subtitleTrack);
          });
          hls.on(Hls.Events.ERROR, (_evt, data) => {
            if (data.fatal) setError(data.details || '媒体流加载失败');
          });
          hls.loadSource(api.hlsUrl(itemId, source.Id, sessionRef.current.playSessionId, source));
          hls.attachMedia(v);
        } else {
          v.src = api.directStreamUrl(itemId, source.Id, sessionRef.current.playSessionId, source);
        }
        if (!hlsRef.current) {
          const subtitles = (source.MediaStreams ?? []).filter(stream => stream.Type === 'Subtitle'
            && (stream.IsExternal || stream.DeliveryUrl) && stream.Index != null
            && (!stream.IsExternal || matchesExternalSubtitleRule(source.Path, stream.Path, st.externalSubtitleRule)))
            .map(stream => ({ id: stream.Index!, title: stream.DisplayTitle ?? stream.Title ?? stream.Language ?? `字幕 ${stream.Index}`,
              lang: stream.Language, url: api.resolveMediaUrl(`/Videos/${itemId}/${source.Id}/Subtitles/${stream.Index}/0/Stream.vtt`) }));
          setSubTracks(subtitles);
          const s = preferredTrack(subtitles, prefs.rememberedSubtitle, st.preferredSubtitleLanguage);
          setSubTrack(prefs.rememberedSubtitle?.id === 'no' ? -1 : s?.id ?? -1);
        }
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      generationRef.current++;
      controller.abort();
      window.clearTimeout(clickTimerRef.current);
      reportStopped();
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video?.pause();
      video?.removeAttribute('src');
      video?.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, itemId]);

  // ---------- Progress reporting + stop reporting ----------
  useEffect(() => {
    const id = window.setInterval(() => {
      const api = apiRef.current;
      const v = videoRef.current;
      const s = sessionRef.current;
      if (!api || !v || !s.mediaSourceId || !startedRef.current) return;
      const ticks = Math.round(v.currentTime * 10_000_000);
      api
        .reportPlaybackProgress({
          ItemId: itemId,
          PlaySessionId: s.playSessionId,
          MediaSourceId: s.mediaSourceId,
          IsPaused: v.paused,
          PositionTicks: ticks,
        })
        .catch(() => {});
      try {
        localStorage.setItem(`mjc:pos:${serverId}:${itemId}`, String(ticks));
      } catch {
        /* ignore */
      }
    }, 10_000);

    const onUnload = () => reportStoppedRef.current();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('beforeunload', onUnload);
      reportStopped();
    };
  }, [itemId, serverId]);

  // ---------- Keyboard shortcuts ----------
  useEffect(() => bindBrowserPlaybackKeys(window, () => videoRef.current, () => useSettings.getState(), {
    togglePlay, toggleLock: () => setLock(!lockedRef.current), fullscreen: toggleFullscreen, activity: poke, locked: () => lockedRef.current,
    exit: () => {
          if (isTauri && fsRef.current) {
            windowSetFullscreen(false);
            setFullscreen(false);
          } else if (!document.fullscreenElement) {
            navigate(-1);
          }
    },
  }), [navigate, poke, togglePlay, toggleFullscreen, setFullscreen, setLock]);

  useEffect(() => {
    const onClose = (event: Event) => { event.preventDefault(); navigate(-1); };
    window.addEventListener(PLAYER_EXIT_EVENT, onClose);
    return () => window.removeEventListener(PLAYER_EXIT_EVENT, onClose);
  }, [navigate]);

  // ---------- Browser fullscreen sync + initial hide timer ----------
  useEffect(() => {
    const onFsChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    poke();
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      window.clearTimeout(hideTimerRef.current);
    };
  }, [poke, setFullscreen]);

  // ---------- Video event handlers ----------
  const handleLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    setDuration(v.duration || 0);
    const start = startPosRef.current;
    if (start > 0 && Number.isFinite(v.duration) && start / 1e7 < v.duration - 5) {
      v.currentTime = start / 1e7;
    }
  };

  const readBuffered = () => {
    const v = videoRef.current;
    if (!v) return;
    const ranges: [number, number][] = [];
    for (let i = 0; i < v.buffered.length; i++) {
      ranges.push([v.buffered.start(i), v.buffered.end(i)]);
    }
    setBuffered(ranges);
  };

  const handlePlay = () => {
    setPlaying(true);
    setLock(false);
    poke();
    const api = apiRef.current;
    const v = videoRef.current;
    const s = sessionRef.current;
    const st = useSettings.getState();
    if (!startedRef.current && st.showPlayTitleToast) setNotice(title);
    if (api && v && s.mediaSourceId && !startedRef.current) {
      startedRef.current = true;
      api
        .reportPlaybackStart({
          ItemId: itemId,
          PlaySessionId: s.playSessionId,
          MediaSourceId: s.mediaSourceId,
          PositionTicks: Math.round(v.currentTime * 10_000_000),
        })
        .catch(() => {});
    }
    if (st.autoFullscreenOnPlay && isTauri) {
      windowIsFullscreen().then((fs) => {
        if (!fs) {
          windowSetFullscreen(true);
          setFullscreen(true);
        }
      });
    } else if (st.autoFullscreenOnPlay && !document.fullscreenElement) {
      containerRef.current?.requestFullscreen().then(() => setFullscreen(true)).catch(() => {});
    }
  };

  // ---------- Mouse handling (per settings) ----------
  const handleClick = () => {
    poke();
    window.clearTimeout(clickTimerRef.current);
    if (settings.mouseLeftClick === 'playpause') clickTimerRef.current = window.setTimeout(togglePlay, 500);
  };

  const handleDoubleClick = () => {
    poke();
    window.clearTimeout(clickTimerRef.current);
    if (settings.mouseLeftDoubleClick === 'playpause') togglePlay();
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (settings.mouseRightClick !== 'toggleControls') return;
    if (controlsRef.current) {
      window.clearTimeout(hideTimerRef.current);
      setControls(false);
    } else {
      poke();
    }
  };

  const title = item
    ? item.Type === 'Episode'
      ? `${item.SeriesName ? item.SeriesName + ' ' : ''}S${item.ParentIndexNumber ?? '?'}E${
          item.IndexNumber ?? '?'
        } · ${item.Name}`
      : item.Name
    : '';

  const skip = (delta: number) => {
    const v = videoRef.current;
    if (!v || lockedRef.current) return;
    const time = Math.min(Math.max(0, v.currentTime + delta), v.duration || Infinity);
    if (!settings.preciseSeek && typeof v.fastSeek === 'function') v.fastSeek(time);
    else v.currentTime = time;
    poke();
  };

  const switchMedia = async (direction: 'prev' | 'next') => {
    if (!apiRef.current || !item || lockedRef.current || switchingRef.current) return;
    const generation = generationRef.current;
    switchingRef.current = true;
    try {
      const next = await getAdjacentMedia(apiRef.current, item, direction);
      if (generation !== generationRef.current) return;
      if (next) navigate(`/player/${serverId}/${next.Id}`, { replace: true });
      else setNotice(direction === 'next' ? '没有下一项媒体' : '没有上一项媒体');
    } catch { if (generation === generationRef.current) setNotice('切换媒体失败'); }
    finally { if (generation === generationRef.current) switchingRef.current = false; }
  };
  const selectTrack = (kind: 'audio' | 'sub', id: number) => {
    if (lockedRef.current) return;
    const tracks = kind === 'audio' ? audioTracks : subTracks;
    if (hlsRef.current) {
      if (kind === 'audio') hlsRef.current.audioTrack = id;
      else hlsRef.current.subtitleTrack = id;
    }
    if (kind === 'audio') setAudioTrack(id); else setSubTrack(id);
    if (serverId && (kind === 'audio' ? settings.rememberAudioTrack : settings.rememberSubtitle)) {
      const track = tracks.find(t => t.id === id);
      rememberTrack(serverId, mediaKey(), kind, track ? { id, title: track.title, lang: track.lang } : { id: 'no' });
    }
  };
  useEffect(() => {
    if (hlsRef.current) return;
    for (let i = 0; i < (videoRef.current?.textTracks.length ?? 0); i++) {
      const track = videoRef.current!.textTracks[i];
      track.mode = subTracks[i]?.id === subTrack ? 'showing' : 'disabled';
    }
  }, [subTrack, subTracks]);
  const captureScreenshot = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || lockedRef.current) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth; canvas.height = v.videoHeight;
      canvas.getContext('2d')!.drawImage(v, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(),
        settings.screenshotFormat === 'jpg' ? 'image/jpeg' : 'image/png', settings.jpegQuality / 100));
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `截图-${Math.floor(v.currentTime)}.${settings.screenshotFormat}`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (settings.copyScreenshotToClipboard) {
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
          setNotice('截图已保存，当前浏览器不支持复制图片'); return;
        }
        const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(), 'image/png'));
        try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]); }
        catch { setNotice('截图已保存，复制到剪贴板失败'); return; }
      }
      setNotice('截图已保存');
    } catch { setNotice('截图失败，请检查服务器跨域权限和浏览器剪贴板权限'); }
  };

  return (
    <div
      ref={containerRef}
      className={`player-surface relative h-full w-full select-none overflow-hidden bg-black ${
        controlsVisible ? '' : 'cursor-none'
      }`}
      onMouseMove={poke}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      <video
        crossOrigin="anonymous"
        ref={videoRef}
        className="h-full w-full object-contain"
        playsInline
        autoPlay
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
        onProgress={readBuffered}
        onDurationChange={() => setDuration(videoRef.current?.duration ?? 0)}
        onVolumeChange={() => {
          const v = videoRef.current;
          if (v) {
            setVolume(v.volume);
            setMuted(v.muted);
          }
        }}
        onPlay={handlePlay}
        onPause={() => {
          setPlaying(false);
          setLock(useSettings.getState().autoLockOnPause);
          poke();
        }}
        onWaiting={() => setBuffering(true)}
        onStalled={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onCanPlay={() => setBuffering(false)}
        onError={() => {
          if (hlsRef.current) return;
          const v = videoRef.current;
          if (v?.crossOrigin && !corsRetriedRef.current && (v.error?.code === 2 || v.error?.code === 4)) {
            // A media CDN can allow playback but refuse canvas/CORS access.
            // Preserve playback in that case; capture reports its own limitation.
            corsRetriedRef.current = true;
            const src = v.src;
            v.removeAttribute('crossorigin'); v.src = src; v.load();
            return;
          }
          setError('视频播放出错');
        }}
      >
        {subTracks.filter(t => t.url).map(t => <track key={t.id} kind="subtitles" src={t.url} label={t.title} srcLang={t.lang} />)}
      </video>

      {notice && <div className="pointer-events-none absolute inset-x-0 top-20 z-30 text-center text-sm text-white">{notice}</div>}

      {/* Loading / buffering spinner */}
      {(loading || buffering) && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-12 w-12 animate-spin rounded-full border-[3px] border-white/20 border-t-white" />
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/90">
          <div className="text-[16px] font-medium text-white">播放失败</div>
          <div className="max-w-md px-6 text-center text-[13px] text-white/60">{error}</div>
        </div>
      )}

      {/* Top bar */}
      <div
        className={`absolute inset-x-0 top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-black/60 to-transparent px-5 pb-10 pt-4 transition-opacity duration-300 ${
          controlsVisible || loading || buffering || duration === 0 ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="truncate text-sm text-white drop-shadow">{title}</div>
        {locked && <button onClick={() => setLock(false)} className="ml-auto rounded-full bg-white/15 px-3 py-1 text-xs text-white">解锁播放操作</button>}
      </div>

      {/* Bottom bar */}
      <div
        className={`absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/70 to-transparent px-6 pb-5 pt-16 transition-opacity duration-300 ${
          controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <SeekBar
          disabled={locked}
          current={currentTime}
          duration={duration}
          buffered={buffered}
          onSeek={(t) => {
            const v = videoRef.current;
            if (v && !lockedRef.current) {
              if (!settings.preciseSeek && typeof v.fastSeek === 'function') v.fastSeek(t);
              else v.currentTime = t;
              setCurrentTime(t);
            }
          }}
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            onClick={togglePlay}
            className="text-white transition hover:text-white/80"
            title={playing ? '暂停' : '播放'}
          >
            {playing ? <IconPause size={22} /> : <IconPlay size={22} />}
          </button>
          {settings.showSkipButtons && <><button
            disabled={locked || duration <= 0}
            onClick={() => skip(-settings.rewindSeconds)}
            className="text-white/90 transition hover:text-white"
            title={`快退 ${settings.rewindSeconds} 秒`}
          >
            <IconSkipBack size={18} />
          </button>
          <button
            onClick={() => skip(settings.forwardSeconds)}
            disabled={locked || duration <= 0}
            className="text-white/90 transition hover:text-white"
            title={`快进 ${settings.forwardSeconds} 秒`}
          >
            <IconSkipForward size={18} />
          </button></>}
          {settings.showSwitchMediaButton && <><button disabled={locked} onClick={() => switchMedia('prev')} className="text-xs text-white/90 disabled:opacity-40">上一项</button>
            <button disabled={locked} onClick={() => switchMedia('next')} className="text-xs text-white/90 disabled:opacity-40">下一项</button></>}
          {settings.showScreenshotButton && <button disabled={locked} onClick={captureScreenshot} className="text-xs text-white/90 disabled:opacity-40">截图</button>}
          {audioTracks.length > 1 && <select aria-label="音轨" disabled={locked} value={audioTrack} onChange={e => selectTrack('audio', Number(e.target.value))} className="max-w-24 rounded bg-black/70 text-xs text-white">
            {audioTracks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>}
          {subTracks.length > 0 && <><input aria-label="搜索字幕" list="subtitle-search-history" disabled={locked} value={subSearch} onChange={e => setSubSearch(e.target.value)}
            onBlur={() => {
              if (!serverId || !settings.subtitleSearchHistory || !subSearch.trim()) return;
              const searches = [subSearch.trim(), ...subSearches.filter(s => s !== subSearch.trim())].slice(0, 10);
              setSubSearches(searches); saveSubtitleSearchQueries(serverId, searches);
            }} placeholder="搜索字幕" className="w-20 rounded bg-black/70 px-1 text-xs text-white" />
            {settings.subtitleSearchHistory && <datalist id="subtitle-search-history">{subSearches.map(q => <option key={q} value={q} />)}</datalist>}
            <select aria-label="字幕" disabled={locked} value={subTrack} onChange={e => selectTrack('sub', Number(e.target.value))} className="max-w-24 rounded bg-black/70 text-xs text-white">
              <option value={-1}>字幕关闭</option>{subTracks.filter(t => t.id === subTrack || t.title.toLowerCase().includes(subSearch.toLowerCase())).map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select></>}
          <span className="text-xs tabular-nums text-white/90">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
          <div className="flex-1" />
          <button
            disabled={locked}
            onClick={() => {
              const v = videoRef.current;
              if (v && !lockedRef.current) v.muted = !v.muted;
            }}
            className="text-white/90 transition hover:text-white"
            title={muted ? '取消静音' : '静音'}
          >
            <IconVolume size={18} />
          </button>
          <VolumeSlider volume={volume} muted={muted} onChange={changeVolume} disabled={locked} />
          <button
            onClick={toggleFullscreen}
            className="text-white/90 transition hover:text-white"
            title={isFullscreen ? '退出全屏' : '全屏'}
          >
            <IconFullscreen size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
