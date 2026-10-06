import type { AppSettings } from '../store/settings';

/** A short press seeks on release; a held arrow temporarily changes playback rate. */
export function bindBrowserPlaybackKeys(target: Window, video: () => HTMLVideoElement | null,
  settings: () => AppSettings, actions: {
    togglePlay(): void; toggleLock?(): void; fullscreen(): void; exit(): void; activity(): void; locked(): boolean;
  }) {
  let held: { key: string; timer: number; rate: number; fast: boolean } | undefined;
  const release = (seek: boolean) => {
    if (!held) return;
    target.clearTimeout(held.timer);
    const v = video(), old = held;
    held = undefined;
    if (!v) return;
    if (old.fast) v.playbackRate = old.rate;
    else if (seek && !actions.locked()) {
      const st = settings();
      const pos = v.currentTime + (old.key === 'ArrowLeft' ? -st.rewindSeconds : st.forwardSeconds);
      const end = Number.isFinite(v.duration) ? v.duration : Infinity;
      const time = Math.max(0, Math.min(end, pos));
      if (!st.preciseSeek && typeof v.fastSeek === 'function') v.fastSeek(time);
      else v.currentTime = time;
    }
  };
  const down = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === 'Escape') { release(false); actions.exit(); return; }
    if (e.repeat) return;
    const v = video();
    if (!v) return;
    const st = settings();
    if ([' ', 'k', 'K'].includes(e.key)) {
      e.preventDefault(); release(false);
      if (e.key.toLowerCase() === 'k' && actions.toggleLock) actions.toggleLock();
      else actions.togglePlay();
    }
    else if (['Enter', 'f', 'F'].includes(e.key)) { e.preventDefault(); actions.fullscreen(); }
    else if (actions.locked()) return;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); release(false);
      const current = { key: e.key, rate: v.playbackRate, fast: false, timer: 0 };
      current.timer = target.setTimeout(() => {
        if (held !== current || actions.locked()) return;
        current.fast = true;
        v.playbackRate = current.key === 'ArrowLeft' ? settings().longPressLeftRate : settings().longPressRightRate;
      }, 350);
      held = current;
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault(); v.volume = Math.max(0, Math.min(1, v.volume + (e.key === 'ArrowUp' ? 0.05 : -0.05)));
    } else if (e.key.toLowerCase() === 'm') v.muted = !v.muted;
    else if (st.numberKeyRateSwitch && /^\d$/.test(e.key)) {
      release(false); v.playbackRate = Number(e.key) || 1;
    } else return;
    actions.activity();
  };
  const up = (e: KeyboardEvent) => { if (held?.key === e.key) { e.preventDefault(); release(true); } };
  const blur = () => release(false);
  target.addEventListener('keydown', down); target.addEventListener('keyup', up); target.addEventListener('blur', blur);
  return () => {
    release(false);
    target.removeEventListener('keydown', down); target.removeEventListener('keyup', up); target.removeEventListener('blur', blur);
  };
}
