import { useEffect, useId, useRef, useState } from 'react';
import { useBrowseActivity } from '../hooks/useBrowseActivity';
import { useServers, ServerRegistrationError, type SavedServer } from '../store/servers';
import { ApiError, serverProtocolName, type ServerProtocol } from '../api/mediaServer';
import { IconClose, IconJellyfin, IconEmby } from './icons';
import { ServerDetectionError } from '../api/detectServer';
import LiquidGlass from './LiquidGlass';
import { getClientIdentity } from '../store/settings';

function errorMessage(e: unknown): string {
  if (e instanceof ServerDetectionError) return e.message;
  if (e instanceof ServerRegistrationError) return e.message;
  if (e instanceof ApiError) {
    if (e.status === 401) return '用户名或密码错误';
    if (e.status === 404) return '服务器地址无效，请检查后重试';
    return `服务器返回错误 (${e.status})`;
  }
  return '无法连接服务器，请检查地址和网络';
}

/** Modal dialog for adding or editing a Jellyfin / Emby server. */
export default function AddServerDialog({ onClose, server }: { onClose: () => void; server?: SavedServer }) {
  const active = useBrowseActivity();
  const addServer = useServers((s) => s.addServer);
  const updateServer = useServers((s) => s.updateServer);
  const [name, setName] = useState(server?.name ?? '');
  const [address, setAddress] = useState(server?.address ?? '');
  const [username, setUsername] = useState(server?.userName ?? '');
  const [password, setPassword] = useState('');
  const [registerNewDevice, setRegisterNewDevice] = useState(false);
  const [clientName, setClientName] = useState(server?.clientName ?? getClientIdentity('emby').name);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const formId = useId();
  const [previousFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => previousFocus?.focus();
  }, [previousFocus]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!active) return;
      if (event.key === 'Escape' && !loading) {
        event.preventDefault();
        onClose();
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [loading, onClose, active]);

  const canSubmit = address.trim() !== '' && username.trim() !== '' && !loading;

  const submit = async () => {
    if (!canSubmit) return;
    setLoading(true);
    setError('');
    setConnectionStatus('正在自动识别服务器…');
    const onDetected = (protocol: ServerProtocol) => setConnectionStatus(`已识别 ${serverProtocolName(protocol)}，正在登录…`);
    try {
      if (server) await updateServer(server.id, { name, address: address.trim(), username: username.trim(),
        password: registerNewDevice ? password : password || undefined, onDetected,
        registerNewDevice: registerNewDevice ? { clientName } : undefined });
      else await addServer(address.trim(), username.trim(), password, name, onDetected);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setLoading(false);
    }
  };

  const inputCls =
    'glass-input w-full rounded-2xl px-4 py-3 text-[13px] text-text-primary';

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/20 p-4 backdrop-blur-md"
      onClick={() => { if (!loading) onClose(); }}
    >
      <LiquidGlass
        intensity="regular"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${formId}-title`}
        className="w-full max-w-[420px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="max-h-[calc(100dvh-32px)] overflow-y-auto p-7">
        <div className="mb-6 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {server?.protocol === 'emby' ? <IconEmby size={36} /> : <IconJellyfin size={36} />}
            <div className="min-w-0">
              <h2 id={`${formId}-title`} className="text-[20px] font-semibold tracking-tight text-text-primary">{server ? '编辑服务器' : '添加服务器'}</h2>
              <p className="mt-1 text-[12px] text-text-secondary">连接你的 Jellyfin 或 Emby 媒体库</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={loading}
            aria-label="关闭"
            className="glass-icon-button shrink-0 p-2 text-text-secondary"
          >
            <IconClose size={16} />
          </button>
        </div>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div>
            <label htmlFor={`${formId}-name`} className="mb-1.5 block px-1 text-[12px] font-medium text-text-secondary">服务器名称</label>
            <input id={`${formId}-name`} className={inputCls} placeholder="自定义显示名称（可留空）" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label htmlFor={`${formId}-address`} className="mb-1.5 block px-1 text-[12px] font-medium text-text-secondary">服务器地址</label>
            <input
              id={`${formId}-address`}
              className={inputCls}
              placeholder="http://192.168.1.10:8096"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={`${formId}-username`} className="mb-1.5 block px-1 text-[12px] font-medium text-text-secondary">用户名</label>
            <input
              id={`${formId}-username`}
              autoComplete="username"
              className={inputCls}
              placeholder="服务器用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={`${formId}-password`} className="mb-1.5 block px-1 text-[12px] font-medium text-text-secondary">密码</label>
            <input
              id={`${formId}-password`}
              autoComplete="current-password"
              className={inputCls}
              type="password"
              placeholder={registerNewDevice ? '重新登录的密码；无密码账号可留空' : server ? '留空保留登录；更换地址或用户需重新认证' : '密码（可留空）'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {server?.protocol === 'emby' && (
            <div className="rounded-2xl bg-white/30 p-3">
              <label className="flex items-center gap-2 text-[12px] font-medium text-text-primary">
                <input type="checkbox" disabled={loading} checked={registerNewDevice} onChange={e => setRegisterNewDevice(e.target.checked)} />
                重新登记此服务器的登录设备
              </label>
              <p className="mt-1.5 text-[12px] leading-relaxed text-text-secondary">
                {registerNewDevice ? '需要重新登录。新设备仅用于此服务器，保存后保持固定。' : '适用于登录正常、播放被服务器限制的连接。'}
              </p>
              {registerNewDevice && (
                <div className="mt-3">
                  <label htmlFor={`${formId}-client`} className="mb-1.5 block text-[12px] font-medium text-text-secondary">此服务器的客户端名称</label>
                  <input id={`${formId}-client`} disabled={loading} className={inputCls} value={clientName} onChange={e => setClientName(e.target.value)} placeholder="服务器支持的客户端名称" />
                </div>
              )}
              {!registerNewDevice && server.clientName && <p className="mt-1 text-[12px] text-text-secondary">此连接使用客户端名称：{server.clientName}</p>}
            </div>
          )}

          <p className="px-1 text-[12px] leading-relaxed text-text-secondary" role="status">{loading ? connectionStatus : '自动识别 Jellyfin / Emby，无需选择服务器类型'}</p>

          {error && (
            <div role="alert" className="rounded-2xl bg-red-500/10 px-4 py-3 text-[12px] text-red-600">{error}</div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="glass-button-primary mt-1 flex h-11 items-center justify-center text-[13px] font-medium"
          >
            {loading ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            ) : (
              server ? '保存' : '连接'
            )}
          </button>
        </form>
        </div>
      </LiquidGlass>
    </div>
  );
}
