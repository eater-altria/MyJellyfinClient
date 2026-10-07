export function Spinner({ label }: { label?: string }) {
  return (
    <div role="status" className="flex h-full min-h-[200px] flex-col items-center justify-center gap-4 text-text-secondary">
      <div className="glass-surface flex h-14 w-14 items-center justify-center !rounded-full">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/20 border-t-accent" />
      </div>
      {label && <div className="text-[13px]">{label}</div>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-[340px] flex-col items-center justify-center gap-4 px-5 py-10 text-center">
      {icon && <div className="glass-surface mb-2 flex h-24 w-24 items-center justify-center text-accent/75">{icon}</div>}
      <div className="text-[18px] font-semibold tracking-tight text-text-primary">{title}</div>
      {hint && <div className="max-w-sm text-[13px] leading-relaxed text-text-secondary">{hint}</div>}
      {children}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex h-full min-h-[300px] items-center justify-center px-4 py-8">
      <div role="alert" className="glass-surface flex w-full max-w-md flex-col items-center gap-3 px-7 py-8 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/10 text-[22px] font-medium text-red-600" aria-hidden="true">!</div>
        <div className="text-[16px] font-semibold text-text-primary">加载失败</div>
        <div className="max-w-full break-words text-[13px] leading-relaxed text-text-secondary">{message}</div>
        {onRetry && (
          <button onClick={onRetry} className="glass-button-primary mt-2 px-5 py-2 text-[13px]">
            重试
          </button>
        )}
      </div>
    </div>
  );
}
