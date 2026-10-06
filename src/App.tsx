import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import Sidebar from './components/Sidebar';
import TitleBar from './components/TitleBar';
import WindowResizeHandles from './components/WindowResizeHandles';
import FilesPage from './pages/Files';
import ServersPage from './pages/Servers';
import IptvPage from './pages/Iptv';
import HistoryPage from './pages/History';
import SearchPage from './pages/Search';
import SettingsPage from './pages/Settings';
import HomePage from './pages/Home';
import LibraryPage from './pages/Library';
import MovieDetailPage from './pages/MovieDetail';
import SeriesDetailPage from './pages/SeriesDetail';
import PlayerPage from './pages/Player';
import NativePlayer from './pages/NativePlayer';
import DetailCollection from './pages/DetailCollection';
import { isTauri } from './platform/window';
import { useServers } from './store/servers';
import { useSettings } from './store/settings';
import { useServerReachability } from './hooks/useServerReachability';

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

  if (isPlayer) {
    return (
      <div className="flex h-full flex-col bg-black">
        <TitleBar dark />
        <WindowResizeHandles />
        <main className="min-h-0 flex-1">
          <Routes>
            <Route path="/player/:serverId/:itemId" element={isTauri ? <NativePlayer /> : <PlayerPage />} />
          </Routes>
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-hidden bg-page-bg">
          <Routes>
            <Route path="/files" element={<FilesPage />} />
            <Route path="/servers" element={<ServersPage />} />
            <Route path="/iptv" element={<IptvPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/server/:serverId" element={<HomePage />} />
            <Route path="/server/:serverId/library/:libraryId" element={<LibraryPage />} />
            <Route path="/server/:serverId/movie/:itemId" element={<MovieDetailPage />} />
            <Route path="/server/:serverId/episode/:itemId" element={<MovieDetailPage />} />
            <Route path="/server/:serverId/series/:itemId" element={<SeriesDetailPage />} />
            <Route path="/server/:serverId/item/:itemId/cast" element={<DetailCollection kind="cast" />} />
            <Route path="/server/:serverId/item/:itemId/similar" element={<DetailCollection kind="similar" />} />
            <Route path="/server/:serverId/person/:personId" element={<DetailCollection kind="person" />} />
            <Route path="*" element={<ServersPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
