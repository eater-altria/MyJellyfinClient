import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BaseItem, MediaServerApi } from '../api/mediaServer';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';
import { mediaFolderDate, orderMediaItems } from '../utils/listPresentation';
import SectionRow from '../components/SectionRow';
import PosterCard from '../components/PosterCard';
import HeroCarousel from '../components/HeroCarousel';
import { EmptyState, Spinner } from '../components/Feedback';
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

/** /server/:serverId — immersive SenPlayer server home. */
export default function HomePage() {
  const { serverId = '' } = useParams();
  // Each server owns its home data and carousel state. Reusing the previous
  // instance retained eight hero items, so appending the next server's items
  // and truncating to eight kept displaying the old server indefinitely.
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
  const [heroItems, setHeroItems] = useState<BaseItem[]>([]);
  const [viewThumbs, setViewThumbs] = useState<Record<string, BaseItem[]>>({});
  const [resumeItems, setResumeItems] = useState<BaseItem[]>([]);
  const [nextUpItems, setNextUpItems] = useState<BaseItem[]>([]);
  const [latestByView, setLatestByView] = useState<Record<string, BaseItem[]>>({});

  useEffect(() => {
    if (!api) return;
    let mounted = true;

    (async () => {
      let viewList: BaseItem[] = [];
      try {
        const res = await api.getUserViews();
        viewList = res.Items;
      } catch {
        /* show empty home */
      }
      if (!mounted) return;
      setViews(viewList);
      setLoading(false);

      // Views suitable for hero / latest rows
      const mediaViews = viewList.filter((v) =>
        ['movies', 'tvshows', 'mixed'].includes(v.CollectionType ?? ''),
      );

      // Fetch everything else; failures are skipped silently
      const jobs: Promise<void>[] = [];

      // Hero: latest items with backdrops from the first 2 suitable views
      for (const v of mediaViews.slice(0, 2)) {
        jobs.push(
          api
            .getLatest(v.Id, 8)
            .then((items) => {
              if (!mounted) return;
              const withBackdrop = items.filter((it) => api.backdropUrl(it, 1920) != null);
              setHeroItems((prev) => [...prev, ...withBackdrop].slice(0, 8));
            })
            .catch(() => {}),
        );
      }

      // Fan-stack thumbnails for "我的媒体" cards
      for (const v of viewList) {
        jobs.push(
          api
            .getLatest(v.Id, 4)
            .then((items) => {
              if (!mounted) return;
              setViewThumbs((prev) => ({ ...prev, [v.Id]: items }));
            })
            .catch(() => {}),
        );
      }

      // 继续观看
      jobs.push(
        api
          .getResumeItems(12)
          .then((res) => {
            if (!mounted) return;
            setResumeItems(res.Items);
          })
          .catch(() => {}),
      );

      // 接下来
      jobs.push(
        api
          .getNextUp(12)
          .then((res) => {
            if (!mounted) return;
            setNextUpItems(res.Items);
          })
          .catch(() => {}),
      );

      // 最新 per view (first 3)
      for (const v of viewList.slice(0, 3)) {
        jobs.push(
          api
            .getLatest(v.Id, 12)
            .then((items) => {
              if (!mounted) return;
              setLatestByView((prev) => ({ ...prev, [v.Id]: items }));
            })
            .catch(() => {}),
        );
      }

      await Promise.allSettled(jobs);
    })();

    return () => {
      mounted = false;
    };
  }, [api, serverId]);

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

  const detailRoute = (item: BaseItem) =>
    item.Type === 'Series'
      ? `/server/${serverId}/series/${item.Id}`
      : `/server/${serverId}/${item.Type === 'Episode' ? 'episode' : 'movie'}/${item.Id}`;

  const resumeClick = (item: BaseItem) => {
    if (item.Type === 'Episode') navigate(`/server/${serverId}/episode/${item.Id}`);
    else navigate(`/server/${serverId}/movie/${item.Id}`);
  };

  return (
    <div className="h-full overflow-y-auto px-8 pb-10">
      {/* Slim transparent header over the hero */}
      <div className="relative z-10 flex h-12 items-center">
        <span className="text-[13px] text-gray-500">{server?.name ?? '服务器'}</span>
      </div>

      {loading ? (
        <Spinner label="正在加载媒体库…" />
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
                const thumbs = settings.showPreviewImage ? (viewThumbs[view.Id] ?? []).slice(0, 4) : [];
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
          {resumeItems.length > 0 && (
            <SectionRow title="继续观看" count={resumeItems.length}>
              {orderMediaItems(resumeItems, settings.sortFoldersSeparately).map((item) => (
                <PosterCard
                  key={item.Id}
                  api={api}
                  item={item}
                  landscape
                  width={120}
                  onClick={() => resumeClick(item)}
                />
              ))}
            </SectionRow>
          )}

          {/* 接下来 */}
          {nextUpItems.length > 0 && (
            <SectionRow title="接下来" count={nextUpItems.length}>
              {orderMediaItems(nextUpItems, settings.sortFoldersSeparately).map((item) => (
                <PosterCard
                  key={item.Id}
                  api={api}
                  item={item}
                  landscape
                  width={120}
                  onClick={() => navigate(detailRoute(item))}
                />
              ))}
            </SectionRow>
          )}

          {/* 最新 per view */}
          {views.slice(0, 3).map((view) => {
            const items = latestByView[view.Id] ?? [];
            if (items.length === 0) return null;
            return (
              <SectionRow
                key={view.Id}
                title={`最新${view.Name}`}
                count={items.length}
                onMore={() => navigate(`/server/${serverId}/library/${view.Id}`)}
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
              </SectionRow>
            );
          })}
        </>
      )}
    </div>
  );
}
