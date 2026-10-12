import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useServers } from '../store/servers';
import { serverProtocolName } from '../api/mediaServer';
import ServerIcon from './ServerIcon';
import LiquidGlass from './LiquidGlass';
import { useServerReorder } from '../hooks/useServerReorder';
import ServerReorderFeedback from './ServerReorderFeedback';
import {
  IconFolder,
  IconHistory,
  IconSearch,
  IconServer,
  IconSettings,
  IconTv,
  IconLibrary,
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
  const reorder = useServerReorder('sidebar');

  return (
    <aside className="app-sidebar flex shrink-0 flex-col" aria-label="主导航">
      <LiquidGlass intensity="prominent" interactive className="sidebar-surface flex min-h-0 flex-1 flex-col p-3">
      <div className="sidebar-brand flex items-center gap-3 px-2 pb-5 pt-2">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent"><IconLibrary size={22} /></span>
        <div className="sidebar-label min-w-0"><div className="text-[14px] font-semibold tracking-tight">我的媒体</div><div className="mt-0.5 text-[10px] text-text-secondary">Jellyfin & Emby</div></div>
      </div>
      <nav className="flex flex-col gap-1.5" aria-label="应用页面">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `sidebar-link flex items-center gap-3 rounded-full px-3 py-2.5 text-[13px] transition-colors ${
                isActive
                  ? 'sidebar-link-active font-semibold text-accent'
                  : 'text-text-primary'
              }`
            }
            title={label}
          >
            <Icon size={18} className="shrink-0" />
            <span className="sidebar-label">{label}</span>
          </NavLink>
        ))}
      </nav>

      {servers.length > 0 && (
        <div data-server-reorder-list="sidebar" className="mt-7 min-h-0 overflow-y-auto">
          <div className="sidebar-label px-3 pb-2 text-[10px] font-semibold tracking-wider text-text-secondary">已连接的服务器</div>
          <div className="flex flex-col gap-1.5">
            {servers.map((s) => (
              <button
                key={s.id}
                {...reorder.itemProps(s.id)}
                onClick={() => { useServers.getState().setActive(s.id); navigate(`/server/${s.id}`); }}
                title={`${s.name} · ${serverProtocolName(s.protocol)} · 拖动排序`}
                className={`sidebar-link server-sort-item flex items-center gap-3 rounded-full px-3 py-2.5 text-left text-[13px] transition-colors ${
                  location.pathname.startsWith(`/server/${s.id}`)
                    ? 'sidebar-link-active font-semibold text-accent'
                    : 'text-text-primary'
                }`}
                aria-label={`${s.name} · ${serverProtocolName(s.protocol)}`}
                aria-current={location.pathname.startsWith(`/server/${s.id}`) ? 'page' : undefined}
              >
                <ServerIcon protocol={s.protocol} size={20} className="shrink-0" />
                <span className="sidebar-label truncate">{s.name}</span>
                {reachability[s.id]?.address === s.address && reachability[s.id]?.reachable && (
                  <span role="img" aria-label="服务器可达" title="服务器可达" className="sidebar-status ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-[#28c840]" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1" />
      </LiquidGlass>
      <ServerReorderFeedback instructionId={reorder.instructionId} />
    </aside>
  );
}
