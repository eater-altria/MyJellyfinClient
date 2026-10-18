import { useEffect, useRef, useState } from 'react';
import { useBrowseActivity } from '../hooks/useBrowseActivity';
import { getDeviceId } from '../api/connectors/mediaBrowserAuth';
import { useServers, type SavedServer } from '../store/servers';
import { createServerSnapshot, decryptServerSnapshot, encryptServerSnapshot, planServerImport, type ServerSnapshot } from '../sync/serverSync';
import { requireStrongEtag, webDavFileUrl, webDavRequest, WEBDAV_FILE, type WebDavCredentials } from '../platform/webdav';
import { isTauri } from '../platform/window';

const STORAGE_KEY = 'mjc:webdav';
function preferences(): Pick<WebDavCredentials, 'directory' | 'username'> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { directory: typeof value.directory === 'string' ? value.directory.slice(0, 8192) : '',
      username: typeof value.username === 'string' ? value.username.slice(0, 1024) : '' };
  } catch { return { directory: '', username: '' }; }
}

type Pending = { local: readonly SavedServer[]; snapshot: ServerSnapshot } & (
  { kind: 'download'; added: number; updated: number; retained: number }
  | { kind: 'upload'; body: string; etag: string | null; remoteCount: number }
);

/** Explicit transfers: opening settings never contacts WebDAV or uploads a token. */
export default function ServerSync() {
  const active = useBrowseActivity();
  const [saved] = useState(preferences);
  const [directory, setDirectory] = useState(saved.directory);
  const [username, setUsername] = useState(saved.username);
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const serverCount = useServers(state => state.servers.length);
  const credentials = { directory, username, password };

  const cancel = () => {
    request.current?.abort(); request.current = null;
    setBusy(false); setPending(null);
  };
  useEffect(() => {
    if (active) return;
    cancel(); setPassword(''); setPassphrase(''); setMessage(''); setError('');
  }, [active]);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);

  const run = async (action: (controller: AbortController) => Promise<void>) => {
    if (!active || request.current) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(''); setMessage('');
    try { await action(controller); }
    catch (reason) {
      if (request.current === controller && !controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : '配置同步失败，请重试');
        setPending(null);
      }
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  };

  const prepare = (kind: 'upload' | 'download') => run(async controller => {
    webDavFileUrl(directory);
    if (passphrase.length < 10 || passphrase.length > 1024 || !passphrase.trim()) throw new Error('加密口令须为 10–1024 个字符');
    // Only the directory and account name persist. Secrets are cleared on leaving this view.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ directory: directory.trim(), username })); } catch { /* transfer can still proceed */ }
    const local = useServers.getState().servers;
    const localSnapshot = kind === 'upload' ? createServerSnapshot(local, getDeviceId()) : undefined;
    const remote = await webDavRequest(credentials, controller.signal);
    const remoteSnapshot = remote.status === 404 ? null : await decryptServerSnapshot(remote.body, passphrase);
    if (controller.signal.aborted || request.current !== controller) return;
    if (kind === 'download') {
      if (!remoteSnapshot) throw new Error('云端还没有配置，请先在已登录的设备上传');
      const { added, updated, retained } = planServerImport(local, remoteSnapshot.servers);
      setPending({ kind, local, snapshot: remoteSnapshot, added, updated, retained });
    } else {
      const etag = remoteSnapshot ? requireStrongEtag(remote.etag) : null;
      const body = await encryptServerSnapshot(localSnapshot!, passphrase);
      if (controller.signal.aborted || request.current !== controller) return;
      setPending({ kind, local, snapshot: localSnapshot!, body, etag, remoteCount: remoteSnapshot?.servers.length ?? 0 });
    }
  });

  const confirm = () => {
    if (!pending) return;
    if (pending.kind === 'download') {
      try {
        useServers.getState().importServers(pending.snapshot.servers, pending.local);
        setMessage(`已合并 ${pending.snapshot.servers.length} 个连接，可直接进入服务器播放，无需再次登录。`);
      } catch (reason) { setError(reason instanceof Error ? reason.message : '合并失败，请重试'); }
      setPending(null);
    } else {
      void run(async controller => {
        if (useServers.getState().servers !== pending.local) throw new Error('本地服务器配置已改变，请重新准备上传');
        await webDavRequest(credentials, controller.signal, { body: pending.body, etag: pending.etag });
        if (controller.signal.aborted || request.current !== controller) return;
        setPending(null);
        setMessage(`已加密上传 ${pending.snapshot.servers.length} 个连接。在另一台设备下载并合并即可免登录使用。`);
      });
    }
  };

  const inputClass = 'glass-input w-full min-w-0 rounded-2xl px-3 py-2 text-[13px] no-drag disabled:opacity-50';
  return <section className="mb-7" aria-labelledby="server-sync-title">
    <h3 id="server-sync-title" className="mb-2.5 px-5 text-[12px] font-medium text-text-secondary">WebDAV 服务器同步</h3>
    <div className="glass-surface space-y-4 px-5 py-5">
      <p className="text-[13px] leading-relaxed text-text-secondary">
        将服务器列表和登录信息加密同步到自己的其他设备，下载合并后可直接播放。当前设备有 {serverCount} 个连接。
      </p>
      <fieldset disabled={busy || !!pending} className="min-w-0 space-y-3">
        <label className="block text-[13px]">WebDAV 目录地址
          <input aria-label="WebDAV 目录地址" type="url" value={directory} maxLength={8192} autoComplete="off" spellCheck={false}
            placeholder="https://cloud.example.com/dav/已有目录/" className={`${inputClass} mt-1.5`} onChange={event => setDirectory(event.target.value)} />
        </label>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="block min-w-0 text-[13px]">WebDAV 账号
            <input aria-label="WebDAV 账号" value={username} maxLength={1024} autoComplete="off" spellCheck={false}
              className={`${inputClass} mt-1.5`} onChange={event => setUsername(event.target.value)} />
          </label>
          <label className="block min-w-0 text-[13px]">WebDAV 密码或应用密码
            <input aria-label="WebDAV 密码" type="password" value={password} maxLength={8192} autoComplete="off"
              className={`${inputClass} mt-1.5`} onChange={event => setPassword(event.target.value)} />
          </label>
        </div>
        <label className="block text-[13px]">配置加密口令
          <input aria-label="配置加密口令" type="password" value={passphrase} minLength={10} maxLength={1024} autoComplete="new-password"
            placeholder="至少 10 个字符，各设备填写同一口令" className={`${inputClass} mt-1.5`} onChange={event => setPassphrase(event.target.value)} />
        </label>
      </fieldset>
      <p className="break-words text-[12px] leading-relaxed text-text-secondary">
        请填写已存在的 WebDAV 目录，内网 IP 和本机地址可使用 HTTP，公网地址使用 HTTPS。文件名：{WEBDAV_FILE}。仅记住目录和账号；离开本设置后清除密码及加密口令，口令无法找回。
        各设备会共用导出连接的令牌和设备 ID；服务器撤销该登录后，需要重新登录并上传。
        {!isTauri && ' 网页版还需要 WebDAV 允许跨域请求并暴露 ETag 响应头。'}
      </p>
      {!pending && <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || !serverCount} onClick={() => void prepare('upload')}
          className="glass-button px-4 py-2 text-[13px] disabled:opacity-50">上传本机配置</button>
        <button type="button" disabled={busy} onClick={() => void prepare('download')}
          className="glass-button px-4 py-2 text-[13px] disabled:opacity-50">下载云端配置</button>
      </div>}
      {pending && <div className="rounded-2xl bg-white/50 p-4" role="region" aria-label="同步确认">
        <p className="text-[13px] leading-relaxed">{pending.kind === 'download'
          ? `将新增 ${pending.added} 个、更新 ${pending.updated} 个连接及其登录信息，保留本机独有的 ${pending.retained} 个连接，并采用云端排列顺序。`
          : `将用本机的 ${pending.snapshot.servers.length} 个连接${pending.etag ? `替换云端的 ${pending.remoteCount} 个连接` : '创建云端配置'}。其他设备不受影响，直到它们再次下载。`}</p>
        <ul className="my-3 max-h-40 overflow-y-auto text-[12px] text-text-secondary">
          {pending.snapshot.servers.map(server => <li key={server.id} className="break-words py-1">{server.name}{server.userName ? ` · ${server.userName}` : ''}</li>)}
        </ul>
        <button type="button" disabled={busy} onClick={confirm} className="glass-button px-4 py-2 text-[13px] text-accent disabled:opacity-50">
          {pending.kind === 'download' ? '确认合并并恢复登录' : '确认加密上传'}
        </button>
      </div>}
      {(busy || pending) && <button type="button" onClick={cancel} className="glass-button px-4 py-2 text-[13px]">取消</button>}
      <div role="status" aria-live="polite" aria-busy={busy} className="text-[13px] leading-relaxed">
        {busy && <p>正在处理配置…</p>}
        {message && <p>{message}</p>}
        {error && <p className="text-red-600">{error}</p>}
      </div>
    </div>
  </section>;
}
