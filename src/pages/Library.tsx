import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BaseItem, MediaServerApi, libraryItemTypes } from '../api/mediaServer';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';
import { useLibraryPreferences } from '../store/libraryPreferences';
import { DEFAULT_LIBRARY_SORT, LIBRARY_SORT_OPTIONS, librarySortScope } from '../utils/librarySort';
import { mediaFolderDate, mediaSortParams, orderMediaItems } from '../utils/listPresentation';
import PosterCard from '../components/PosterCard';
import LiquidGlass from '../components/LiquidGlass';
import LibrarySortMenu from '../components/LibrarySortMenu';
import { EmptyState, ErrorState, Spinner } from '../components/Feedback';
import { IconChevronLeft, IconServer } from '../components/icons';

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
  const cachedApi = useServers(state => state.apis[serverId]);
  const api = useMemo<MediaServerApi | null>(
    () => cachedApi ?? useServers.getState().getApi(serverId),
    [serverId, cachedApi],
  );
  const sortScope = librarySortScope(serverId, api?.userId, libraryId);
  const sort = useLibraryPreferences(state => state.sorts[sortScope] ?? DEFAULT_LIBRARY_SORT);
  const setSort = useLibraryPreferences(state => state.setSort);

  const [view, setView] = useState<BaseItem | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [items, setItems] = useState<BaseItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [retryTick, setRetryTick] = useState(0);
  const requestVersion = useRef(0);
  const pageRequest = useRef<AbortController | null>(null);
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
      const option = LIBRARY_SORT_OPTIONS.find(item => item.key === sort.key) ?? LIBRARY_SORT_OPTIONS[0];
      return {
        ParentId: libraryId,
        Recursive: true,
        IncludeItemTypes: includeItemTypes,
        ...mediaSortParams(option.sortBy, sort.order, foldersFirst),
        Limit: PAGE_SIZE,
        StartIndex: startIndex,
        EnableImageTypes: 'Primary,Thumb,Backdrop,Chapter',
      };
    },
    [libraryId, includeItemTypes, sort.key, sort.order, foldersFirst],
  );

  // Load the view type before choosing item filters, including BoxSet views.
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    const controller = new AbortController();
    viewLibrary.current = undefined;
    setView(null); setLoading(true); setError('');
    api.getItem(libraryId, controller.signal).then(v => {
      if (mounted) { viewLibrary.current = libraryId; setView(v); }
    }).catch(e => {
      if (mounted) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
    });
    return () => { mounted = false; controller.abort(); };
  }, [api, libraryId, retryTick]);

  // (Re)load items when api / sort / filter changes
  useEffect(() => {
    if (!api || !view || viewLibrary.current !== libraryId) return;
    let mounted = true;
    const controller = new AbortController();
    ++requestVersion.current;
    setLoading(true);
    setLoadingMore(false);
    setItems([]);
    setTotal(0);
    setError('');
    api
      .queryItems(buildParams(0), controller.signal)
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
      controller.abort();
      pageRequest.current?.abort();
      pageRequest.current = null;
      ++requestVersion.current;
    };
  }, [api, buildParams, retryTick, view, libraryId]);

  const loadMore = () => {
    if (!api || loading || loadingMore || pageRequest.current) return;
    const version = requestVersion.current;
    const controller = new AbortController();
    pageRequest.current = controller;
    setLoadingMore(true);
    api
      .queryItems(buildParams(items.length), controller.signal)
      .then((res) => {
        if (version !== requestVersion.current) return;
        setItems((prev) => [...prev, ...res.Items]);
        setTotal(res.TotalRecordCount);
        setLoadingMore(false);
        pageRequest.current = null;
      })
      .catch(() => {
        if (version === requestVersion.current) { setLoadingMore(false); pageRequest.current = null; }
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
          className="glass-button-primary mt-1 px-5 py-2.5 text-[13px] font-medium"
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
    <div className="h-full overflow-y-auto px-5 pb-10 lg:px-8">
      {/* Header */}
      <LiquidGlass intensity="subtle" className="sticky top-4 z-20 my-4 flex min-h-16 flex-wrap items-center justify-between gap-3 rounded-[24px] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={() => navigate(-1)}
            aria-label="返回"
            className="glass-icon-button h-9 w-9 text-text-secondary"
          >
            <IconChevronLeft size={18} />
          </button>
          <h1 className="min-w-0 truncate text-[20px] font-semibold tracking-tight text-text-primary">
            {view?.Name ?? '媒体库'}{showCount && !loading ? `（${total}）` : ''}
          </h1>
          {folderDate && <span className="hidden text-[11px] text-text-secondary sm:inline">{folderDate}</span>}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {isMixed && (
            <div className="glass-surface flex rounded-full p-1">
              {FILTER_OPTIONS.map((o) => (
                <button
                  key={o.key}
                  onClick={() => setTypeFilter(o.key)}
                  aria-pressed={typeFilter === o.key}
                  className={`rounded-full px-3 py-1.5 text-[12px] transition ${
                    typeFilter === o.key
                      ? 'bg-white/85 text-accent shadow-sm'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          <LibrarySortMenu key={sortScope} value={sort} onChange={next => setSort(sortScope, next)} />
        </div>
      </LiquidGlass>

      {/* Body */}
      {loading ? (
        <Spinner label="正在加载…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => setRetryTick((t) => t + 1)} />
      ) : items.length === 0 ? (
        <EmptyState title="此媒体库为空" hint="该媒体库中还没有可显示的内容" />
      ) : (
        <>
          <div className="mt-6 flex flex-wrap gap-x-5 gap-y-6">
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
                className="glass-button flex min-h-11 min-w-[140px] items-center justify-center px-5 text-[13px] text-text-primary disabled:opacity-60"
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
