import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BaseItem } from '../api/mediaServer';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';
import { orderMediaItems } from '../utils/listPresentation';
import PosterCard from '../components/PosterCard';
import { EmptyState, Spinner } from '../components/Feedback';
import { IconSearch } from '../components/icons';

export default function SearchPage() {
  const navigate = useNavigate();
  const showCount = useSettings((settings) => settings.showItemCountInTitle);
  const foldersFirst = useSettings((settings) => settings.sortFoldersSeparately);
  const activeServerId = useServers((s) => s.activeServerId);
  const api = useMemo(
    () => (activeServerId ? useServers.getState().getApi(activeServerId) : null),
    [activeServerId],
  );

  const [term, setTerm] = useState('');
  const [results, setResults] = useState<BaseItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  // Debounced search
  useEffect(() => {
    const q = term.trim();
    if (!api || !q) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const mySeq = ++seq.current;
    const t = window.setTimeout(() => {
      api
        .search(q)
        .then((r) => {
          if (seq.current !== mySeq) return;
          setResults(r.Items);
          setSearching(false);
        })
        .catch(() => {
          if (seq.current !== mySeq) return;
          setResults([]);
          setSearching(false);
        });
    }, 400);
    return () => window.clearTimeout(t);
  }, [term, api]);

  const open = (item: BaseItem) => {
    if (!activeServerId) return;
    if (item.Type === 'Movie') {
      navigate(`/server/${activeServerId}/movie/${item.Id}`);
    } else if (item.Type === 'Series') {
      navigate(`/server/${activeServerId}/series/${item.Id}`);
    } else if (item.Type === 'Episode') {
      navigate(`/server/${activeServerId}/episode/${item.Id}`);
    }
  };

  let body: React.ReactNode;
  if (!api) {
    body = <EmptyState icon={<IconSearch size={40} />} title="请先添加并选择服务器" />;
  } else if (!term.trim()) {
    body = (
      <EmptyState
        icon={<IconSearch size={40} />}
        title="搜索你的媒体库"
        hint="输入电影、剧集或单集名称开始搜索"
      />
    );
  } else if (searching && results == null) {
    body = (
      <div className="mt-10">
        <Spinner label="搜索中…" />
      </div>
    );
  } else if (results && results.length === 0) {
    body = <EmptyState icon={<IconSearch size={40} />} title="没有找到相关内容" />;
  } else if (results) {
    body = (
      <>
        <div className="mb-3 mt-6 text-[13px] text-gray-400">
          {searching ? '搜索中…' : showCount ? `搜索结果（${results.length}）` : '搜索结果'}
        </div>
        <div className="flex flex-wrap gap-4">
          {orderMediaItems(results, foldersFirst).map((item) =>
            item.Type === 'Episode' ? (
              <PosterCard
                key={item.Id}
                api={api}
                item={item}
                landscape
                width={110}
                onClick={() => open(item)}
              />
            ) : (
              <PosterCard key={item.Id} api={api} item={item} width={130} onClick={() => open(item)} />
            ),
          )}
        </div>
      </>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-6 pb-10">
      <div className="relative mx-auto mt-6 w-full max-w-lg">
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400">
          <IconSearch size={16} />
        </span>
        <input
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="搜索电影、剧集…"
          className="h-10 w-full rounded-full bg-white pl-10 pr-4 text-[13px] text-text-primary shadow-card outline-none placeholder:text-gray-400"
        />
      </div>
      {body}
    </div>
  );
}
