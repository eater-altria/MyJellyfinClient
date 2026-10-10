import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { useServers } from '../store/servers';
import { browseOwnerId } from '../utils/browseHistory';
import { BrowseActivity } from '../hooks/useBrowseActivity';
import HomePage from '../pages/Home';
import LibraryPage from '../pages/Library';
import FilesPage from '../pages/Files';
import ServersPage from '../pages/Servers';
import IptvPage from '../pages/Iptv';
import HistoryPage from '../pages/History';
import SearchPage from '../pages/Search';
import SettingsPage from '../pages/Settings';
import MovieDetailPage from '../pages/MovieDetail';
import SeriesDetailPage from '../pages/SeriesDetail';
import DetailCollection from '../pages/DetailCollection';
import PlayerPage from '../pages/Player';
import NativePlayer from '../pages/NativePlayer';
import { isTauri } from '../platform/window';

interface Entry { key: string; scope: string; location: ReturnType<typeof useLocation>; }
const MAX_RETAINED_PAGES = 20;

function RetainedPage({ entry, active }: { entry: Entry; active: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<HTMLElement, { top: number; left: number }>());
  const visible = useRef(active); visible.current = active;
  const record = (element: HTMLElement) => {
    if (visible.current) positions.current.set(element, { top: element.scrollTop, left: element.scrollLeft });
  };
  const capture = () => root.current?.querySelectorAll<HTMLElement>('.overflow-y-auto,.overflow-x-auto,.overflow-auto,[data-scroll-container]').forEach(record);
  useLayoutEffect(() => {
    if (!active) return;
    const restore = () => {
      for (const [element, position] of positions.current) {
        if (!element.isConnected) { positions.current.delete(element); continue; }
        element.scrollTop = position.top; element.scrollLeft = position.left;
      }
    };
    restore(); const frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return <div ref={root} hidden={!active} aria-hidden={!active} className="h-full" data-page-path={entry.location.pathname}
    onScrollCapture={event => { if (event.target instanceof HTMLElement) record(event.target); }}
    onPointerDownCapture={capture} onKeyDownCapture={capture}>
    <BrowseActivity.Provider value={active}>
      <PageRoutes location={entry.location} />
    </BrowseActivity.Provider>
  </div>;
}

function PageRoutes({ location }: { location: ReturnType<typeof useLocation> }) {
  return <Routes location={location}>
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
    <Route path="/server/:serverId/series/:itemId/season/:seasonId/episodes" element={<DetailCollection kind="episodes" />} />
    <Route path="/server/:serverId/item/:itemId/cast" element={<DetailCollection kind="cast" />} />
    <Route path="/server/:serverId/item/:itemId/similar" element={<DetailCollection kind="similar" />} />
    <Route path="/server/:serverId/person/:personId" element={<DetailCollection kind="person" />} />
    <Route path="/player/:serverId/:itemId" element={isTauri ? <NativePlayer /> : <PlayerPage />} />
    <Route path="*" element={<ServersPage />} />
  </Routes>;
}

/** All route types share a bounded set of real retained page/DOM instances. */
export default function BrowsePageHost() {
  const location = useLocation();
  const apis = useServers(state => state.apis);
  const activeServerId = useServers(state => state.activeServerId);
  const [entries, setEntries] = useState<Entry[]>([]);
  const scopeFor = (path: ReturnType<typeof useLocation>) => {
    // Management forms are local UI state. Refreshing a connection must not
    // destroy the server page (and recursively start another mount refresh).
    if (path.pathname === '/servers') return 'local';
    const routeServer = /^\/(?:server|player)\/([^/]+)/.exec(path.pathname)?.[1];
    const id = routeServer ? decodeURIComponent(routeServer) : path.pathname === '/search'
      ? new URLSearchParams(path.search).get('serverId') ?? activeServerId : path.pathname === '/history' ? activeServerId : null;
    if (id) return JSON.stringify([id, browseOwnerId(apis[id] ?? null)]);
    if (['/search', '/history'].includes(path.pathname)) return JSON.stringify(Object.entries(apis).map(([id, api]) => [id, browseOwnerId(api)]));
    return 'local';
  };
  const scope = scopeFor(location);
  // Consecutive episodes share one retained player component. Each media change
  // still creates a fresh playback effect/session, without evicting its library.
  const pagePath = location.pathname.startsWith('/player/') ? '/player' : location.pathname;
  const key = JSON.stringify([pagePath, scope]);
  const pages = useMemo(() => {
    const valid = entries.filter(entry => entry.scope === scopeFor(entry.location));
    const previous = valid.find(entry => entry.key === key);
    if (previous?.location === location && valid.length === entries.length) return entries;
    return [...valid.filter(entry => entry.key !== key), { key, scope, location }].slice(-MAX_RETAINED_PAGES);
  }, [entries, scope, key, location, apis, activeServerId]);
  useLayoutEffect(() => { if (pages !== entries) setEntries(pages); }, [pages, entries]);
  return <>{pages.map(entry => {
    const active = entry.key === key;
    return <RetainedPage key={entry.key} entry={entry} active={active} />;
  })}</>;
}
