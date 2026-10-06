import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServers, type SavedServer } from '../store/servers';
import { formatRelativeDate, serverProtocolName } from '../api/mediaServer';
import { EmptyState } from '../components/Feedback';
import AddServerDialog from '../components/AddServerDialog';
import { IconClose, IconJellyfin, IconEmby, IconLibrary, IconPlus, IconServer, IconVideo } from '../components/icons';

/** /servers — SenPlayer-style server card grid. */
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
    <div className="h-full overflow-y-auto px-8 pb-10">
      {/* Header */}
      <div className="flex h-12 items-center justify-between">
        <h1 className="text-[15px] font-semibold text-text-primary">服务器</h1>
        {servers.length > 0 && (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-gray-400 transition hover:bg-black/5 hover:text-gray-600"
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
          hint="点击右上角 + 添加你的 Jellyfin 或 Emby 服务器"
        >
          <button
            onClick={() => setShowAdd(true)}
            className="mt-1 flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition hover:opacity-90"
          >
            <IconPlus size={15} />
            添加服务器
          </button>
        </EmptyState>
      ) : (
        <div className="mt-2 flex flex-wrap gap-4">
          {servers.map((s) => {
            const online = reachability[s.id]?.address === s.address && reachability[s.id]?.reachable;
            return (
              <div
                key={s.id}
                onClick={() => { useServers.getState().setActive(s.id); navigate(`/server/${s.id}`); }}
                onContextMenu={(event) => { event.preventDefault(); setEditing(s); }}
                title="右键编辑服务器"
                className="group relative flex h-[130px] w-[190px] cursor-pointer flex-col rounded-2xl bg-white p-4 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-card-hover"
              >
                {/* Delete button (hover) */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm('确定删除该服务器？')) removeServer(s.id);
                  }}
                  className="absolute -right-1.5 -top-1.5 z-10 hidden h-5 w-5 items-center justify-center rounded-full bg-gray-500 text-white shadow transition hover:bg-red-500 group-hover:flex"
                  title="删除服务器"
                >
                  <IconClose size={11} />
                </button>

                <div className="flex items-start justify-between">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {online && <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" role="img" aria-label="服务器可达" title="服务器可达" />}
                    <span className="truncate text-[14px] font-semibold text-text-primary">
                      {s.name}
                    </span>
                  </div>
                  {s.protocol === 'emby' ? <IconEmby size={28} className="shrink-0" /> : <IconJellyfin size={28} className="shrink-0" />}
                </div>

                <div className="mt-auto flex flex-col gap-1 text-[11px] text-text-secondary">
                  <div className="flex items-center gap-1.5">
                    <IconLibrary size={12} />
                    <span>媒体库 {s.libraryCount ?? 0} 个</span>
                  </div>
                  {s.itemCount != null && s.itemCount > 0 && (
                    <div className="flex items-center gap-1.5">
                      <IconVideo size={12} />
                      <span>项目 {s.itemCount} 个</span>
                    </div>
                  )}
                  <div className="mt-0.5 flex items-center justify-between text-[10px] text-gray-400">
                    <span className="rounded bg-gray-100 px-1.5 py-0.5">{serverProtocolName(s.protocol)}</span>
                    <span>{formatRelativeDate(s.lastConnected)}</span>
                  </div>
                </div>
              </div>
            );
          })}

          {/* Add card */}
          <button
            onClick={() => setShowAdd(true)}
            className="flex h-[130px] w-[190px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-gray-200 text-gray-300 transition hover:-translate-y-0.5 hover:border-accent/40 hover:text-accent"
          >
            <IconPlus size={28} />
            <span className="text-[12px]">添加服务器</span>
          </button>
        </div>
      )}

      {showAdd && <AddServerDialog onClose={() => setShowAdd(false)} />}
      {editing && <AddServerDialog key={editing.id} server={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
