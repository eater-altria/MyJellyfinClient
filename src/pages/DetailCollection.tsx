import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BaseItem } from '../api/mediaServer';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';
import { orderMediaItems } from '../utils/listPresentation';
import CastRow from '../components/CastRow';
import PosterCard from '../components/PosterCard';
import { EmptyState, ErrorState, Spinner } from '../components/Feedback';
import { IconChevronLeft } from '../components/icons';

/** Full cast, recommendations, or a person's complete paginated filmography. */
export default function DetailCollection({ kind }: { kind: 'cast' | 'similar' | 'person' }) {
  const { serverId, itemId, personId } = useParams();
  const navigate = useNavigate();
  const showCount = useSettings((settings) => settings.showItemCountInTitle);
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

  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setItems([]);
    setTotal(0);
    setLoading(true);
    setLoadingMore(false);
    setError('');
    setMoreError('');
    (async () => {
      if (!api) throw new Error('服务器不可用，请重新连接服务器');
      const id = kind === 'person' ? personId : itemId;
      if (!id) throw new Error('缺少详情 ID');
      const [detail, result] = await Promise.all([
        api.getItem(id),
        kind === 'person' ? api.getPersonItems(id) :
          kind === 'similar' ? api.getSimilar(id, null) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setSource(detail);
      setItems(result?.Items ?? []);
      setTotal(result?.TotalRecordCount ?? detail.People?.length ?? 0);
    })().catch((e) => {
      if (!cancelled) setError(String(e));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [api, itemId, personId, kind, retry]);

  // A separate effect cancels pagination responses when navigating to another person.
  useEffect(() => {
    if (!loadingMore || !api || !personId || kind !== 'person') return;
    let cancelled = false;
    api.getPersonItems(personId, items.length).then((result) => {
      if (cancelled) return;
      setItems((previous) => [...previous, ...result.Items]);
      setTotal(result.Items.length ? result.TotalRecordCount : items.length);
    }).catch((e) => {
      if (!cancelled) setMoreError(String(e));
    }).finally(() => {
      if (!cancelled) setLoadingMore(false);
    });
    return () => { cancelled = true; };
    // The page offset is captured when loadingMore becomes true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, personId, kind, loadingMore]);

  const title = kind === 'cast' ? '演职人员' : kind === 'similar' ? '类似作品' : '参演及参与作品';
  const openItem = (item: BaseItem) => {
    if (item.Type === 'Episode') navigate(`/server/${serverId}/episode/${item.Id}`);
    else navigate(`/server/${serverId}/${item.Type === 'Series' ? 'series' : 'movie'}/${item.Id}`);
  };

  return (
    <div className="h-full overflow-y-auto px-8 pb-10">
      <div className="flex min-h-12 items-center gap-2">
        <button onClick={() => navigate(-1)} title="返回" className="rounded-full p-1.5 hover:bg-black/5">
          <IconChevronLeft size={18} />
        </button>
        <h1 className="text-[15px] font-semibold">{source?.Name ? `${source.Name} · ` : ''}{title}{showCount && !loading ? `（${total}）` : ''}</h1>
      </div>
      {loading ? <Spinner label="正在加载…" /> : error ? (
        <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />
      ) : api && source ? (
        <>
          {kind === 'person' && (
            <div className="my-5 flex items-start gap-5">
              {api.posterUrl(source, 300) && <img src={api.posterUrl(source, 300)!} alt={source.Name} className="h-40 w-28 rounded-xl object-cover" />}
              <div><h2 className="text-2xl font-semibold">{source.Name}</h2>
                {source.Overview && <p className="mt-3 max-w-3xl whitespace-pre-line text-[13px] leading-relaxed text-gray-600">{source.Overview}</p>}
              </div>
            </div>
          )}
          {kind === 'cast' ? (
            <CastRow api={api} people={source.People ?? []} grid onPersonClick={(person) => navigate(`/server/${serverId}/person/${person.Id}`)} />
          ) : items.length ? (
            <div className="mt-4 flex flex-wrap gap-4">
              {orderMediaItems(items, foldersFirst).map((item) => <PosterCard key={item.Id} api={api} item={item} onClick={() => openItem(item)} />)}
            </div>
          ) : <EmptyState title="暂无作品" hint="服务器媒体库中暂无可显示的作品。" />}
          {kind === 'person' && items.length < total && (
            <div className="mt-6 text-center">
              {moreError && <p className="mb-2 text-sm text-red-500">{moreError}</p>}
              <button disabled={loadingMore} onClick={() => { setMoreError(''); setLoadingMore(true); }}
                className="rounded-lg bg-white px-5 py-2 text-sm shadow-card disabled:opacity-50">
                {loadingMore ? '正在加载…' : `加载更多（剩余 ${total - items.length}）`}
              </button>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
