import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BaseItem } from '../api/mediaServer';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';
import { orderMediaItems } from '../utils/listPresentation';
import PosterCard from '../components/PosterCard';
import { EmptyState, ErrorState, Spinner } from '../components/Feedback';
import { IconClose, IconSearch } from '../components/icons';
import LiquidGlass from '../components/LiquidGlass';

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
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced search
  useEffect(() => {
    const mySeq = ++seq.current;
    const q = term.trim();
    setError(null);
    if (!api || !q) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
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
          setError('搜索未完成，请检查服务器连接后重试。');
          setSearching(false);
        });
    }, 400);
    return () => {
      window.clearTimeout(t);
      if (seq.current === mySeq) seq.current++;
    };
  }, [term, api, retry]);

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
  } else if (error) {
    body = <ErrorState message={error} onRetry={() => setRetry((value) => value + 1)} />;
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
        <div role="status" className="mb-5 mt-8 text-[13px] font-medium text-text-secondary">
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
    <div className="h-full overflow-y-auto px-4 pb-10 sm:px-8">
      <h1 className="page-heading mt-8">搜索</h1>
      <p className="page-subtitle mt-2">寻找你想看的电影与剧集。</p>
      <LiquidGlass intensity="subtle" className="relative mt-7 w-full max-w-[640px] !rounded-full">
        <span className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-text-secondary">
          <IconSearch size={19} />
        </span>
        <input
          ref={inputRef}
          autoFocus
          aria-label="搜索媒体库"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="搜索电影、剧集…"
          className="h-12 w-full rounded-full bg-transparent pl-12 pr-12 text-[14px] text-text-primary outline-none placeholder:text-text-secondary focus-visible:ring-2 focus-visible:ring-accent/40"
        />
        {term && (
          <button onClick={() => { setTerm(''); inputRef.current?.focus(); }} aria-label="清除搜索" className="glass-icon-button absolute right-3 top-1/2 h-7 min-h-0 w-7 -translate-y-1/2 text-text-secondary">
            <IconClose size={14} />
          </button>
        )}
      </LiquidGlass>
      {body}
    </div>
  );
}
