import { useEffect, useState } from 'react';
import { IconTv } from '../components/icons';
import LiquidGlass from '../components/LiquidGlass';

export default function Iptv() {
  const [toast, setToast] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(false), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className="relative flex h-full flex-col overflow-y-auto px-4 pb-8 sm:px-8">
      <div className="pt-8">
        <h1 className="page-heading">IPTV</h1>
        <p className="page-subtitle mt-2">为直播留一个位置</p>
      </div>
      <div className="flex min-h-[420px] flex-1 items-center justify-center py-8">
        <LiquidGlass intensity="subtle" className="flex w-full max-w-[420px] flex-col items-center gap-5 px-7 py-10 text-center">
          <div className="glass-surface flex h-20 w-20 items-center justify-center text-violet-500">
            <IconTv size={38} />
          </div>
          <div>
            <span className="glass-badge text-[11px]">即将推出</span>
            <h2 className="mt-4 text-[21px] font-semibold tracking-tight text-text-primary">精彩，正在路上</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">M3U 播放列表与直播电视将在后续版本提供。</p>
          </div>
          <button
            className="glass-button px-6 py-2.5 text-[13px]"
            onClick={() => setToast(true)}
          >
            添加播放列表
          </button>
        </LiquidGlass>
      </div>

      {/* toast */}
      {toast && (
        <div role="status" className="glass-toolbar fade-in absolute bottom-6 left-1/2 z-20 max-w-[calc(100%-32px)] -translate-x-1/2 whitespace-nowrap px-5 py-3 text-[12px] text-text-primary">
          该功能将在后续版本提供
        </div>
      )}
    </div>
  );
}
