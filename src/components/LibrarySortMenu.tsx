import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { LIBRARY_SORT_OPTIONS, type LibrarySort } from '../utils/librarySort';
import { IconArrowDown, IconArrowUp, IconClose, IconSort } from './icons';
import LiquidGlass from './LiquidGlass';
import { useBrowseActivity } from '../hooks/useBrowseActivity';

export default function LibrarySortMenu({ value, onChange }: {
  value: LibrarySort;
  onChange: (value: LibrarySort) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = useBrowseActivity();
  const [position, setPosition] = useState<CSSProperties>({ position: 'fixed' });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const option = LIBRARY_SORT_OPTIONS.find(item => item.key === value.key) ?? LIBRARY_SORT_OPTIONS[0];
  const direction = value.order === 'Ascending' ? '升序' : '降序';

  useEffect(() => {
    if (!active || !open) return;
    const place = () => {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds) return;
      const width = Math.min(288, window.innerWidth - 24);
      const below = window.innerHeight - bounds.bottom - 20;
      const above = bounds.top - 20;
      const down = below >= Math.min(440, above);
      setPosition({
        position: 'fixed', width,
        left: Math.max(12, Math.min(bounds.right - width, window.innerWidth - width - 12)),
        ...(down ? { top: bounds.bottom + 8 } : { bottom: window.innerHeight - bounds.top + 8 }),
        maxHeight: Math.max(0, down ? below : above),
      });
    };
    const outside = (event: Event) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    place();
    panel.current?.querySelector<HTMLInputElement>('input:checked')?.focus();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, active]);

  const close = () => { setOpen(false); trigger.current?.focus(); };
  const radioClass = 'flex min-h-9 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-[13px] text-text-primary hover:bg-white/60 has-[:checked]:bg-accent-soft';

  return (
    <>
      <button ref={trigger} type="button" className="glass-button shrink-0"
        aria-label={`排序方式：${option.label}，${direction}`} aria-haspopup="dialog"
        aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen(previous => !previous)}>
        <IconSort size={16} aria-hidden="true" />
        <span>{option.label}</span>
        {value.order === 'Ascending' ? <IconArrowUp size={16} aria-hidden="true" /> : <IconArrowDown size={16} aria-hidden="true" />}
        <span className="sr-only">{direction}</span>
      </button>
      {active && open && createPortal(
        <div ref={panel} style={position} className="z-50">
          <LiquidGlass id={id} role="dialog" aria-labelledby={`${id}-title`} className="rounded-[24px]">
            <div className="overflow-y-auto p-3" style={{ maxHeight: position.maxHeight }}>
              <div className="mb-2 flex items-center justify-between gap-3 px-3">
                <h2 id={`${id}-title`} className="text-[14px] font-medium text-text-primary">排序</h2>
                <button type="button" className="glass-icon-button" aria-label="关闭排序菜单" onClick={close}>
                  <IconClose size={14} />
                </button>
              </div>
              <fieldset>
                <legend className="mb-1 px-3 text-[12px] text-text-secondary">排序方式</legend>
                {LIBRARY_SORT_OPTIONS.map(item => (
                  <label key={item.key} className={radioClass}>
                    <input type="radio" name={`${id}-field`} value={item.key} checked={value.key === item.key}
                      className="h-3.5 w-3.5 shrink-0 accent-accent"
                      onChange={() => onChange({ ...value, key: item.key })} />
                    {item.label}
                  </label>
                ))}
              </fieldset>
              <fieldset className="mt-2 border-t border-slate-400/15 pt-3">
                <legend className="sr-only">排序方向</legend>
                {(['Ascending', 'Descending'] as const).map(order => (
                  <label key={order} className={radioClass}>
                    <input type="radio" name={`${id}-direction`} value={order} checked={value.order === order}
                      className="h-3.5 w-3.5 shrink-0 accent-accent"
                      onChange={() => onChange({ ...value, order })} />
                    <span>{order === 'Ascending' ? '升序' : '降序'}<span className="ml-2 text-[12px] text-text-secondary">
                      {order === 'Ascending' ? option.ascending : option.descending}
                    </span></span>
                  </label>
                ))}
              </fieldset>
              <p className="mt-2 px-3 text-[11px] text-text-secondary">自动记住此媒体库的排序</p>
            </div>
          </LiquidGlass>
        </div>, document.body,
      )}
    </>
  );
}
