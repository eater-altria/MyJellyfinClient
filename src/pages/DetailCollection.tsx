import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { BaseItem } from '../api/mediaServer';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';
import { useAppBackdrop } from '../store/appBackdrop';
import { orderMediaItems } from '../utils/listPresentation';
import CastRow from '../components/CastRow';
import PosterCard from '../components/PosterCard';
import EpisodeRow from '../components/EpisodeRow';
import LiquidGlass from '../components/LiquidGlass';
import { EmptyState, ErrorState, Spinner } from '../components/Feedback';
import { IconChevronLeft } from '../components/icons';
import { useBrowseActivity } from '../hooks/useBrowseActivity';
import { useAutoPagination } from '../hooks/useAutoPagination';

/** Full cast, recommendations, season episodes, or a person's paginated filmography. */
export default function DetailCollection({ kind }: { kind: 'cast' | 'similar' | 'person' | 'episodes' }) {
  const active = useBrowseActivity();
  const { serverId, itemId, personId, seasonId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const showCount = useSettings((settings) => settings.showItemCountInTitle);
  const showPreviewImage = useSettings((settings) => settings.showPreviewImage);
  const foldersFirst = useSettings((settings) => settings.sortFoldersSeparately);
  const api = useMemo(() => useServers.getState().getApi(serverId), [serverId]);
  const [source, setSource] = useState<BaseItem | null>(null);
  const [items, setItems] = useState<BaseItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [moreError, setMoreError] = useState('');
  const [retry, setRetry] = useState(0);
  const completed = useRef('');
  const page = useRef<HTMLDivElement>(null);
  const backdropOwner = useRef({});
  const backdropScope = kind === 'person' ? null : `/server/${serverId}/item/${itemId}`;
  // Capture the parent's artwork during render, before its unmount cleanup releases ownership.
  const [inheritedBackdrop] = useState(() => {
    const current = useAppBackdrop.getState().source;
    const parentRoutes = ['series', 'movie', 'episode'].map(type => `/server/${serverId}/${type}/${itemId}`);
    return backdropScope && current && parentRoutes.includes(current.route)
      ? { scope: backdropScope, url: current.url } : null;
  });
  const [backdropItem, setBackdropItem] = useState<{ scope: string; item: BaseItem } | null>(null);
  const backdropUrl = inheritedBackdrop?.scope === backdropScope ? inheritedBackdrop.url
    : api && backdropItem?.scope === backdropScope ? api.backdropUrl(backdropItem.item, 1920) : null;

  useEffect(() => {
    const owner = backdropOwner.current;
    if (!active) return;
    useAppBackdrop.getState().setBackdrop(owner, location.pathname, showPreviewImage ? backdropUrl : null);
    return () => useAppBackdrop.getState().clearBackdrop(owner);
  }, [backdropUrl, location.pathname, showPreviewImage, active]);

  useEffect(() => {
    if (!active) return;
    const signature = JSON.stringify([kind, itemId, personId, seasonId, retry]);
    if (completed.current === signature) return;
    completed.current = '';
    let cancelled = false;
    const controller = new AbortController();
    setSource(null);
    setItems([]);
    setTotal(0);
    setLoading(true);
    setLoadingMore(false);
    setError('');
    setMoreError('');
    (async () => {
      if (!api) throw new Error('服务器不可用，请重新连接服务器');
      const id = kind === 'person' ? personId : kind === 'episodes' ? seasonId : itemId;
      if (!id) throw new Error('缺少详情 ID');
      if (kind === 'episodes' && !itemId) throw new Error('缺少剧集 ID');
      if (kind === 'episodes' && itemId && backdropScope && inheritedBackdrop?.scope !== backdropScope) {
        // Direct links can recover the series artwork independently of the season grid request.
        api.getItem(itemId, controller.signal).then((parent) => {
          if (!cancelled) setBackdropItem({ scope: backdropScope, item: parent });
        }).catch(() => {});
      }
      const [detail, result] = await Promise.all([
        api.getItem(id, controller.signal),
        kind === 'person' ? api.getPersonItems(id, 0, 60, controller.signal) :
          kind === 'similar' ? api.getSimilar(id, null, controller.signal) :
            kind === 'episodes' ? api.getEpisodes(itemId!, seasonId, controller.signal) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setSource(detail);
      if (kind !== 'episodes' && backdropScope) setBackdropItem({ scope: backdropScope, item: detail });
      setItems(result?.Items ?? []);
      setTotal(result?.TotalRecordCount ?? result?.Items.length ?? detail.People?.length ?? 0);
    })().catch((e) => {
      if (!cancelled) setError(String(e));
    }).finally(() => {
      if (!cancelled) { completed.current = signature; setLoading(false); }
    });
    return () => { cancelled = true; controller.abort(); };
  }, [api, itemId, personId, seasonId, kind, retry, backdropScope, inheritedBackdrop?.scope, active]);

  // A separate effect cancels pagination responses when navigating to another person.
  useEffect(() => {
    if (!active || !loadingMore || !api || !personId || kind !== 'person') return;
    const controller = new AbortController();
    let cancelled = false;
    api.getPersonItems(personId, items.length, 60, controller.signal).then((result) => {
      if (cancelled) return;
      setItems((previous) => [...previous, ...result.Items]);
      setTotal(result.Items.length ? result.TotalRecordCount : items.length);
    }).catch((e) => {
      if (!cancelled) setMoreError(String(e));
    }).finally(() => {
      if (!cancelled) setLoadingMore(false);
    });
    return () => { cancelled = true; controller.abort(); setLoadingMore(false); };
    // The page offset is captured when loadingMore becomes true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, personId, kind, loadingMore, active]);
  const loadNext = useMemo(() => () => { setMoreError(''); setLoadingMore(true); }, []);
  const sentinel = useAutoPagination(page, active && kind === 'person' && !loading && !loadingMore && !moreError && items.length < total, loadNext);

  const title = kind === 'cast' ? '演职人员' : kind === 'similar' ? '类似作品' : kind === 'episodes' ? '全部剧集' : '参演及参与作品';
  const openItem = (item: BaseItem) => {
    if (item.Type === 'Episode') navigate(`/server/${serverId}/episode/${item.Id}`);
    else navigate(`/server/${serverId}/${item.Type === 'Series' ? 'series' : 'movie'}/${item.Id}`);
  };

  return (
    <div ref={page} className="h-full overflow-y-auto px-5 pb-10 lg:px-8">
      <LiquidGlass intensity="subtle" className="sticky top-4 z-20 my-4 flex min-h-16 items-center gap-3 rounded-[24px] px-4 py-3">
        <button onClick={() => navigate(-1)} title="返回" aria-label="返回" className="glass-icon-button h-9 w-9 shrink-0">
          <IconChevronLeft size={18} />
        </button>
        <h1 className="min-w-0 break-words text-[20px] font-semibold tracking-tight">{source?.Name ? `${source.Name} · ` : ''}{title}{showCount && !loading ? `（${total}）` : ''}</h1>
      </LiquidGlass>
      {loading ? <Spinner label="正在加载…" /> : error ? (
        <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />
      ) : api && source ? (
        <>
          {kind === 'person' && (
            <div className="glass-surface my-6 flex flex-wrap items-start gap-5 rounded-[28px] p-6">
              {api.posterUrl(source, 300) && <img src={api.posterUrl(source, 300)!} alt={source.Name} className="h-40 w-28 rounded-[20px] object-cover shadow-card ring-1 ring-white/80" />}
              <div className="min-w-0 flex-1"><h2 className="text-2xl font-semibold tracking-tight">{source.Name}</h2>
                {source.Overview && <p className="mt-3 max-w-3xl whitespace-pre-line text-[13px] leading-relaxed text-gray-600">{source.Overview}</p>}
              </div>
            </div>
          )}
          {kind === 'cast' ? (
            <CastRow api={api} people={source.People ?? []} grid onPersonClick={(person) => navigate(`/server/${serverId}/person/${person.Id}`)} />
          ) : kind === 'episodes' ? (
            items.length ? <div className="mt-6"><EpisodeRow api={api} episodes={items} serverId={serverId!} grid /></div>
              : <EmptyState title="本季暂无剧集" hint="服务器中暂无可显示的剧集。" />
          ) : items.length ? (
            <div className="mt-6 flex flex-wrap gap-x-5 gap-y-6">
              {orderMediaItems(items, foldersFirst).map((item) => <PosterCard key={item.Id} api={api} item={item} onClick={() => openItem(item)} />)}
            </div>
          ) : <EmptyState title="暂无作品" hint="服务器媒体库中暂无可显示的作品。" />}
          {kind === 'person' && items.length < total && (
            <div ref={sentinel} className="mt-6 text-center">
              {moreError && <p className="mb-2 text-sm text-red-500">{moreError}</p>}
              <button disabled={loadingMore} onClick={() => { setMoreError(''); setLoadingMore(true); }}
                className="glass-button px-5 py-2.5 text-sm disabled:opacity-50">
                {loadingMore ? '正在加载…' : `加载更多（剩余 ${total - items.length}）`}
              </button>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
