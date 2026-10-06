import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BaseItem, MediaServerApi, libraryItemTypes } from '../api/mediaServer';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';
import { mediaFolderDate, mediaSortParams, orderMediaItems } from '../utils/listPresentation';
import PosterCard from '../components/PosterCard';
import { EmptyState, ErrorState, Spinner } from '../components/Feedback';
import { IconChevronLeft, IconServer } from '../components/icons';

type SortKey = 'name' | 'date' | 'year' | 'rating';

const SORT_OPTIONS: { key: SortKey; label: string; sortBy: string; sortOrder: string }[] = [
  { key: 'name', label: '名称', sortBy: 'SortName', sortOrder: 'Ascending' },
  { key: 'date', label: '添加日期', sortBy: 'DateCreated', sortOrder: 'Descending' },
  { key: 'year', label: '年份', sortBy: 'ProductionYear', sortOrder: 'Descending' },
  { key: 'rating', label: '评分', sortBy: 'CommunityRating', sortOrder: 'Descending' },
];

type TypeFilter = 'all' | 'movie' | 'series';

const FILTER_OPTIONS: { key: TypeFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'movie', label: '电影' },
  { key: 'series', label: '剧集' },
];

const PAGE_SIZE = 120;

/** /server/:serverId/library/:libraryId — grid of library contents. */
export default function LibraryPage() {
  const { serverId = '', libraryId = '' } = useParams();
  const navigate = useNavigate();
  const showCount = useSettings((settings) => settings.showItemCountInTitle);
  const showFolderTime = useSettings((settings) => settings.showFolderTime);
  const foldersFirst = useSettings((settings) => settings.sortFoldersSeparately);
  const api = useMemo<MediaServerApi | null>(
    () => useServers.getState().getApi(serverId),
    [serverId],
  );

  const [view, setView] = useState<BaseItem | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [items, setItems] = useState<BaseItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [retryTick, setRetryTick] = useState(0);
  const requestVersion = useRef(0);
  const viewLibrary = useRef<string>();

  const includeItemTypes = useMemo(() => {
    if (view?.CollectionType === 'mixed') {
      if (typeFilter === 'movie') return 'Movie';
      if (typeFilter === 'series') return 'Series';
    }
    return libraryItemTypes(view);
  }, [view, typeFilter]);

  const buildParams = useCallback(
    (startIndex: number) => {
      const sort = SORT_OPTIONS.find((o) => o.key === sortKey) ?? SORT_OPTIONS[0];
      return {
        ParentId: libraryId,
        Recursive: true,
        IncludeItemTypes: includeItemTypes,
        ...mediaSortParams(sort.sortBy, sort.sortOrder, foldersFirst),
        Limit: PAGE_SIZE,
        StartIndex: startIndex,
        EnableImageTypes: 'Primary,Thumb,Backdrop,Chapter',
      };
    },
    [libraryId, includeItemTypes, sortKey, foldersFirst],
  );

  // Load the view type before choosing item filters, including BoxSet views.
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    viewLibrary.current = undefined;
    setView(null); setLoading(true); setError('');
    api.getItem(libraryId).then(v => {
      if (mounted) { viewLibrary.current = libraryId; setView(v); }
    }).catch(e => {
      if (mounted) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
    });
    return () => { mounted = false; };
  }, [api, libraryId, retryTick]);

  // (Re)load items when api / sort / filter changes
  useEffect(() => {
    if (!api || !view || viewLibrary.current !== libraryId) return;
    let mounted = true;
    ++requestVersion.current;
    setLoading(true);
    setLoadingMore(false);
    setItems([]);
    setTotal(0);
    setError('');
    api
      .queryItems(buildParams(0))
      .then((res) => {
        if (!mounted) return;
        setItems(res.Items);
        setTotal(res.TotalRecordCount);
        setLoading(false);
      })
      .catch((e) => {
        if (!mounted) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      mounted = false;
      ++requestVersion.current;
    };
  }, [api, buildParams, retryTick, view, libraryId]);

  const loadMore = () => {
    if (!api || loadingMore) return;
    const version = requestVersion.current;
    setLoadingMore(true);
    api
      .queryItems(buildParams(items.length))
      .then((res) => {
        if (version !== requestVersion.current) return;
        setItems((prev) => [...prev, ...res.Items]);
        setTotal(res.TotalRecordCount);
        setLoadingMore(false);
      })
      .catch(() => {
        if (version === requestVersion.current) setLoadingMore(false);
      });
  };

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

  const isMixed = view?.CollectionType === 'mixed';
  const hasMore = total > items.length;
  const displayedItems = orderMediaItems(items, foldersFirst);
  const folderDate = showFolderTime && view ? mediaFolderDate(view) : '';

  return (
    <div className="h-full overflow-y-auto px-8 pb-10">
      {/* Header */}
      <div className="flex h-12 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={() => navigate(-1)}
            className="rounded-full p-1.5 text-gray-400 transition hover:bg-black/5 hover:text-gray-600"
          >
            <IconChevronLeft size={18} />
          </button>
          <h1 className="truncate text-[15px] font-semibold text-text-primary">
            {view?.Name ?? '媒体库'}{showCount && !loading ? `（${total}）` : ''}
          </h1>
          {folderDate && <span className="text-[12px] text-gray-400">{folderDate}</span>}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isMixed && (
            <div className="flex rounded-lg bg-gray-100 p-0.5">
              {FILTER_OPTIONS.map((o) => (
                <button
                  key={o.key}
                  onClick={() => setTypeFilter(o.key)}
                  className={`rounded-md px-2.5 py-1 text-[12px] transition ${
                    typeFilter === o.key
                      ? 'bg-white text-text-primary shadow-sm'
                      : 'text-gray-400 hover:text-gray-600'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-[12px] text-text-primary outline-none transition focus:border-accent"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Body */}
      {loading ? (
        <Spinner label="正在加载…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => setRetryTick((t) => t + 1)} />
      ) : items.length === 0 ? (
        <EmptyState title="此媒体库为空" hint="该媒体库中还没有可显示的内容" />
      ) : (
        <>
          <div className="mt-2 flex flex-wrap gap-4">
            {displayedItems.map((item) => (
              <PosterCard
                key={item.Id}
                api={api}
                item={item}
                width={140}
                onClick={() => navigate(detailRoute(item))}
              />
            ))}
          </div>

          {hasMore && (
            <div className="mt-6 flex justify-center">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="flex h-9 min-w-[120px] items-center justify-center rounded-lg bg-white px-5 text-[13px] text-text-primary shadow-card transition hover:shadow-card-hover disabled:opacity-60"
              >
                {loadingMore ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-accent" />
                ) : (
                  `加载更多（剩余 ${total - items.length}）`
                )}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
