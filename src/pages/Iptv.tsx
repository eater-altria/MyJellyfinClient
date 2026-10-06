import { useEffect, useState } from 'react';
import { IconTv } from '../components/icons';

export default function Iptv() {
  const [toast, setToast] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(false), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className="relative h-full bg-page-bg">
      {/* empty state */}
      <div className="flex h-full flex-col items-center justify-center gap-5">
        <div className="flex h-24 w-24 items-center justify-center rounded-3xl bg-gradient-to-br from-purple-200 to-pink-300">
          <IconTv size={44} className="text-white" />
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <div className="text-[15px] font-medium text-gray-600">IPTV</div>
          <div className="text-[12px] text-gray-400">添加 M3U 播放列表以观看直播电视</div>
        </div>
        <button
          className="rounded-full bg-white px-8 py-2.5 text-[13px] shadow-card hover:shadow-card-hover"
          onClick={() => setToast(true)}
        >
          添加播放列表
        </button>
      </div>

      {/* toast */}
      {toast && (
        <div className="fade-in absolute bottom-8 left-1/2 -translate-x-1/2 rounded-full bg-black/75 px-4 py-2 text-xs text-white">
          该功能将在后续版本提供
        </div>
      )}
    </div>
  );
}
