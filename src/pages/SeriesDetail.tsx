import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BaseItem, formatTime, ticksToSeconds } from '../api/mediaServer';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';
import { mediaFolderDate, orderMediaItems } from '../utils/listPresentation';
import BackdropPage from '../components/BackdropPage';
import SectionRow from '../components/SectionRow';
import PosterCard from '../components/PosterCard';
import CastRow from '../components/CastRow';
import EpisodeRow from '../components/EpisodeRow';
import { Spinner, EmptyState, ErrorState } from '../components/Feedback';
import { IconChevronLeft, IconHome, IconPlay, IconHeart, IconCheck } from '../components/icons';

export default function SeriesDetailPage() {
  const { serverId, itemId } = useParams<{ serverId: string; itemId: string }>();
  const navigate = useNavigate();
  const showCount = useSettings((settings) => settings.showItemCountInTitle);
  const showFolderTime = useSettings((settings) => settings.showFolderTime);
  const foldersFirst = useSettings((settings) => settings.sortFoldersSeparately);
  const resumeFromLastPosition = useSettings((settings) => settings.resumeFromLastPosition);
  const api = useServers.getState().getApi(serverId);

  const [item, setItem] = useState<BaseItem | null>(null);
  const [similar, setSimilar] = useState<BaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const [seasons, setSeasons] = useState<BaseItem[]>([]);
  const [seasonId, setSeasonId] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<BaseItem[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [nextEp, setNextEp] = useState<BaseItem | null>(null);

  // Load series item + similar
  useEffect(() => {
    if (!api || !itemId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNextEp(null);
    setSeasons([]);
    setSeasonId(null);
    setEpisodes([]);
    (async () => {
      const it = await api.getItem(itemId);
      if (cancelled) return;
      setItem(it);
      try {
        const sim = await api.getSimilar(itemId, 12);
        if (!cancelled) setSimilar(sim.Items ?? []);
      } catch {
        if (!cancelled) setSimilar([]);
      }
    })()
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, itemId, tick]);

  // Load seasons, pick default (first non-special, else first)
  useEffect(() => {
    if (!api || !itemId) return;
    let cancelled = false;
    (async () => {
      const res = await api.getSeasons(itemId);
      if (cancelled) return;
      const list = res.Items ?? [];
      setSeasons(list);
      const def = list.find((s) => s.IndexNumber !== 0) ?? list[0];
      if (def) setSeasonId(def.Id);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, itemId, tick]);

  // Load episodes for the selected season; derive the "next episode" from the default season
  useEffect(() => {
    if (!api || !itemId || !seasonId) return;
    let cancelled = false;
    setEpisodesLoading(true);
    (async () => {
      const res = await api.getEpisodes(itemId, seasonId);
      if (cancelled) return;
      const eps = res.Items ?? [];
      setEpisodes(eps);
      setNextEp(
        (prev) =>
          prev ??
          eps.find((e) => (e.UserData?.PlaybackPositionTicks ?? 0) > 0) ??
          eps.find((e) => !e.UserData?.Played) ??
          eps[0] ??
          null,
      );
    })()
      .catch(() => {
        if (!cancelled) setEpisodes([]);
      })
      .finally(() => {
        if (!cancelled) setEpisodesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, itemId, seasonId]);

  if (!api) {
    return (
      <div className="h-full bg-page-bg">
        <EmptyState title="服务器不可用" hint="请返回服务器列表重新选择服务器。">
          <Link to="/servers" className="rounded-lg bg-accent px-4 py-1.5 text-[13px] text-white hover:opacity-90">
            返回服务器列表
          </Link>
        </EmptyState>
      </div>
    );
  }

  const header = (
    <div className="flex h-12 items-center px-4">
      <div className="flex items-center gap-2">
        <button
          onClick={() => navigate(-1)}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/60 text-gray-700 shadow-card backdrop-blur hover:bg-white"
          title="返回"
        >
          <IconChevronLeft size={16} />
        </button>
        <button
          onClick={() => navigate(`/server/${serverId}`)}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/60 text-gray-700 shadow-card backdrop-blur hover:bg-white"
          title="首页"
        >
          <IconHome size={15} />
        </button>
      </div>
      <div className="flex-1" />
    </div>
  );

  const togglePlayed = async () => {
    if (!item) return;
    const played = !!item.UserData?.Played;
    try {
      if (played) await api.markUnplayed(item.Id);
      else await api.markPlayed(item.Id);
      setItem({ ...item, UserData: { ...item.UserData, Played: !played } });
    } catch {
      /* ignore */
    }
  };

  const toggleFavorite = async () => {
    if (!item) return;
    const fav = !!item.UserData?.IsFavorite;
    try {
      await api.setFavorite(item.Id, !fav);
      setItem({ ...item, UserData: { ...item.UserData, IsFavorite: !fav } });
    } catch {
      /* ignore */
    }
  };

  const played = !!item?.UserData?.Played;
  const fav = !!item?.UserData?.IsFavorite;
  const nextPos = resumeFromLastPosition ? nextEp?.UserData?.PlaybackPositionTicks ?? 0 : 0;

  const play = () => {
    if (!nextEp) return;
    navigate(`/player/${serverId}/${nextEp.Id}${nextPos > 0 ? `?pos=${nextPos}` : ''}`);
  };

  const logo = item ? api.logoUrl(item) : null;

  const metaParts = item
    ? [
        item.Genres && item.Genres.length > 0 ? item.Genres.join(' · ') : null,
        showCount && item.ChildCount ? `共 ${item.ChildCount} 集` : null,
        item.PremiereDate ? `${new Date(item.PremiereDate).getFullYear()}年` : null,
      ].filter(Boolean)
    : [];

  const similarItems = orderMediaItems(similar.filter((s) => s.Type === 'Movie' || s.Type === 'Series'), foldersFirst);

  const seasonLabel = (s: BaseItem) => {
    const label = s.IndexNumber === 0 ? '特别篇' : `第 ${s.IndexNumber ?? s.Name} 季`;
    const date = showFolderTime ? mediaFolderDate(s) : '';
    return `${label}${showCount && s.ChildCount != null ? `（${s.ChildCount}）` : ''}${date ? ` · ${date}` : ''}`;
  };

  return (
    <BackdropPage api={api} item={item} header={header}>
      {loading ? (
        <Spinner label="加载剧集信息…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => setTick((t) => t + 1)} />
      ) : item ? (
        <div className="pt-6">
          {logo ? (
            <img src={logo} alt={item.Name} className="max-h-28 max-w-md object-contain" draggable={false} />
          ) : (
            <h1 className="text-4xl font-bold text-text-primary">{item.Name}</h1>
          )}

          {/* Action row */}
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={togglePlayed}
              title={played ? '标记未看' : '标记已看'}
              className={`flex h-11 w-11 items-center justify-center rounded-full shadow-card transition ${
                played ? 'bg-accent text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              <IconCheck size={18} />
            </button>
            <button
              onClick={toggleFavorite}
              title={fav ? '取消收藏' : '收藏'}
              className={`flex h-11 w-11 items-center justify-center rounded-full bg-white shadow-card transition hover:bg-gray-50 ${
                fav ? 'text-red-500' : 'text-gray-600'
              }`}
            >
              <IconHeart size={18} filled={fav} />
            </button>
            <button
              onClick={play}
              disabled={!nextEp}
              className="flex h-11 items-center gap-2 rounded-full bg-accent px-8 text-[14px] font-medium text-white shadow-card transition hover:opacity-90 disabled:opacity-50"
            >
              <IconPlay size={16} />
              播放
              {nextEp?.IndexNumber != null && (
                <span className="text-white/80">第{nextEp.IndexNumber}集</span>
              )}
              {nextPos > 0 && (
                <span className="text-white/80">{formatTime(ticksToSeconds(nextPos))}</span>
              )}
            </button>
          </div>

          {/* Meta line */}
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-gray-500">
            {item.CommunityRating != null && item.CommunityRating > 0 && (
              <span className="font-medium text-amber-500">★{item.CommunityRating.toFixed(1)}</span>
            )}
            {item.OfficialRating && (
              <span className="rounded border border-gray-300 px-1 py-px text-[10px] leading-tight">
                {item.OfficialRating}
              </span>
            )}
            {metaParts.map((p, i) => (
              <span key={i}>
                {i > 0 && <span className="mr-2 text-gray-300">·</span>}
                {p}
              </span>
            ))}
          </div>

          {/* Overview */}
          {item.Overview && (
            <p className="mt-3 line-clamp-4 max-w-4xl text-[13px] leading-relaxed text-gray-600">
              {item.Overview}
            </p>
          )}

          {/* Season selector + episodes */}
          {seasons.length > 0 && (
            <section className="mt-7">
              <div className="mb-2.5 flex items-center gap-2">
                {seasons.length <= 6 ? (
                  seasons.map((s) => (
                    <button
                      key={s.Id}
                      onClick={() => setSeasonId(s.Id)}
                      className={`rounded-full px-3 py-1 text-[13px] transition ${
                        s.Id === seasonId
                          ? 'bg-accent text-white'
                          : 'bg-white text-gray-600 shadow-card hover:bg-gray-50'
                      }`}
                    >
                      {seasonLabel(s)}
                    </button>
                  ))
                ) : (
                  <select
                    value={seasonId ?? ''}
                    onChange={(e) => setSeasonId(e.target.value)}
                    className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-[13px] text-gray-700"
                  >
                    {seasons.map((s) => (
                      <option key={s.Id} value={s.Id}>
                        {seasonLabel(s)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {episodesLoading ? (
                <Spinner />
              ) : episodes.length > 0 ? (
                <EpisodeRow api={api} episodes={episodes} serverId={serverId!} />
              ) : (
                <div className="py-6 text-[12px] text-gray-400">本季暂无剧集</div>
              )}
            </section>
          )}

          {/* Cast */}
          {item.People && item.People.length > 0 && (
            <SectionRow title="演职人员" count={item.People.length} onMore={() => navigate(`/server/${serverId}/item/${item.Id}/cast`)}>
              <CastRow api={api} people={item.People} onPersonClick={(person) => navigate(`/server/${serverId}/person/${person.Id}`)} />
            </SectionRow>
          )}

          {/* Similar */}
          {similarItems.length > 0 && (
            <SectionRow title="类似作品" count={similarItems.length} onMore={() => navigate(`/server/${serverId}/item/${item.Id}/similar`)}>
              {similarItems.map((s) => (
                <PosterCard
                  key={s.Id}
                  api={api}
                  item={s}
                  width={130}
                  onClick={() =>
                    navigate(
                      s.Type === 'Series'
                        ? `/server/${serverId}/series/${s.Id}`
                        : `/server/${serverId}/movie/${s.Id}`,
                    )
                  }
                />
              ))}
            </SectionRow>
          )}
        </div>
      ) : null}
    </BackdropPage>
  );
}
