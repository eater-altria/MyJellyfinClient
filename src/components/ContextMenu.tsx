import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type MouseEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { create } from 'zustand';
import LiquidGlass from './LiquidGlass';

export type ContextMenuAction = { label: string; icon: ReactNode; danger?: boolean; run: (target: HTMLElement) => void | Promise<void> };
let nextMenuId = 0;
type Menu = { id: number; x: number; y: number; target: HTMLElement; actions: ContextMenuAction[] };
const useMenu = create<{ menu: Menu | null; set: (menu: Menu | null) => void }>(set => ({ menu: null, set: menu => set({ menu }) }));

/** Native context-key and pointer entry points share the same menu and focus behavior. */
export function contextMenuProps(actions: ContextMenuAction[]) {
  const open = (target: HTMLElement, x: number, y: number) => useMenu.getState().set({
    target: target.matches('button') ? target : target.querySelector<HTMLButtonElement>('button') ?? target,
    id: ++nextMenuId, x, y, actions,
  });
  return {
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault(); event.stopPropagation();
      const bounds = event.currentTarget.getBoundingClientRect();
      open(event.currentTarget, event.clientX || bounds.left + 12, event.clientY || bounds.top + 12);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault(); event.stopPropagation();
      const bounds = event.currentTarget.getBoundingClientRect();
      open(event.currentTarget, bounds.left + 12, bounds.top + 12);
    },
  };
}

export default function ContextMenuHost() {
  const menu = useMenu(state => state.menu);
  const location = useLocation();
  useEffect(() => {
    const suppress = (event: Event) => event.preventDefault();
    document.addEventListener('contextmenu', suppress);
    return () => document.removeEventListener('contextmenu', suppress);
  }, []);
  useEffect(() => { useMenu.getState().set(null); }, [location]);
  return menu ? <ContextMenu key={menu.id} menu={menu} /> : null;
}

function ContextMenu({ menu }: { menu: Menu }) {
  const panel = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [point, setPoint] = useState({ x: menu.x, y: menu.y });
  const close = (restore = false) => {
    if (useMenu.getState().menu !== menu) return;
    useMenu.getState().set(null);
    if (restore && menu.target.isConnected) menu.target.focus();
  };
  useLayoutEffect(() => {
    const bounds = panel.current!.getBoundingClientRect();
    setPoint({ x: Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8)), y: Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8)) });
    panel.current!.querySelector<HTMLButtonElement>('button')?.focus();
  }, [menu, error]);
  useEffect(() => {
    mounted.current = true;
    const outside = (event: Event) => { if (!panel.current?.contains(event.target as Node)) close(); };
    const dismiss = () => close();
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) close(); };
    const observer = new MutationObserver(() => { if (!menu.target.isConnected || !menu.target.getClientRects().length) close(); });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', dismiss); window.addEventListener('blur', dismiss);
    return () => {
      mounted.current = false; observer.disconnect();
      document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss);
    };
  }, [menu]);
  return createPortal(
    <div ref={panel} role="menu" aria-label="快捷操作" className="fixed z-[100] w-[208px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-[18px] shadow-card-hover" style={{ left: point.x, top: point.y, maxHeight: 'calc(100vh - 16px)' }}
      onKeyDown={event => {
        if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(true); return; }
        const buttons = [...panel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}>
      <LiquidGlass className="rounded-[18px] p-1.5">
      {menu.actions.map(action => <button key={action.label} type="button" role="menuitem" disabled={busy}
        className={`flex min-h-10 w-full items-center gap-3 rounded-xl px-3 text-left text-[13px] transition-colors hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 ${action.danger ? 'text-red-600' : 'text-text-primary'}`}
        onClick={async () => {
          if (pending.current) return;
          pending.current = true; setBusy(true); setError('');
          try { await action.run(menu.target); close(true); }
          catch { if (mounted.current) setError('操作失败，请重试'); }
          finally { pending.current = false; if (mounted.current) setBusy(false); }
        }}>{action.icon}<span>{action.label}</span></button>)}
      {busy && <p role="status" className="px-3 py-2 text-xs text-text-secondary">正在保存…</p>}
      {error && <p role="alert" className="px-3 py-2 text-xs text-red-600">{error}</p>}
      </LiquidGlass>
    </div>, document.body,
  );
}
