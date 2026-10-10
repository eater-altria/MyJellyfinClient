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
  IconPrevious,
  IconNext,
  IconCamera,
  IconMore,
  IconPlaybackAudio,
  IconPlaybackSubtitle,
  IconPlaybackSpeed,
  IconList,
} from '../components/icons';
import { isTauri, windowIsFullscreen, windowSetFullscreen } from '../platform/window';
import { bindBrowserPlaybackKeys } from '../player/browserKeyboard';
import { getAdjacentMedia, getPlaybackPreferences, rememberTrack, saveSubtitleSearchQueries } from '../player/playbackPreferences';
import { preferredTrack } from '../player/trackSelection';
import { PLAYER_EXIT_EVENT } from '../player/exitPlayback';
import { mediaTitle, usePlaybackTitle } from '../player/playbackTitle';
import LiquidGlass from '../components/LiquidGlass';
import { useBrowseActivity } from '../hooks/useBrowseActivity';
import '../player/liquid-glass.css';

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
  onDraggingChange,
}: {
  current: number;
  duration: number;
  buffered: [number, number][];
  onSeek: (t: number) => void;
  disabled?: boolean;
  onDraggingChange?: (dragging: boolean) => void;
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
      role="slider"
      aria-label="播放进度"
      aria-valuemin={0}
      aria-valuemax={Number.isFinite(duration) && duration > 0 ? duration : 0}
      aria-valuenow={current}
      aria-disabled={disabled || duration <= 0}
      tabIndex={disabled || duration <= 0 ? -1 : 0}
      onKeyDown={e => {
        if (disabled || duration <= 0) return;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        const time = e.key === 'Home' ? 0 : e.key === 'End' ? duration : current + (e.key === 'ArrowLeft' ? -5 : 5);
        onSeek(Math.max(0, Math.min(duration, time)));
      }}
      className={`group relative flex h-5 items-center ${disabled || duration <= 0 ? 'cursor-not-allowed' : 'cursor-pointer'}`}
      onPointerDown={(e) => {
        if (disabled || duration <= 0) return;
        e.preventDefault();
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        onDraggingChange?.(true);
        if (duration > 0) onSeek(frac(e.clientX) * duration);
      }}
      onPointerMove={(e) => {
        if (disabled) return;
        const f = frac(e.clientX);
        setHoverX(f * 100);
        setHoverT(duration > 0 ? f * duration : null);
        if (draggingRef.current && duration > 0) onSeek(f * duration);
      }}
      onPointerUp={e => {
        if (draggingRef.current && duration > 0) onSeek(frac(e.clientX) * duration);
        draggingRef.current = false;
        onDraggingChange?.(false);
      }}
      onPointerCancel={() => { draggingRef.current = false; onDraggingChange?.(false); }}
      onLostPointerCapture={() => { draggingRef.current = false; onDraggingChange?.(false); }}
      onPointerLeave={() => {
        if (!draggingRef.current) setHoverT(null);
      }}
    >
      <div
        ref={trackRef}
        className="relative h-1 w-full rounded bg-white/[0.18] transition-all duration-150 group-hover:h-1.5"
      >
        {duration > 0 &&
          buffered.flatMap(([s, e], i) => {
            if (!Number.isFinite(s) || !Number.isFinite(e) || !Number.isFinite(duration)) return [];
            const start = Math.max(0, Math.min(duration, s));
            const end = Math.max(0, Math.min(duration, e));
            if (end <= start) return [];
            return (
              <div
                key={i}
                className="absolute inset-y-0 rounded bg-white/40"
                style={{
                  left: `${(start / duration) * 100}%`,
                  width: `${((end - start) / duration) * 100}%`,
                }}
              />
            );
          })}
        <div className="absolute inset-y-0 left-0 rounded bg-white/[0.82]" style={{ width: `${pct}%` }} />
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-100 shadow transition-opacity group-hover:opacity-100"
          style={{ left: `${pct}%` }}
        />
      </div>
      {hoverT != null && !disabled && duration > 0 && (
        <div
          className="player-seek-tooltip pointer-events-none absolute -top-9 -translate-x-1/2 px-3 py-1.5 text-[11px] tabular-nums text-white"
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
  onDraggingChange,
}: {
  volume: number;
  muted: boolean;
  onChange: (v: number) => void;
  disabled?: boolean;
  onDraggingChange?: (dragging: boolean) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
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
      className={`player-volume-slider flex h-6 items-center ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
      role="slider" aria-label="音量" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={Math.round(pct)} aria-disabled={disabled} tabIndex={disabled ? -1 : 0}
      onPointerDown={(e) => {
        if (disabled) return;
        e.preventDefault();
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        onDraggingChange?.(true);
        set(e.clientX);
      }}
      onPointerUp={e => { if (draggingRef.current) set(e.clientX); draggingRef.current = false; onDraggingChange?.(false); }}
      onPointerCancel={() => { draggingRef.current = false; onDraggingChange?.(false); }}
      onLostPointerCapture={() => { draggingRef.current = false; onDraggingChange?.(false); }}
      onBlur={() => { draggingRef.current = false; onDraggingChange?.(false); }}
      onKeyDown={e => {
        if (disabled) return;
        const values: Record<string, number> = { ArrowRight: volume + 0.05, ArrowUp: volume + 0.05,
          ArrowLeft: volume - 0.05, ArrowDown: volume - 0.05, Home: 0, End: 1 };
        if (!(e.key in values)) return;
        e.preventDefault(); e.stopPropagation();
        onChange(Math.max(0, Math.min(1, values[e.key])));
      }}
      onPointerMove={(e) => {
        if (draggingRef.current) set(e.clientX);
      }}
    >
      <div ref={trackRef} className="relative h-1 w-full rounded bg-white/30">
        <div className="absolute inset-y-0 left-0 rounded bg-white" style={{ width: `${pct}%` }} />
        <div className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" style={{ left: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function PlayerPage() {
  const active = useBrowseActivity();
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
  const blockedGestureUntilRef = useRef(0);
  const generationRef = useRef(0);
  const switchingRef = useRef(false);
  const corsRetriedRef = useRef(false);
  const volumeDraggingRef = useRef(false);
  const seekDraggingRef = useRef(false);

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
  const [controlsMenu, setControlsMenu] = useState(false);
  const controlsMenuRef = useRef(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const showControlsMenu = (value: boolean) => { controlsMenuRef.current = value; setControlsMenu(value); };
  const [notice, setNotice] = useState('');
  const [audioTracks, setAudioTracks] = useState<{ id: number; title: string; lang?: string }[]>([]);
  const [subTracks, setSubTracks] = useState<{ id: number; title: string; lang?: string; url?: string }[]>([]);
  const [audioTrack, setAudioTrack] = useState(-1);
  const [subTrack, setSubTrack] = useState(-1);
  const [subSearch, setSubSearch] = useState('');
  const [subSearches, setSubSearches] = useState<string[]>([]);
  const mediaKey = () => `${itemId}:${sourceRef.current?.Id ?? ''}:web`;

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
    hideTimerRef.current = window.setTimeout(() => {
      if (!controlsMenuRef.current && !volumeDraggingRef.current && !seekDraggingRef.current) setControls(false);
    }, Math.max(1, secs) * 1000);
  }, [setControls]);
  const onVolumeDragging = (dragging: boolean) => { volumeDraggingRef.current = dragging; poke(); };
  const onSeekDragging = (dragging: boolean) => { seekDraggingRef.current = dragging; poke(); };

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
    if (!v) return;
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
    if (!active || !serverId || !itemId) return;
    generationRef.current++;
    switchingRef.current = false;
    corsRetriedRef.current = false;
    setLoading(true); setError(null); setBuffering(false); setItem(null);
    setBuffered([]);
    usePlaybackTitle.getState().setTitle('');
    showControlsMenu(false);
    setAudioTracks([]); setSubTracks([]); setAudioTrack(-1); setSubTrack(-1); setSubSearch('');
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
        usePlaybackTitle.getState().setTitle(mediaTitle(it));
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
      usePlaybackTitle.getState().setTitle('');
      window.clearTimeout(clickTimerRef.current);
      reportStopped();
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video?.pause();
      video?.removeAttribute('src');
      video?.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, itemId, active]);

  // ---------- Progress reporting + stop reporting ----------
  useEffect(() => {
    if (!active) return;
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
  }, [itemId, serverId, active]);

  // ---------- Keyboard shortcuts ----------
  useEffect(() => active ? bindBrowserPlaybackKeys(window, () => videoRef.current, () => useSettings.getState(), {
    togglePlay, fullscreen: toggleFullscreen, activity: poke,
    exit: () => {
          if (controlsMenuRef.current) { showControlsMenu(false); poke(); return; }
          if (isTauri && fsRef.current) {
            windowSetFullscreen(false);
            setFullscreen(false);
          } else if (!document.fullscreenElement) {
            navigate(-1);
          }
    },
  }) : undefined, [navigate, poke, togglePlay, toggleFullscreen, setFullscreen, active]);

  useEffect(() => {
    if (!active) return;
    const onClose = (event: Event) => { event.preventDefault(); navigate(-1); };
    window.addEventListener(PLAYER_EXIT_EVENT, onClose);
    return () => window.removeEventListener(PLAYER_EXIT_EVENT, onClose);
  }, [navigate, active]);

  // ---------- Browser fullscreen sync + initial hide timer ----------
  useEffect(() => {
    if (!active) return;
    const onFsChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    poke();
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      window.clearTimeout(hideTimerRef.current);
    };
  }, [poke, setFullscreen, active]);

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
    if (controlsMenuRef.current) {
      showControlsMenu(false);
      blockedGestureUntilRef.current = Date.now() + 500;
      return;
    }
    window.clearTimeout(clickTimerRef.current);
    if (settings.mouseLeftClick === 'playpause') clickTimerRef.current = window.setTimeout(togglePlay, 500);
  };

  const handleDoubleClick = () => {
    poke();
    window.clearTimeout(clickTimerRef.current);
    if (Date.now() >= blockedGestureUntilRef.current && settings.mouseLeftDoubleClick === 'playpause') togglePlay();
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (settings.mouseRightClick !== 'toggleControls') return;
    if (controlsRef.current) {
      window.clearTimeout(hideTimerRef.current);
      showControlsMenu(false);
      setControls(false);
    } else {
      poke();
    }
  };

  const title = item ? mediaTitle(item) : '';

  const skip = (delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    const time = Math.min(Math.max(0, v.currentTime + delta), v.duration || Infinity);
    if (!settings.preciseSeek && typeof v.fastSeek === 'function') v.fastSeek(time);
    else v.currentTime = time;
    poke();
  };

  const switchMedia = async (direction: 'prev' | 'next') => {
    if (!apiRef.current || !item || switchingRef.current) return;
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
    if (!v || !v.videoWidth) return;
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
        onTimeUpdate={() => { setCurrentTime(videoRef.current?.currentTime ?? 0); readBuffered(); }}
        onProgress={readBuffered}
        onSeeked={readBuffered}
        onEmptied={() => setBuffered([])}
        onDurationChange={() => setDuration(videoRef.current?.duration ?? 0)}
        onRateChange={() => setPlaybackRate(videoRef.current?.playbackRate ?? 1)}
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

      {controlsVisible && <LiquidGlass tone="dark" intensity="subtle" className="player-side-tools" onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
        {settings.showScreenshotButton && <button onClick={captureScreenshot} className="player-control-button" aria-label="截图" data-tooltip="截图"><IconCamera size={20} /></button>}
        <button onClick={() => { showControlsMenu(!controlsMenu); poke(); }} className="player-control-button" aria-label="播放设置" data-tooltip="播放设置"><IconList size={20} /></button>
      </LiquidGlass>}
      {notice && <div className="pointer-events-none absolute inset-x-0 top-20 z-30 flex justify-center px-5">
        <LiquidGlass tone="dark" intensity="subtle" className="player-notice text-center text-sm text-white" role="status">{notice}</LiquidGlass>
      </div>}

      {/* Loading / buffering spinner */}
      {(loading || buffering) && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <LiquidGlass tone="dark" className="player-status-card">
            <div className="h-9 w-9 animate-spin rounded-full border-[3px] border-white/20 border-t-white" />
            <div className="text-[13px] text-white/80" role="status">{loading ? '正在加载视频…' : '正在缓冲…'}</div>
          </LiquidGlass>
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/75 px-6">
          <LiquidGlass tone="dark" className="player-status-card player-error-card" role="alert">
            <div className="text-[18px] font-medium text-white">播放失败</div>
            <div className="max-w-md text-center text-[13px] leading-relaxed text-white/70">{error}</div>
          </LiquidGlass>
        </div>
      )}

      {/* Top bar */}
      <div
        className={`absolute inset-x-0 top-0 z-10 flex items-center justify-center bg-gradient-to-b from-black/20 to-transparent px-5 pb-6 pt-4 transition-opacity duration-300 ${
          controlsVisible || loading || buffering || duration === 0 ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {title && <LiquidGlass tone="dark" intensity="subtle" className="player-title-surface min-w-0 max-w-full">
          <div className="truncate text-center text-sm font-medium text-white">{title}</div>
        </LiquidGlass>}
      </div>

      {/* Timeline and transport share the native controller's inset surface. */}
      <div
        className={`player-controls absolute inset-x-0 bottom-0 z-10 transition-opacity duration-300 ${
          controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {controlsMenu && <LiquidGlass tone="dark" className="player-controls-menu absolute bottom-[calc(100%+10px)] right-2 w-72 max-w-[calc(100%-40px)] overflow-hidden p-4 text-sm text-white">
          {/* Only the content scrolls; the backdrop lens stays over the whole menu. */}
          <div className="player-menu-scroll overflow-y-auto pr-1"
            style={{ maxHeight: 'max(46px, min(326px, calc(100vh - 254px)))' }}>
          <div className="mb-3 text-xs font-medium text-white/50">播放设置</div>
          <label className="player-menu-field">倍速
            <select aria-label="倍速" value={playbackRate} onChange={e => {
              if (videoRef.current) videoRef.current.playbackRate = Number(e.target.value);
            }}>
              {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4, 8].map(rate => <option key={rate} value={rate}>{rate}x</option>)}
              {![0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4, 8].includes(playbackRate) && <option value={playbackRate}>{playbackRate}x</option>}
            </select>
          </label>
          {audioTracks.length > 1 && <label className="player-menu-field">音轨
            <select aria-label="音轨" value={audioTrack} onChange={e => selectTrack('audio', Number(e.target.value))}>
              {audioTracks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
          </label>}
          {subTracks.length > 0 && <>
            <label className="player-menu-field">字幕
              <select aria-label="字幕" value={subTrack} onChange={e => selectTrack('sub', Number(e.target.value))}>
                <option value={-1}>字幕关闭</option>
                {subTracks.filter(t => t.id === subTrack || t.title.toLowerCase().includes(subSearch.toLowerCase())).map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
            </label>
            <input aria-label="搜索字幕" list="subtitle-search-history" value={subSearch} onChange={e => setSubSearch(e.target.value)}
              onBlur={() => {
                if (!serverId || !settings.subtitleSearchHistory || !subSearch.trim()) return;
                const searches = [subSearch.trim(), ...subSearches.filter(s => s !== subSearch.trim())].slice(0, 10);
                setSubSearches(searches); saveSubtitleSearchQueries(serverId, searches);
              }} placeholder="搜索当前字幕" className="mb-2 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white outline-none focus:border-white/50" />
            {settings.subtitleSearchHistory && <datalist id="subtitle-search-history">{subSearches.map(q => <option key={q} value={q} />)}</datalist>}
          </>}
          <div className="player-menu-field">音量
            <VolumeSlider volume={volume} muted={muted} onChange={changeVolume} onDraggingChange={onVolumeDragging} />
          </div>
          <div className="player-compact-actions">
            {settings.showSwitchMediaButton && <>
              <button onClick={() => switchMedia('prev')}>上一项媒体</button>
              <button onClick={() => switchMedia('next')}>下一项媒体</button>
            </>}
            {settings.showSkipButtons && <>
              <button disabled={duration <= 0} onClick={() => skip(-settings.rewindSeconds)}>快退 {settings.rewindSeconds} 秒</button>
              <button disabled={duration <= 0} onClick={() => skip(settings.forwardSeconds)}>快进 {settings.forwardSeconds} 秒</button>
            </>}
          </div>
          {settings.showScreenshotButton && <button onClick={captureScreenshot} className="mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs text-white/80 hover:bg-white/10 disabled:opacity-30"><IconCamera size={16} />截图</button>}
          </div>
        </LiquidGlass>}
        <LiquidGlass tone="dark" intensity="subtle" className="player-glass-panel">
          <div className="player-timeline flex items-center gap-4 text-sm tabular-nums">
            <span className="text-white/95">{formatTime(currentTime)}</span>
            <div className="min-w-0 flex-1"><SeekBar current={currentTime} duration={duration} buffered={buffered}
              onDraggingChange={onSeekDragging}
              onSeek={t => {
                const v = videoRef.current;
                if (v) {
                  if (!settings.preciseSeek && typeof v.fastSeek === 'function') v.fastSeek(t);
                  else v.currentTime = t;
                  setCurrentTime(t);
                }
              }} /></div>
            <span className="text-white/95">{formatTime(duration)}</span>
          </div>
          <div className="player-transport">
            <div className="player-transport-actions flex shrink-0 items-center">
              {settings.showSwitchMediaButton && <button onClick={() => switchMedia('prev')} className="player-control-button player-secondary-button" aria-label="上一项媒体" data-tooltip="上一项媒体"><IconPrevious size={20} /></button>}
              {settings.showSkipButtons && <button disabled={duration <= 0} onClick={() => skip(-settings.rewindSeconds)} className="player-control-button player-secondary-button" aria-label={`快退 ${settings.rewindSeconds} 秒`} data-tooltip={`快退 ${settings.rewindSeconds} 秒`}><IconSkipBack size={18} /></button>}
              <button onClick={togglePlay} className="player-control-button player-play-button" aria-label={playing ? '暂停 · 空格' : '播放 · 空格'} data-tooltip={playing ? '暂停 · 空格' : '播放 · 空格'}>
                {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
              </button>
              {settings.showSkipButtons && <button disabled={duration <= 0} onClick={() => skip(settings.forwardSeconds)} className="player-control-button player-secondary-button" aria-label={`快进 ${settings.forwardSeconds} 秒`} data-tooltip={`快进 ${settings.forwardSeconds} 秒`}><IconSkipForward size={18} /></button>}
              {settings.showSwitchMediaButton && <button onClick={() => switchMedia('next')} className="player-control-button player-secondary-button" aria-label="下一项媒体" data-tooltip="下一项媒体"><IconNext size={20} /></button>}
            </div>
            <div className="player-context-actions flex shrink-0 items-center">
              <button className="player-control-button player-track-action" aria-label={`倍速 ${playbackRate}x`} data-tooltip={`倍速 ${playbackRate}x`} onClick={() => { showControlsMenu(!controlsMenu); poke(); }} aria-expanded={controlsMenu}><IconPlaybackSpeed size={23} /></button>
              {subTracks.length > 0 && <button className="player-control-button player-track-action" aria-label="字幕" data-tooltip="字幕" onClick={() => { showControlsMenu(!controlsMenu); poke(); }} aria-expanded={controlsMenu}><IconPlaybackSubtitle size={23} /></button>}
              {audioTracks.length > 1 && <button className="player-control-button player-track-action" aria-label="音轨" data-tooltip="音轨" onClick={() => { showControlsMenu(!controlsMenu); poke(); }} aria-expanded={controlsMenu}><IconPlaybackAudio size={23} /></button>}
              <button onClick={() => {
                const v = videoRef.current; if (v) v.muted = !v.muted;
              }} className="player-control-button" aria-pressed={muted} aria-label={muted ? '取消静音 · M' : '静音 · M'} data-tooltip={muted ? '取消静音 · M' : '静音 · M'}><span className="player-icon-ring"><IconVolume size={14} /></span></button>
              <VolumeSlider volume={volume} muted={muted} onChange={v => { changeVolume(v); poke(); }} onDraggingChange={onVolumeDragging} />
              <button onClick={toggleFullscreen} className="player-control-button" aria-label={isFullscreen ? '退出全屏' : '全屏 · 回车'} data-tooltip={isFullscreen ? '退出全屏' : '全屏 · 回车'}><IconFullscreen size={18} /></button>
              <button onClick={() => { showControlsMenu(!controlsMenu); poke(); }} className="player-control-button" aria-label="更多" data-tooltip="更多" aria-expanded={controlsMenu}><span className="player-icon-ring"><IconMore size={14} /></span></button>
            </div>
          </div>
        </LiquidGlass>
      </div>
    </div>
  );
}
