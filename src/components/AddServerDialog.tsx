import { useState } from 'react';
import { useServers, type SavedServer } from '../store/servers';
import { ApiError, serverProtocolName, type ServerProtocol } from '../api/mediaServer';
import { IconClose, IconJellyfin, IconEmby } from './icons';
import { ServerDetectionError } from '../api/detectServer';

function errorMessage(e: unknown): string {
  if (e instanceof ServerDetectionError) return e.message;
  if (e instanceof ApiError) {
    if (e.status === 401) return '用户名或密码错误';
    if (e.status === 404) return '服务器地址无效，请检查后重试';
    return `服务器返回错误 (${e.status})`;
  }
  return '无法连接服务器，请检查地址和网络';
}

/** Modal dialog for adding or editing a Jellyfin / Emby server (SenPlayer style). */
export default function AddServerDialog({ onClose, server }: { onClose: () => void; server?: SavedServer }) {
  const addServer = useServers((s) => s.addServer);
  const updateServer = useServers((s) => s.updateServer);
  const [name, setName] = useState(server?.name ?? '');
  const [address, setAddress] = useState(server?.address ?? '');
  const [username, setUsername] = useState(server?.userName ?? '');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('');

  const canSubmit = address.trim() !== '' && username.trim() !== '' && !loading;

  const submit = async () => {
    if (!canSubmit) return;
    setLoading(true);
    setError('');
    setConnectionStatus('正在自动识别服务器…');
    const onDetected = (protocol: ServerProtocol) => setConnectionStatus(`已识别 ${serverProtocolName(protocol)}，正在登录…`);
    try {
      if (server) await updateServer(server.id, { name, address: address.trim(), username: username.trim(), password: password || undefined, onDetected });
      else await addServer(address.trim(), username.trim(), password, name, onDetected);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setLoading(false);
    }
  };

  const inputCls =
    'w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[13px] text-text-primary outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onClick={() => { if (!loading) onClose(); }}
    >
      <div
        className="w-[360px] rounded-2xl bg-white p-6 shadow-card-hover"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {server?.protocol === 'emby' ? <IconEmby size={22} /> : <IconJellyfin size={22} />}
            <h2 className="text-[16px] font-semibold text-text-primary">{server ? '编辑服务器' : '添加服务器'}</h2>
          </div>
          <button
            onClick={onClose}
            disabled={loading}
            className="rounded-full p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
          >
            <IconClose size={16} />
          </button>
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div>
            <label className="mb-1 block text-[12px] text-text-secondary">服务器名称</label>
            <input className={inputCls} placeholder="自定义显示名称（可留空）" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="mb-1 block text-[12px] text-text-secondary">服务器地址</label>
            <input
              className={inputCls}
              placeholder="http://192.168.1.10:8096"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] text-text-secondary">用户名</label>
            <input
              className={inputCls}
              placeholder="服务器用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] text-text-secondary">密码</label>
            <input
              className={inputCls}
              type="password"
              placeholder={server ? '留空保留登录；更换地址或用户需重新认证' : '密码（可留空）'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <p className="text-[11px] text-gray-400" role="status">{loading ? connectionStatus : '自动识别 Jellyfin / Emby，无需选择服务器类型'}</p>

          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-500">{error}</div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="mt-1 flex h-9 items-center justify-center rounded-lg bg-accent text-[13px] font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            ) : (
              server ? '保存' : '连接'
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
