import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BaseItem } from '../api/mediaServer';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';
import { orderMediaItems } from '../utils/listPresentation';
import PosterCard from '../components/PosterCard';
import { EmptyState, ErrorState, Spinner } from '../components/Feedback';
import { IconHistory } from '../components/icons';

interface Group {
  label: string;
  items: BaseItem[];
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '未知日期';
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export default function HistoryPage() {
  const navigate = useNavigate();
  const showCount = useSettings((settings) => settings.showItemCountInTitle);
  const foldersFirst = useSettings((settings) => settings.sortFoldersSeparately);
  const activeServerId = useServers((s) => s.activeServerId);
  const api = useMemo(
    () => (activeServerId ? useServers.getState().getApi(activeServerId) : null),
    [activeServerId],
  );

  const [items, setItems] = useState<BaseItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    setItems(null);
    setError(null);
    api
      .getPlayedItems(60)
      .then((r) => setItems(r.Items))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [api]);

  const groups = useMemo<Group[]>(() => {
    if (!items || items.length === 0) return [];
    const lastPlayed = (i: BaseItem) =>
      (i.UserData as unknown as { LastPlayedDate?: string } | undefined)?.LastPlayedDate;
    if (!items.some((i) => lastPlayed(i))) {
      return [{ label: '最近播放', items }];
    }
    const map = new Map<string, BaseItem[]>();
    for (const i of items) {
      const d = lastPlayed(i);
      const label = d ? dayLabel(d) : '未知日期';
      const arr = map.get(label);
      if (arr) arr.push(i);
      else map.set(label, [i]);
    }
    return [...map.entries()].map(([label, list]) => ({ label, items: list }));
  }, [items]);

  const open = (item: BaseItem) => {
    if (!activeServerId) return;
    if (item.Type === 'Episode') {
      navigate(`/player/${activeServerId}/${item.Id}`);
    } else {
      navigate(`/server/${activeServerId}/movie/${item.Id}`);
    }
  };

  let body: React.ReactNode;
  if (!api) {
    body = <EmptyState icon={<IconHistory size={40} />} title="请先添加并选择服务器" />;
  } else if (error) {
    body = <ErrorState message={error} />;
  } else if (items == null) {
    body = <Spinner label="加载中…" />;
  } else if (groups.length === 0) {
    body = <EmptyState icon={<IconHistory size={40} />} title="暂无播放记录" />;
  } else {
    body = (
      <div className="mt-6 flex flex-col gap-7">
        {groups.map((g) => (
          <section key={g.label}>
            <div className="mb-2 text-[13px] text-gray-400">{g.label}</div>
            <div className="flex flex-wrap gap-4">
              {orderMediaItems(g.items, foldersFirst).map((item) => (
                <PosterCard
                  key={item.Id}
                  api={api}
                  item={item}
                  landscape
                  width={120}
                  onClick={() => open(item)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-6 pb-10">
      <h1 className="mt-6 text-xl font-semibold text-text-primary">记录{showCount && items ? `（${items.length}）` : ''}</h1>
      {body}
    </div>
  );
}
