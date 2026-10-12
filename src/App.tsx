import { useLocation, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import ContextMenuHost from './components/ContextMenu';
import Sidebar from './components/Sidebar';
import TitleBar from './components/TitleBar';
import WindowResizeHandles from './components/WindowResizeHandles';
import AppBackdrop from './components/AppBackdrop';
import BrowsePageHost from './components/BrowsePageHost';
import { useSettings } from './store/settings';
import { useServerReachability } from './hooks/useServerReachability';
import { isMacOSTauri } from './platform/window';

const DEFAULT_MODULE_PATH: Record<string, string> = {
  files: '/files',
  servers: '/servers',
  iptv: '/iptv',
  history: '/history',
  search: '/search',
};

export default function App() {
  useServerReachability();
  const location = useLocation();
  const navigate = useNavigate();
  const isPlayer = location.pathname.startsWith('/player');

  // Redirect root to the user's preferred default module
  useEffect(() => {
    if (location.pathname === '/') {
      const mod = useSettings.getState().defaultModule;
      navigate(DEFAULT_MODULE_PATH[mod] ?? '/servers', { replace: true });
    }
  }, [location.pathname, navigate]);

  return (
    <div className={`${isPlayer ? 'bg-black' : 'app-shell'} ${isMacOSTauri ? 'macos-window relative' : ''} flex h-full flex-col`}>
      {!isPlayer && <AppBackdrop />}
      <ContextMenuHost />
      <TitleBar dark={isPlayer} />
      {isPlayer && !isMacOSTauri && <WindowResizeHandles />}
      <div className={`${isPlayer ? '' : 'app-workspace'} flex min-h-0 flex-1`}>
        {!isPlayer && <Sidebar />}
        <main className={`${isPlayer ? '' : 'app-content'} min-h-0 min-w-0 flex-1 overflow-hidden`}>
          <BrowsePageHost />
        </main>
      </div>
    </div>
  );
}
