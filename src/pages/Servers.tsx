import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServers, type SavedServer } from '../store/servers';
import { formatRelativeDate, serverProtocolName } from '../api/mediaServer';
import { EmptyState } from '../components/Feedback';
import AddServerDialog from '../components/AddServerDialog';
import { IconClose, IconJellyfin, IconEmby, IconLibrary, IconMore, IconPlus, IconServer, IconVideo } from '../components/icons';

/** /servers — saved connections and server management. */
export default function ServersPage() {
  const navigate = useNavigate();
  const servers = useServers((s) => s.servers);
  const reachability = useServers((s) => s.reachability);
  const removeServer = useServers((s) => s.removeServer);
  const refreshServer = useServers((s) => s.refreshServer);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<SavedServer | null>(null);

  // Refresh every server on mount (fire and forget)
  useEffect(() => {
    for (const s of useServers.getState().servers) {
      refreshServer(s.id).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="h-full overflow-y-auto px-4 pb-10 sm:px-8">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-7 pt-8">
        <div>
          <h1 className="page-heading">服务器</h1>
          <p className="page-subtitle mt-2">你的媒体收藏，从这里连接。</p>
        </div>
        {servers.length > 0 && (
          <button
            onClick={() => setShowAdd(true)}
            className="glass-button flex items-center gap-2 px-4 py-2.5 text-[13px]"
          >
            <IconPlus size={14} />
            添加
          </button>
        )}
      </div>

      {servers.length === 0 ? (
        <EmptyState
          icon={<IconServer size={56} />}
          title="还没有服务器"
          hint="连接 Jellyfin 或 Emby，浏览你的电影、剧集与收藏。"
        >
          <button
            onClick={() => setShowAdd(true)}
            className="glass-button-primary mt-2 flex items-center gap-2 px-5 py-2.5 text-[13px] font-medium"
          >
            <IconPlus size={15} />
            添加服务器
          </button>
        </EmptyState>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(240px,100%),1fr))] gap-5">
          {servers.map((s) => {
            const online = reachability[s.id]?.address === s.address && reachability[s.id]?.reachable;
            return (
              <div
                key={s.id}
                onContextMenu={(event) => { event.preventDefault(); setEditing(s); }}
                className="glass-surface group relative min-w-0 transition-shadow hover:shadow-card-hover"
              >
                <button
                  onClick={() => { useServers.getState().setActive(s.id); navigate(`/server/${s.id}`); }}
                  aria-label={`打开服务器 ${s.name}`}
                  className="flex min-h-[200px] w-full min-w-0 flex-col rounded-[24px] p-5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <div className="mb-4 flex h-11 items-center">
                    {s.protocol === 'emby' ? <IconEmby size={40} /> : <IconJellyfin size={40} />}
                    {online && (
                      <span className="ml-3 inline-flex items-center gap-1.5 text-[11px] text-text-secondary">
                        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                        服务器可达
                      </span>
                    )}
                  </div>
                  <span className="max-w-full truncate text-[17px] font-semibold tracking-tight text-text-primary" title={s.name}>{s.name}</span>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[12px] text-text-secondary">
                    <span className="flex items-center gap-1.5">
                      <IconLibrary size={13} />
                      媒体库 {s.libraryCount ?? 0} 个
                    </span>
                    {s.itemCount != null && s.itemCount > 0 && (
                      <span className="flex items-center gap-1.5">
                        <IconVideo size={13} />
                        项目 {s.itemCount} 个
                      </span>
                    )}
                  </div>
                  <div className="mt-auto flex w-full flex-wrap items-center justify-between gap-2 pt-5 text-[11px] text-text-secondary">
                    <span className="glass-badge">{serverProtocolName(s.protocol)}</span>
                    <span>{formatRelativeDate(s.lastConnected)}</span>
                  </div>
                </button>
                <button
                  onClick={() => setEditing(s)}
                  className="glass-icon-button absolute right-4 top-4 h-7 min-h-0 w-7 text-text-secondary"
                  aria-label={`编辑服务器 ${s.name}`}
                  title="编辑服务器"
                >
                  <IconMore size={16} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm('确定删除该服务器？')) removeServer(s.id);
                  }}
                  className="glass-icon-button pointer-events-none absolute right-4 top-12 z-10 flex h-7 min-h-0 w-7 items-center justify-center text-text-secondary opacity-0 transition-opacity hover:!text-red-600 focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                  title="删除服务器"
                  aria-label={`删除服务器 ${s.name}`}
                >
                  <IconClose size={11} />
                </button>
              </div>
            );
          })}

          {/* Add card */}
          <button
            onClick={() => setShowAdd(true)}
            className="glass-surface flex min-h-[200px] flex-col items-center justify-center gap-3 text-text-secondary transition-colors hover:bg-white/70 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span className="glass-icon-button flex h-11 w-11 items-center justify-center"><IconPlus size={24} /></span>
            <span className="text-[13px] font-medium">添加服务器</span>
          </button>
        </div>
      )}

      {showAdd && <AddServerDialog onClose={() => setShowAdd(false)} />}
      {editing && <AddServerDialog key={editing.id} server={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
