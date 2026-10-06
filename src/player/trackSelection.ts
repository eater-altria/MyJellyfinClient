import type { TrackPreference } from './playbackPreferences';

export interface BrowserTrack { id: number; title: string; lang?: string }

export function preferredTrack<T extends BrowserTrack>(tracks: T[], saved: TrackPreference | undefined, preference: string): T | undefined {
  if (saved?.id === 'no') return undefined;
  const remembered = tracks.find(t => saved?.id != null && String(t.id) === String(saved.id))
    ?? tracks.find(t => saved && (saved.lang || saved.title) && (!saved.lang || saved.lang === t.lang) && (!saved.title || saved.title === t.title));
  if (remembered) return remembered;
  const score = (track: T) => {
    const lang = (track.lang ?? '').toLowerCase();
    const simple = /简|simplified|\bchs\b/i.test(track.title) || /^(zh-hans|zh-cn|zh-sg|chs)/.test(lang);
    const traditional = /繁|traditional|\bcht\b/i.test(track.title) || /^(zh-hant|zh-tw|zh-hk|zh-mo|cht)/.test(lang);
    const chinese = /^(chi|zho|zh|chs|cht|yue|cmn)/.test(lang) || /中文|简|繁/.test(track.title);
    if (preference === '简中') return traditional ? 0 : simple ? 30 : chinese ? 10 : 0;
    if (preference === '繁中') return simple ? 0 : traditional ? 30 : chinese ? 10 : 0;
    if (preference === '中文') return chinese ? 20 : 0;
    if (preference === '英文') return /^(eng|en)/.test(lang) ? 20 : 0;
    if (preference === '日文') return /^(jpn|ja)/.test(lang) ? 20 : 0;
    return 0;
  };
  return tracks.reduce<T | undefined>((best, track) => score(track) > (best ? score(best) : 0) ? track : best, undefined);
}
