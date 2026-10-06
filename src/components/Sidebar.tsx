import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useServers, type SavedServer } from '../store/servers';
import AddServerDialog from './AddServerDialog';
import {
  IconFolder,
  IconHistory,
  IconJellyfin,
  IconEmby,
  IconSearch,
  IconServer,
  IconSettings,
  IconTv,
} from './icons';

const NAV = [
  { to: '/files', label: '文件', icon: IconFolder },
  { to: '/servers', label: '服务器', icon: IconServer },
  { to: '/iptv', label: 'IPTV', icon: IconTv },
  { to: '/history', label: '记录', icon: IconHistory },
  { to: '/search', label: '搜索', icon: IconSearch },
  { to: '/settings', label: '设置', icon: IconSettings },
];

export default function Sidebar() {
  const servers = useServers((s) => s.servers);
  const reachability = useServers((s) => s.reachability);
  const navigate = useNavigate();
  const location = useLocation();
  const [editing, setEditing] = useState<SavedServer | null>(null);

  return (
    <aside className="flex w-[168px] shrink-0 flex-col border-r border-black/5 bg-sidebar-bg pt-2 backdrop-blur-xl">
      <nav className="flex flex-col gap-0.5 px-2.5">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors ${
                isActive
                  ? 'bg-accent font-medium text-white shadow-sm'
                  : 'text-gray-700 hover:bg-black/5'
              }`
            }
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </nav>

      {servers.length > 0 && (
        <div className="mt-5 px-2.5">
          <div className="px-2.5 pb-1 text-[11px] font-medium text-gray-400">服务器</div>
          <div className="flex flex-col gap-0.5">
            {servers.map((s) => (
              <button
                key={s.id}
                onClick={() => { useServers.getState().setActive(s.id); navigate(`/server/${s.id}`); }}
                onContextMenu={(event) => { event.preventDefault(); setEditing(s); }}
                title={`${s.name} · ${s.protocol === 'emby' ? 'Emby' : 'Jellyfin'} · 右键编辑`}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                  location.pathname.startsWith(`/server/${s.id}`)
                    ? 'bg-accent font-medium text-white shadow-sm'
                    : 'text-gray-700 hover:bg-black/5'
                }`}
              >
                {s.protocol === 'emby' ? <IconEmby size={20} className="shrink-0" /> : <IconJellyfin size={20} className="shrink-0" />}
                <span className="truncate">{s.name}</span>
                {reachability[s.id]?.address === s.address && reachability[s.id]?.reachable && (
                  <span role="img" aria-label="服务器可达" title="服务器可达" className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-[#28c840]" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1" />
      {editing && <AddServerDialog key={editing.id} server={editing} onClose={() => setEditing(null)} />}
    </aside>
  );
}
