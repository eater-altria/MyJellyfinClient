import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BaseItem, MediaServerApi } from '../api/mediaServer';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';
import { mediaFolderDate, orderMediaItems } from '../utils/listPresentation';
import SectionRow from '../components/SectionRow';
import PosterCard from '../components/PosterCard';
import HeroCarousel from '../components/HeroCarousel';
import { EmptyState, ErrorState, Spinner } from '../components/Feedback';
import { IconServer } from '../components/icons';

const COLLECTION_TYPE_CN: Record<string, string> = {
  movies: '电影',
  tvshows: '节目',
  music: '音乐',
  photos: '照片',
  mixed: '合集',
  boxsets: '合集',
};

const PASTEL_GRADIENTS = [
  'from-rose-100 to-orange-100',
  'from-sky-100 to-indigo-100',
  'from-emerald-100 to-teal-100',
  'from-violet-100 to-fuchsia-100',
  'from-amber-100 to-yellow-100',
  'from-cyan-100 to-blue-100',
];

const PAGE_SIZE = 24; // Request size only; every category can load all its pages.
const RESUME_VIEW: BaseItem = { Id: '@resume', Name: '继续观看' };
const NEXT_VIEW: BaseItem = { Id: '@next-up', Name: '接下来' };
interface ViewItems {
  items: BaseItem[];
  offset: number;
  total?: number;
  hasMore: boolean;
  loading: boolean;
  error: boolean;
}

/** /server/:serverId — immersive SenPlayer server home. */
export default function HomePage() {
  const { serverId = '' } = useParams();
  // Keep pending pages and carousel state scoped to the server/account.
  const server = useServers((s) => s.servers.find((x) => x.id === serverId));
  return <ServerHome key={`${serverId}:${server?.address}:${server?.userId}:${server?.token}`} serverId={serverId} />;
}

