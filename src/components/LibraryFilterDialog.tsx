import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LibraryFilterOptions } from '../api/mediaServer';
import { EMPTY_LIBRARY_FILTERS, type LibraryFilters } from '../utils/libraryFilters';
import LiquidGlass from './LiquidGlass';
import { IconClose } from './icons';

export default function LibraryFilterDialog({ value, options, loading, error, onRetry, onApply, onClose }: {
  value: LibraryFilters; options: LibraryFilterOptions | null; loading: boolean; error: string;
  onRetry: () => void; onApply: (filters: LibraryFilters) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [search, setSearch] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key !== 'Tab') return;
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]') ?? [])];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); };
  }, [onClose]);
  const group = (field: 'genres' | 'tags', label: string, values: string[]) => <fieldset className="mt-5">
    <legend className="text-[13px] font-medium">{label}</legend>
    <div className="mt-2 flex flex-wrap gap-2">{[...new Set([...draft[field], ...values])]
      .filter(name => name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(name => (
        <label key={name} className={`flex max-w-full cursor-pointer items-center gap-2 rounded-2xl border px-3 py-2 text-[12px] ${draft[field].includes(name) ? 'border-accent/30 bg-accent-soft text-accent' : 'border-slate-300/30 bg-white/40'}`}>
          <input type="checkbox" checked={draft[field].includes(name)} className="shrink-0 accent-accent" onChange={() => setDraft(current => ({ ...current,
            [field]: current[field].includes(name) ? current[field].filter(entry => entry !== name) : [...current[field], name] }))} />
          <span className="min-w-0 break-words">{name}</span>
        </label>
      ))}</div>
    {!values.length && !loading && !error && <p className="mt-2 text-[12px] text-text-secondary">服务器没有提供{label}选项</p>}
  </fieldset>;
  return createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/20 p-3 backdrop-blur-sm"
    onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-label="筛选媒体" className="flex max-h-[85vh] w-full min-w-0 max-w-[680px]">
      <LiquidGlass className="flex min-h-0 w-full flex-col overflow-hidden rounded-[28px]" intensity="prominent">
        <div className="flex shrink-0 items-center justify-between px-5 py-4"><h2 className="text-[17px] font-semibold">筛选媒体</h2>
          <button type="button" aria-label="关闭筛选" className="glass-icon-button h-9 w-9" onClick={onClose}><IconClose size={18} /></button></div>
        <div className="min-h-0 overflow-y-auto px-5 pb-5">
          <p className="text-[12px] text-text-secondary">同一组选项满足其一即可；不同筛选组同时生效。</p>
          <label className="mt-4 flex items-center gap-2 text-[13px]"><input type="checkbox" checked={draft.favoritesOnly} className="accent-accent"
            onChange={event => setDraft(current => ({ ...current, favoritesOnly: event.target.checked }))} />仅看收藏</label>
          <input type="search" aria-label="搜索类型或标签" placeholder="搜索类型或标签" value={search} onChange={event => setSearch(event.target.value)} className="glass-input mt-4 w-full px-4 py-2 text-[13px]" />
          {loading && <p role="status" className="mt-3 text-[13px] text-text-secondary">正在加载筛选选项…</p>}
          {error && <div role="alert" className="mt-3 text-[13px] text-red-600">{error}<button type="button" onClick={onRetry} className="glass-button ml-2 px-3 py-1">重试筛选选项</button></div>}
          {group('genres', '类型与风格', options?.genres ?? [])}{group('tags', '标签', options?.tags ?? [])}
          <fieldset className="mt-5"><legend className="text-[13px] font-medium">年份</legend>
            <div className="mt-2 flex flex-wrap gap-2">{[...new Set([...draft.years, ...(options?.years ?? [])])].sort((a, b) => b - a).map(year => (
              <label key={year} className="flex cursor-pointer items-center gap-2 rounded-full bg-white/50 px-3 py-2 text-[12px]">
                <input type="checkbox" checked={draft.years.includes(year)} className="accent-accent" onChange={() => setDraft(current => ({ ...current,
                  years: current.years.includes(year) ? current.years.filter(entry => entry !== year) : [...current.years, year] }))} />{year}
              </label>
            ))}</div>
            {!options?.years.length && !loading && !error && <p className="mt-2 text-[12px] text-text-secondary">服务器没有提供年份选项</p>}
          </fieldset>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-slate-300/20 px-5 py-4">
          <button type="button" onClick={() => { setDraft(EMPTY_LIBRARY_FILTERS); setSearch(''); }} className="glass-button px-4 py-2 text-[13px]">清空筛选</button>
          <button type="button" onClick={() => onApply(draft)} className="glass-button-primary px-4 py-2 text-[13px]">应用筛选</button>
        </div>
      </LiquidGlass>
    </div>
  </div>, document.body);
}
