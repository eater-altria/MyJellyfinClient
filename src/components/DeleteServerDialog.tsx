import { useEffect, useId, useRef } from 'react';
import LiquidGlass from './LiquidGlass';

/** Use an in-app modal: WKWebView does not provide window.confirm UI. */
export default function DeleteServerDialog({ name, returnFocus, onClose, onConfirm }: {
  name: string;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      dialog.close();
      if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus();
    };
  }, [returnFocus]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      className="m-0 h-full max-h-none w-full max-w-none border-0 bg-slate-900/20 p-4 text-text-primary backdrop-blur-md backdrop:bg-transparent open:flex open:items-center open:justify-center"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key !== 'Tab') return;
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button');
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <LiquidGlass className="max-h-[calc(100dvh-32px)] w-full max-w-[420px] overflow-y-auto p-7">
        <h2 id={`${id}-title`} className="text-[20px] font-semibold tracking-tight">删除服务器？</h2>
        <p id={`${id}-description`} className="mt-3 break-words text-[13px] leading-relaxed text-text-secondary">
          将从此客户端移除「{name}」及其登录信息，不会删除服务器上的媒体。
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button ref={cancelRef} type="button" onClick={onClose} className="glass-button px-5 py-2.5 text-[13px]">取消</button>
          <button type="button" onClick={onConfirm} className="glass-button px-5 py-2.5 text-[13px] text-red-600">删除</button>
        </div>
      </LiquidGlass>
    </dialog>
  );
}
