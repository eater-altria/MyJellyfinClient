export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 text-gray-400">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-gray-300 border-t-accent" />
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
    <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-4">
      {icon && <div className="text-gray-300">{icon}</div>}
      <div className="text-[15px] font-medium text-gray-500">{title}</div>
      {hint && <div className="max-w-sm text-center text-[12px] text-gray-400">{hint}</div>}
      {children}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-3">
      <div className="text-[14px] text-red-500">加载失败</div>
      <div className="max-w-md text-center text-[12px] text-gray-400">{message}</div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-1 rounded-lg bg-accent px-4 py-1.5 text-[13px] text-white hover:opacity-90"
        >
          重试
        </button>
      )}
    </div>
  );
}
