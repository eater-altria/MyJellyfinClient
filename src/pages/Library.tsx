import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, BaseItem, MediaServerApi, libraryItemTypes, type LibraryFilterOptions } from '../api/mediaServer';
import { useBrowseActivity } from '../hooks/useBrowseActivity';
import { useAutoPagination } from '../hooks/useAutoPagination';
import { browseOwnerId, subscribeBrowseUserData } from '../utils/browseHistory';
import { EMPTY_LIBRARY_FILTERS, libraryFilterParams, readLibraryFilters, writeLibraryFilters, type LibraryFilters } from '../utils/libraryFilters';
import LibraryFilterDialog from '../components/LibraryFilterDialog';
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
  const active = useBrowseActivity();
  const { serverId = '', libraryId = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const filters = useMemo(() => readLibraryFilters(search), [search]);
  const mode = ['genres', 'tags', 'favorites'].includes(search.get('view') ?? '') ? search.get('view')! : 'items';
  const facetMode = mode === 'genres' || mode === 'tags';
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
  const typeFilter: TypeFilter = search.get('type') === 'movie' ? 'movie' : search.get('type') === 'series' ? 'series' : 'all';
  const [items, setItems] = useState<BaseItem[]>([]);
  const itemsRef = useRef(items); itemsRef.current = items;
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [retryTick, setRetryTick] = useState(0);
  const requestVersion = useRef(0);
  const pageRequest = useRef<AbortController | null>(null);
  const viewLibrary = useRef<string>();
  const loadedQuery = useRef('');
  const loadedMeta = useRef('');
  const [offset, setOffset] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [facets, setFacets] = useState<LibraryFilterOptions | null>(null);
  const [facetsLoading, setFacetsLoading] = useState(false);
  const [facetsError, setFacetsError] = useState('');
  const [facetRetry, setFacetRetry] = useState(0);
  const loadedFacets = useRef('');
  const [showFilters, setShowFilters] = useState(false);
  const [facetSearch, setFacetSearch] = useState('');
  const page = useRef<HTMLDivElement>(null);
  const applyFilters = (next: LibraryFilters) => { setShowFilters(false); setSearch(writeLibraryFilters(search, next), { replace: true }); };
  const closeFilters = useCallback(() => setShowFilters(false), []);

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
        ...libraryFilterParams(filters),
        EnableTotalRecordCount: true,
        EnableUserData: true,
        Limit: PAGE_SIZE,
        StartIndex: startIndex,
        EnableImageTypes: 'Primary,Thumb,Backdrop,Chapter',
      };
    },
    [libraryId, includeItemTypes, sort.key, sort.order, foldersFirst, filters],
  );

  // Load the view type before choosing item filters, including BoxSet views.
  useEffect(() => {
    if (!api || !active || loadedMeta.current === `${browseOwnerId(api)}:${libraryId}:${retryTick}`) return;
    let mounted = true;
    const controller = new AbortController();
    viewLibrary.current = undefined;
    setView(null); setLoading(true); setError('');
    api.getItem(libraryId, controller.signal).then(v => {
      if (mounted) { loadedMeta.current = `${browseOwnerId(api)}:${libraryId}:${retryTick}`; viewLibrary.current = libraryId; setView(v); }
    }).catch(e => {
      if (mounted) { setError('媒体库信息加载失败，请重试'); setLoading(false); }
    });
    return () => { mounted = false; controller.abort(); };
  }, [api, libraryId, retryTick, active]);

  // (Re)load items when api / sort / filter changes
  useEffect(() => {
    if (!api || !active || !view || viewLibrary.current !== libraryId) return;
    let mounted = true;
    const controller = new AbortController();
    ++requestVersion.current;
    const queryKey = JSON.stringify([browseOwnerId(api), buildParams(0), retryTick]);
    const cleanup = () => { mounted = false; controller.abort(); pageRequest.current?.abort(); pageRequest.current = null; setLoadingMore(false); ++requestVersion.current; };
    if (facetMode) { setLoading(false); return cleanup; }
    if (loadedQuery.current === queryKey) return cleanup;
    loadedQuery.current = '';
    page.current?.scrollTo({ top: 0 });
    setLoading(true);
    setLoadingMore(false);
    setItems([]);
    setTotal(0);
    setError('');
    setMoreError(''); setOffset(0); setHasNext(false);
    api
      .queryItems(buildParams(0), controller.signal)
      .then((res) => {
        if (!mounted) return;
        setItems(res.Items);
        setTotal(res.TotalRecordCount);
        setOffset(res.Items.length); setHasNext(res.Items.length > 0 && res.Items.length < res.TotalRecordCount);
        loadedQuery.current = queryKey;
        setLoading(false);
      })
      .catch((e) => {
        if (!mounted) return;
        setError('媒体列表加载失败，请重试');
        setLoading(false);
      });
    return cleanup;
  }, [api, buildParams, retryTick, view, libraryId, active, facetMode]);

  useEffect(() => {
    if (!api || !active || !view || (!facetMode && !showFilters)) return;
    const key = JSON.stringify([browseOwnerId(api), libraryId, includeItemTypes, facetRetry]);
    if (loadedFacets.current === key) return;
    loadedFacets.current = '';
    const controller = new AbortController(); setFacetsLoading(true); setFacetsError(''); setFacets(null);
    api.getLibraryFilters(libraryId, includeItemTypes, controller.signal).then(value => {
      if (!controller.signal.aborted) { loadedFacets.current = key; setFacets(value); setFacetsLoading(false); }
    }).catch(error => { if (!controller.signal.aborted) {
      const product = api.protocol === 'emby' ? 'Emby' : 'Jellyfin';
      setFacetsError(error instanceof ApiError ? `${product} 筛选选项加载失败（HTTP ${error.status}）`
        : `${product} 筛选选项加载失败，请检查连接后重试`);
      setFacetsLoading(false);
    } });
    return () => controller.abort();
  }, [api, active, view, libraryId, includeItemTypes, facetMode, showFilters, facetRetry]);

  useEffect(() => subscribeBrowseUserData((owner, id, fields) => {
    if (owner !== api) return;
    if (filters.favoritesOnly && fields.IsFavorite === false) {
      if (itemsRef.current.some(item => item.Id === id)) {
        itemsRef.current = itemsRef.current.filter(item => item.Id !== id);
        setItems(itemsRef.current); setTotal(previous => Math.max(0, previous - 1)); setOffset(previous => Math.max(0, previous - 1));
      }
      return;
    }
    setItems(previous => previous.map(item => item.Id === id ? { ...item, UserData: { ...item.UserData, ...fields } } : item));
  }), [api, filters.favoritesOnly]);

  const loadMore = useCallback(() => {
    if (!api || !active || loading || loadingMore || !hasNext || facetMode || pageRequest.current) return;
    const version = requestVersion.current;
    const controller = new AbortController();
    pageRequest.current = controller;
    setLoadingMore(true);
    setMoreError('');
    api
      .queryItems(buildParams(offset), controller.signal)
      .then((res) => {
        if (controller.signal.aborted || version !== requestVersion.current) return;
        setItems((prev) => [...new Map([...prev, ...res.Items].map(item => [item.Id, item])).values()]);
        const next = offset + res.Items.length; setOffset(next); setHasNext(res.Items.length > 0 && next < res.TotalRecordCount);
        setTotal(res.TotalRecordCount);
        setLoadingMore(false);
        pageRequest.current = null;
      })
      .catch(() => {
        if (!controller.signal.aborted && version === requestVersion.current) { setMoreError('加载更多失败，请重试'); setLoadingMore(false); pageRequest.current = null; }
      });
  }, [api, active, loading, loadingMore, hasNext, facetMode, buildParams, offset]);
  const sentinel = useAutoPagination(page, active && hasNext && !loading && !loadingMore && !moreError && !facetMode, loadMore);
  const facetValues = (mode === 'genres' ? facets?.genres : facets?.tags)?.filter(name => name.toLocaleLowerCase().includes(facetSearch.toLocaleLowerCase())) ?? [];

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
  const hasMore = hasNext;
  const displayedItems = orderMediaItems(items, foldersFirst);
  const folderDate = showFolderTime && view ? mediaFolderDate(view) : '';

  return (
    <div ref={page} className="h-full overflow-y-auto px-5 pb-10 lg:px-8" aria-label="媒体库内容">
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
                  onClick={() => { const next = new URLSearchParams(search); next.set('type', o.key); setSearch(next, { replace: true }); }}
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
          <button type="button" aria-haspopup="dialog" aria-expanded={active && showFilters} className="glass-button px-4 py-2 text-[13px]" onClick={() => setShowFilters(true)}>筛选</button>
          <button type="button" className="glass-button px-4 py-2 text-[13px]" onClick={() => { loadedFacets.current = ''; setFacetRetry(value => value + 1); setRetryTick(value => value + 1); }}>刷新</button>
        </div>
      </LiquidGlass>

      <nav aria-label="媒体库浏览方式" className="my-4 flex flex-wrap gap-2">
        {[['items', '全部媒体'], ['favorites', '收藏'], ['genres', '类型与风格'], ['tags', '标签']].map(([key, label]) => <button key={key} aria-pressed={mode === key}
          className={`glass-button px-4 py-2 text-[13px] ${mode === key ? 'text-accent ring-1 ring-accent/20' : 'text-text-secondary'}`}
          onClick={() => { const next = new URLSearchParams(search); next.set('view', key); next.delete('favorite'); setSearch(next, { replace: true }); }}>{label}</button>)}
      </nav>
      {(filters.genres.length + filters.tags.length + filters.years.length + Number(filters.favoritesOnly)) > 0 && <div className="mb-4 flex flex-wrap items-center gap-2 text-[12px]">
        {[...filters.genres, ...filters.tags, ...filters.years.map(String), ...(filters.favoritesOnly ? ['仅看收藏'] : [])].map((label, index) => <span key={index} className="rounded-full bg-white/55 px-3 py-1">{label}</span>)}
        <button onClick={() => applyFilters(EMPTY_LIBRARY_FILTERS)} className="glass-button px-3 py-1">清除筛选</button>
      </div>}

      {/* Body */}
      {loading ? (
        <Spinner label="正在加载…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => setRetryTick((t) => t + 1)} />
      ) : facetMode ? <>
        <input type="search" aria-label="搜索分类" placeholder="搜索类型或标签" value={facetSearch} onChange={event => setFacetSearch(event.target.value)} className="glass-input mb-4 w-full max-w-sm px-4 py-2 text-[13px]" />
        {facetsLoading ? <Spinner label="正在加载分类…" /> : facetsError ? <ErrorState message={facetsError} onRetry={() => setFacetRetry(value => value + 1)} />
          : <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{facetValues.map(name => (
            <button key={name} className="glass-surface min-w-0 break-words px-4 py-6 text-left text-[14px]" onClick={() => {
              const next = writeLibraryFilters(search, { ...filters, [mode === 'genres' ? 'genres' : 'tags']: [name] }); next.set('view', 'items'); setSearch(next, { replace: true });
            }}>{name}</button>
          ))}</div>}
        {facets && !facetsLoading && !facetsError && !facetValues.length && <EmptyState title={facetSearch ? '没有匹配的分类' : '服务器暂无分类信息'} />}
      </> : items.length === 0 ? (
        <EmptyState title={filters.favoritesOnly || filters.genres.length || filters.tags.length || filters.years.length ? '没有符合条件的媒体' : '此媒体库为空'} hint="尝试调整筛选条件，或稍后刷新媒体库" />
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
            <div ref={sentinel} className="mt-6 flex flex-col items-center gap-2">
              {moreError && <p role="alert" className="text-[13px] text-red-600">{moreError}</p>}
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="glass-button flex min-h-11 min-w-[140px] items-center justify-center px-5 text-[13px] text-text-primary disabled:opacity-60"
              >
                {loadingMore ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-accent" />
                ) : (
                  moreError ? '重试加载更多' : `加载更多（剩余 ${Math.max(0, total - offset)}）`
                )}
              </button>
            </div>
          )}
        </>
      )}
      {active && showFilters && <LibraryFilterDialog value={filters} options={facets} loading={facetsLoading} error={facetsError}
        onRetry={() => setFacetRetry(value => value + 1)} onApply={applyFilters} onClose={closeFilters} />}
    </div>
  );
}
