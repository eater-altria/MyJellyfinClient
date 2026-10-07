import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  isTauri,
  windowClose,
  windowIsMaximized,
  windowMinimize,
  windowToggleMaximize,
  windowIsFullscreen,
} from '../platform/window';
import { IconClose, IconMaximize, IconMinimize, IconPlay } from './icons';
import { PLAYER_EXIT_EVENT } from '../player/exitPlayback';
import { usePlaybackTitle } from '../player/playbackTitle';

/** Frameless title bar with Windows window controls on the right. */
export default function TitleBar({ dark }: { dark?: boolean }) {
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const isPlayer = location.pathname.startsWith('/player');
  const title = usePlaybackTitle((state) => state.title);
  const exiting = useRef(false);
  useEffect(() => { exiting.current = false; }, [location.pathname]);
  const close = () => {
    if (!isPlayer) { void windowClose(); return; }
    if (exiting.current) return;
    exiting.current = true;
    const event = new Event(PLAYER_EXIT_EVENT, { cancelable: true });
    if (window.dispatchEvent(event)) navigate(-1);
  };

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    const update = async () => {
      const [max, full] = await Promise.all([windowIsMaximized(), windowIsFullscreen()]);
      if (!cancelled) { setMaximized(max); setFullscreen(full); }
    };
    void update();
    let unlisten: (() => void) | undefined;
    import('@tauri-apps/api/window').then(async (m) => {
      const w = m.getCurrentWindow();
      const dispose = await w.onResized(update);
      if (cancelled) dispose(); else unlisten = dispose;
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  const ctrlBtn = `cursor-pointer flex h-9 w-11 items-center justify-center ${
    dark ? 'text-white/60 hover:bg-white/10' : 'text-gray-500 hover:bg-black/5'
  }`;

  if (isPlayer && fullscreen) return null;

  return (
    <div
      data-tauri-drag-region
      className={`drag-region relative z-30 flex h-9 shrink-0 select-none items-center justify-between ${
        dark ? 'bg-black' : 'app-titlebar'
      }`}
    >
      {!isPlayer && <div className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-5 text-[11px] font-medium tracking-wide text-text-secondary" data-tauri-drag-region>
        <span className="pointer-events-none flex items-center gap-2"><IconPlay size={12} className="text-accent" /> MyJellyfin</span>
      </div>}

      {isPlayer && <div data-tauri-drag-region className="min-w-0 flex-1 truncate self-stretch px-5 text-xs leading-9 text-white/70" title={title}>
        <span className="pointer-events-none">{title || '播放器'}</span>
      </div>}
      <div className="no-drag flex items-center" onDoubleClick={e => e.stopPropagation()}>
        <button className={ctrlBtn} onClick={windowMinimize} title="最小化" aria-label="最小化">
          <IconMinimize size={14} />
        </button>
        <button
          className={ctrlBtn}
          onClick={windowToggleMaximize}
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原' : '最大化'}
        >
          <IconMaximize size={13} />
        </button>
        <button
          className={`cursor-pointer flex h-9 w-11 items-center justify-center hover:bg-[#e81123] hover:text-white ${
            dark ? 'text-white/60' : 'text-gray-500'
          }`}
          onClick={close}
          title={isPlayer ? '关闭播放器' : '关闭'}
          aria-label={isPlayer ? '关闭播放器' : '关闭'}
        >
          <IconClose size={14} />
        </button>
      </div>
    </div>
  );
}
