import { useEffect, useState } from 'react';
import { IconFolder } from '../components/icons';

export default function Files() {
  const [toast, setToast] = useState(false);
  const [seg, setSeg] = useState<'local' | 'network'>('local');

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(false), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className="relative h-full bg-page-bg">
      {/* top-center segmented control */}
      <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2">
        <div className="seg-control">
          <button className={seg === 'local' ? 'active' : ''} onClick={() => setSeg('local')}>
            本地文件
          </button>
          <button
            className={seg === 'network' ? 'active' : ''}
            onClick={() => {
              setSeg('network');
              setToast(true);
            }}
          >
            网络链接
          </button>
        </div>
      </div>

      {/* empty state */}
      <div className="flex h-full flex-col items-center justify-center gap-5">
        <div className="flex h-24 w-24 items-center justify-center rounded-3xl bg-gradient-to-br from-sky-200 to-blue-300">
          <IconFolder size={44} className="text-white" />
        </div>
        <div className="flex flex-col items-center gap-2.5">
          <button
            className="rounded-full bg-white px-8 py-2.5 text-[13px] shadow-card hover:shadow-card-hover"
            onClick={() => setToast(true)}
          >
            打开文件
          </button>
          <button
            className="rounded-full bg-white px-8 py-2.5 text-[13px] shadow-card hover:shadow-card-hover"
            onClick={() => setToast(true)}
          >
            挂载文件夹
          </button>
        </div>
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
