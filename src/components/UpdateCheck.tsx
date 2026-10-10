import { useEffect, useRef, useState } from 'react';
import { checkForAppUpdate, RELEASES_PAGE_URL, type UpdateCheckResult } from '../api/appUpdates';
import { currentAppVersion, openProjectReleases } from '../platform/appUpdates';
import { isTauri } from '../platform/window';

export default function UpdateCheck() {
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    currentAppVersion().then(value => { if (active) setVersion(value); })
      .catch(() => { if (active) setError('无法读取当前版本，请重新打开设置后重试。'); });
    return () => { active = false; request.current?.abort(); request.current = null; };
  }, []);

  const check = async () => {
    if (!version || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setChecking(true); setResult(null); setError('');
    try {
      const next = await checkForAppUpdate(version, controller.signal);
      if (request.current === controller) setResult(next);
    } catch (reason) {
      if (request.current === controller && !controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : '检查更新失败，请稍后重试。');
      }
    } finally {
      if (request.current === controller) { request.current = null; setChecking(false); }
    }
  };

  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-[13px] text-text-primary">
          MyJellyfinClient
          <p className="mt-1 text-[12px] text-text-secondary">当前版本：{version ?? '读取中…'}</p>
        </div>
        <button type="button" onClick={check} disabled={checking || !version}
          className="glass-button px-4 py-2 text-[13px] disabled:cursor-not-allowed disabled:opacity-50">
          {checking ? '正在检查…' : '检查更新'}
        </button>
      </div>
      <div role="status" aria-live="polite" aria-busy={checking} className="text-[13px] leading-relaxed">
        {result && <p className="mt-3 text-text-primary">
          {result.status === 'available' ? `发现新版本 ${result.version}，可前往发布页下载更新。`
            : result.status === 'current' ? `当前无需更新（最新正式 Release：${result.version}）。`
              : '暂未找到已发布的正式 Release。'}
        </p>}
        {error && <p className="mt-3 text-red-600">{error}</p>}
      </div>
      {(result?.status === 'available' || error) && <a href={RELEASES_PAGE_URL} target="_blank" rel="noopener noreferrer"
        onClick={event => {
          if (!isTauri) return;
          event.preventDefault();
          openProjectReleases().catch(() => setError('无法打开浏览器，请手动访问 github.com/eater-altria/MyJellyfinClient/releases。'));
        }}
        className="glass-button mt-3 inline-flex max-w-full px-4 py-2 text-[13px] text-accent">
        前往 GitHub Release
      </a>}
    </div>
  );
}
