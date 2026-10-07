import { useEffect, useState } from 'react';
import { IconFolder } from '../components/icons';
import LiquidGlass from '../components/LiquidGlass';

export default function Files() {
  const [toast, setToast] = useState(false);
  const [seg, setSeg] = useState<'local' | 'network'>('local');

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(false), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className="relative flex h-full flex-col overflow-y-auto px-4 pb-8 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-4 pt-8">
        <div>
          <h1 className="page-heading">文件</h1>
          <p className="page-subtitle mt-2">本地媒体与网络链接</p>
        </div>
        <div className="seg-control" aria-label="文件来源">
          <button aria-pressed={seg === 'local'} className={seg === 'local' ? 'active' : ''} onClick={() => setSeg('local')}>
            本地文件
          </button>
          <button
            aria-pressed={seg === 'network'}
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

      <div className="flex min-h-[420px] flex-1 items-center justify-center py-8">
        <LiquidGlass intensity="subtle" className="flex w-full max-w-[420px] flex-col items-center gap-5 px-7 py-10 text-center">
          <div className="glass-surface flex h-20 w-20 items-center justify-center text-accent">
            <IconFolder size={38} />
          </div>
          <div>
            <span className="glass-badge text-[11px]">即将推出</span>
            <h2 className="mt-4 text-[21px] font-semibold tracking-tight text-text-primary">{seg === 'local' ? '你的本地放映室' : '用链接发现更多内容'}</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">{seg === 'local' ? '本地文件与文件夹播放将在后续版本提供。现在可以连接服务器，开始观看。' : '网络链接播放将在后续版本提供。'}</p>
          </div>
          <div className="flex w-full flex-wrap items-center justify-center gap-3 pt-1">
          <button
            className="glass-button-primary px-6 py-2.5 text-[13px]"
            onClick={() => setToast(true)}
          >
            打开文件
          </button>
          <button
            className="glass-button px-6 py-2.5 text-[13px]"
            onClick={() => setToast(true)}
          >
            挂载文件夹
          </button>
          </div>
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