function ServerHome({ serverId }: { serverId: string }) {
  const navigate = useNavigate();
  const settings = useSettings();
  const server = useServers((s) => s.servers.find((x) => x.id === serverId));
  const api = useMemo<MediaServerApi | null>(
    () => useServers.getState().getApi(serverId),
    [serverId],
  );

  const [loading, setLoading] = useState(true);
  const [views, setViews] = useState<BaseItem[]>([]);
  const [itemsByView, setItemsByView] = useState<Record<string, ViewItems>>({});
  const [viewsError, setViewsError] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const requests = useRef(new Map<string, AbortController>());

  const loadView = useCallback(async (view: BaseItem, offset = 0) => {
    if (!api || requests.current.has(view.Id)) return;
    const controller = new AbortController();
    requests.current.set(view.Id, controller);
    const currentGeneration = generation.current;
    setItemsByView(prev => ({ ...prev, [view.Id]: {
      items: prev[view.Id]?.items ?? [], offset, total: prev[view.Id]?.total,
      hasMore: prev[view.Id]?.hasMore ?? false, loading: true, error: false,
    } }));
    try {
      const result = view.Id === RESUME_VIEW.Id ? await api.getResumeItems(PAGE_SIZE, offset, controller.signal)
        : view.Id === NEXT_VIEW.Id ? await api.getNextUp(PAGE_SIZE, offset, controller.signal)
        : await api.getLibraryItems(view, offset, PAGE_SIZE, controller.signal);
      if (controller.signal.aborted || generation.current !== currentGeneration) return;
      const page = result.Items ?? [];
      const nextOffset = offset + page.length;
      const total = Number.isFinite(result.TotalRecordCount) ? result.TotalRecordCount : undefined;
      setItemsByView(prev => {
        const merged = offset === 0 ? page : [...(prev[view.Id]?.items ?? []), ...page];
        return { ...prev, [view.Id]: {
          items: [...new Map(merged.map(item => [item.Id, item])).values()], offset: nextOffset, total,
          hasMore: page.length > 0 && (total == null ? page.length >= PAGE_SIZE : nextOffset < total),
          loading: false, error: false,
        } };
      });
    } catch {
      if (controller.signal.aborted || generation.current !== currentGeneration) return;
      setItemsByView(prev => ({ ...prev, [view.Id]: { ...prev[view.Id], loading: false, error: true } }));
    } finally {
      if (requests.current.get(view.Id) === controller) requests.current.delete(view.Id);
    }
  }, [api]);

  const heroItems = useMemo(() => [...new Map(views.flatMap(view => itemsByView[view.Id]?.items ?? [])
    .map(item => [item.Id, item])).values()]
    .filter(item => ['Movie', 'Series', 'Episode', 'Video'].includes(item.Type ?? '') && api?.backdropUrl(item, 1920)), [api, views, itemsByView]);

  useEffect(() => {
    if (!api) return;
    let mounted = true;
    generation.current++;
    const controller = new AbortController();
    setLoading(true); setViewsError(false); setViews([]); setItemsByView({});

    (async () => {
      let viewList: BaseItem[] = [];
      try {
        const res = await api.getUserViews(controller.signal);
        viewList = res.Items;
      } catch {
        if (mounted) setViewsError(true);
      }
      if (!mounted) return;
      setViews(viewList);
      setLoading(false);

      const jobs: Promise<void>[] = [];
      // One paginated query per category supplies both its row and cover art.
      // Collection containers use BoxSet rather than the latest-video endpoint.
      for (const view of viewList) jobs.push(loadView(view));

      jobs.push(loadView(RESUME_VIEW), loadView(NEXT_VIEW));

      await Promise.allSettled(jobs);
    })();

    return () => {
      mounted = false;
      controller.abort(); generation.current++;
      for (const request of requests.current.values()) request.abort();
      requests.current.clear();
    };
  }, [api, serverId, retry, loadView]);

  if (!api) {
    return (
      <EmptyState
        icon={<IconServer size={56} />}
        title="请先添加服务器"
        hint="添加 Jellyfin 或 Emby 服务器后即可浏览你的媒体库"
      >
        <button
          onClick={() => navigate('/servers')}
          className="mt-1 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition hover:opacity-90"
        >
          前往服务器
        </button>
      </EmptyState>
    );
  }

  const detailRoute = (item: BaseItem) => {
    if (item.Type === 'Series') return `/server/${serverId}/series/${item.Id}`;
    if (item.Type === 'BoxSet' || item.IsFolder) return `/server/${serverId}/library/${item.Id}`;
    return `/server/${serverId}/${item.Type === 'Episode' ? 'episode' : 'movie'}/${item.Id}`;
  };

  const resumeClick = (item: BaseItem) => {
    if (item.Type === 'Episode') navigate(`/server/${serverId}/episode/${item.Id}`);
    else navigate(`/server/${serverId}/movie/${item.Id}`);
  };

  const rowStatus = (view: BaseItem, row?: ViewItems) => <>
    {(!row || row.loading) && <div className="flex min-h-40 min-w-44 items-center justify-center text-sm text-gray-400" role="status">加载中…</div>}
    {row?.error && <div className="flex min-h-40 min-w-52 flex-col items-center justify-center gap-3 rounded-xl bg-white px-4 text-sm text-gray-500">
      <span>此列表暂时加载失败</span>
      <button onClick={() => { void loadView(view, row.offset); }} className="rounded-lg bg-accent px-4 py-1.5 text-white">重试</button>
    </div>}
    {row && !row.loading && !row.error && row.items.length === 0 && <div className="flex min-h-40 min-w-52 items-center justify-center text-sm text-gray-400">此分类暂无内容</div>}
    {row?.hasMore && !row.loading && !row.error && <button onClick={() => { void loadView(view, row.offset); }} className="my-2 min-w-32 shrink-0 rounded-xl bg-white px-4 text-sm text-accent shadow-card">加载更多</button>}
  </>;
  const loadMore = (view: BaseItem) => {
    const row = itemsByView[view.Id];
    return row?.hasMore && !row.loading && !row.error ? () => { void loadView(view, row.offset); } : undefined;
  };
  const resumeRow = itemsByView[RESUME_VIEW.Id];
  const nextRow = itemsByView[NEXT_VIEW.Id];

  return (
    <div className="h-full overflow-y-auto px-8 pb-10">
      {/* Slim transparent header over the hero */}
      <div className="relative z-10 flex h-12 items-center">
        <span className="text-[13px] text-gray-500">{server?.name ?? '服务器'}</span>
      </div>

      {loading ? (
        <Spinner label="正在加载媒体库…" />
      ) : viewsError ? (
        <ErrorState message="无法加载媒体分类，请检查服务器连接后重试。" onRetry={() => setRetry(value => value + 1)} />
      ) : (
        <>
          {/* Hero slides up under the header */}
          {settings.showPreviewImage && <div className="-mt-12">
            <HeroCarousel api={api} items={heroItems} serverId={serverId} />
          </div>}

          {/* 我的媒体 */}
          {views.length > 0 && (
            <SectionRow title="我的媒体" count={views.length}>
              {views.map((view, i) => {
                const thumbs = settings.showPreviewImage ? (itemsByView[view.Id]?.items ?? []).slice(0, 4) : [];
                const gradient = PASTEL_GRADIENTS[i % PASTEL_GRADIENTS.length];
                const folderDate = settings.showFolderTime ? mediaFolderDate(view) : '';
                const childCount = view.ChildCount ?? view.RecursiveItemCount;
                return (
                  <button
                    key={view.Id}
                    onClick={() => navigate(`/server/${serverId}/library/${view.Id}`)}
                    className={`relative h-[110px] w-[200px] shrink-0 overflow-hidden rounded-2xl bg-gradient-to-br ${gradient} text-left shadow-card transition-all hover:-translate-y-0.5 hover:shadow-card-hover`}
                  >
                    {/* Fan stack of posters on the right */}
                    <div className="absolute inset-y-0 right-0 w-24">
                      {thumbs.map((t, ti) => {
                        const url = api.posterUrl(t, 200);
                        if (!url) return null;
                        const rotations = [-14, -5, 5, 14];
                        return (
                          <img
                            key={t.Id}
                            src={url}
                            alt=""
                            draggable={false}
                            className={`absolute top-1/2 h-[88px] w-[60px] rounded-lg shadow-md ${settings.thumbnailFill ? 'object-cover' : 'object-contain'}`}
                            style={{
                              right: 6 + ti * 12,
                              transform: `translateY(-50%) rotate(${rotations[ti % rotations.length]}deg)`,
                              zIndex: ti,
                            }}
                          />
                        );
                      })}
                    </div>
                    <div className="relative z-10 flex h-full flex-col justify-end p-3.5">
                      <div className="text-[14px] font-semibold text-text-primary">
                        {view.Name}{settings.showItemCountInTitle && childCount != null ? `（${childCount}）` : ''}
                      </div>
                      <div className="mt-0.5 text-[11px] text-text-secondary">
                        {COLLECTION_TYPE_CN[view.CollectionType ?? ''] ?? '媒体库'}
                      </div>
                      {folderDate && <div className="mt-0.5 text-[10px] text-text-secondary">{folderDate}</div>}
                    </div>
                  </button>
                );
              })}
            </SectionRow>
          )}

          {/* 继续观看 */}
          {resumeRow && (resumeRow.items.length > 0 || resumeRow.error) && (
            <SectionRow title="继续观看" count={resumeRow.total} onLoadMore={loadMore(RESUME_VIEW)}>
              {orderMediaItems(resumeRow.items, settings.sortFoldersSeparately).map((item) => (
                <PosterCard
                  key={item.Id}
                  api={api}
                  item={item}
                  landscape
                  width={120}
                  onClick={() => resumeClick(item)}
                />
              ))}
              {rowStatus(RESUME_VIEW, resumeRow)}
            </SectionRow>
          )}

          {/* 接下来 */}
          {nextRow && (nextRow.items.length > 0 || nextRow.error) && (
            <SectionRow title="接下来" count={nextRow.total} onLoadMore={loadMore(NEXT_VIEW)}>
              {orderMediaItems(nextRow.items, settings.sortFoldersSeparately).map((item) => (
                <PosterCard
                  key={item.Id}
                  api={api}
                  item={item}
                  landscape
                  width={120}
                  onClick={() => navigate(detailRoute(item))}
                />
              ))}
              {rowStatus(NEXT_VIEW, nextRow)}
            </SectionRow>
          )}

          {/* 最新 per view */}
          {views.map((view) => {
            const row = itemsByView[view.Id];
            const items = row?.items ?? [];
            return (
              <SectionRow
                key={view.Id}
                title={`最新${view.Name}`}
                count={row?.total}
                onMore={() => navigate(`/server/${serverId}/library/${view.Id}`)}
                onLoadMore={loadMore(view)}
              >
                {orderMediaItems(items, settings.sortFoldersSeparately).map((item) => (
                  <PosterCard
                    key={item.Id}
                    api={api}
                    item={item}
                    width={130}
                    onClick={() => navigate(detailRoute(item))}
                  />
                ))}
                {rowStatus(view, row)}
              </SectionRow>
            );
          })}
        </>
      )}
    </div>
  );
}
