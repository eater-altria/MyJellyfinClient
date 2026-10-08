import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BaseItem, formatTime, ticksToSeconds } from '../api/mediaServer';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';
import { mediaFolderDate, orderMediaItems } from '../utils/listPresentation';
import BackdropPage from '../components/BackdropPage';
import SectionRow from '../components/SectionRow';
import PosterCard from '../components/PosterCard';
import CastRow from '../components/CastRow';
import EpisodeRow from '../components/EpisodeRow';
import ListNavigation from '../components/ListNavigation';
import LiquidGlass from '../components/LiquidGlass';
import { Spinner, EmptyState, ErrorState } from '../components/Feedback';
import { IconChevronLeft, IconHome, IconPlay, IconHeart, IconCheck } from '../components/icons';

export default function SeriesDetailPage() {
  const { serverId, itemId } = useParams<{ serverId: string; itemId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
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
  const selectedSeason = seasons.find((season) => season.Id === searchParams.get('seasonId'))
    ?? seasons.find((season) => season.IndexNumber !== 0) ?? seasons[0];
  const seasonId = selectedSeason?.Id;
  const [episodes, setEpisodes] = useState<BaseItem[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [episodesError, setEpisodesError] = useState('');
  const [episodesRetry, setEpisodesRetry] = useState(0);
  const episodeScroller = useRef<HTMLDivElement>(null);
  const [nextEp, setNextEp] = useState<BaseItem | null>(null);

  // Load series item + similar
  useEffect(() => {
    if (!api || !itemId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNextEp(null);
    setSeasons([]);
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
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, itemId, tick]);

  // Load episodes for the selected season; derive the "next episode" from the default season
  useEffect(() => {
    if (!api || !itemId || !seasonId) return;
    let cancelled = false;
    const controller = new AbortController();
    setEpisodesLoading(true);
    setEpisodes([]);
    setEpisodesError('');
    (async () => {
      const res = await api.getEpisodes(itemId, seasonId, controller.signal);
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
        if (!cancelled) setEpisodesError('本季剧集加载失败，请重试。');
      })
      .finally(() => {
        if (!cancelled) setEpisodesLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, itemId, seasonId, episodesRetry]);

  if (!api) {
    return (
      <div className="h-full bg-page-bg">
        <EmptyState title="服务器不可用" hint="请返回服务器列表重新选择服务器。">
          <Link to="/servers" className="glass-button-primary px-5 py-2.5 text-[13px]">
            返回服务器列表
          </Link>
        </EmptyState>
      </div>
    );
  }

  const header = (
    <div className="flex h-20 items-center px-5 lg:px-8">
      <LiquidGlass intensity="subtle" className="flex items-center gap-1 rounded-full p-1.5">
        <button
          onClick={() => navigate(-1)}
          className="glass-icon-button h-9 w-9 text-text-primary"
          title="返回"
          aria-label="返回"
        >
          <IconChevronLeft size={16} />
        </button>
        <button
          onClick={() => navigate(`/server/${serverId}`)}
          className="glass-icon-button h-9 w-9 text-text-primary"
          title="首页"
          aria-label="首页"
        >
          <IconHome size={15} />
        </button>
      </LiquidGlass>
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

  const selectSeason = (id: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('seasonId', id);
    setSearchParams(params, { replace: true });
  };

  return (
    <BackdropPage api={api} item={item} header={header}>
      {loading ? (
        <Spinner label="加载剧集信息…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => setTick((t) => t + 1)} />
      ) : item ? (
        <div className="pt-2">
          <LiquidGlass intensity="subtle" className="max-w-4xl rounded-[28px] p-6 sm:p-7">
          {logo ? (
            <img src={logo} alt={item.Name} className="max-h-28 max-w-full object-contain sm:max-w-md" draggable={false} />
          ) : (
            <h1 className="break-words text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">{item.Name}</h1>
          )}

          {/* Action row */}
          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            <button
              onClick={togglePlayed}
              title={played ? '标记未看' : '标记已看'}
              aria-label={played ? '标记未看' : '标记已看'}
              aria-pressed={played}
              className={`glass-icon-button h-11 w-11 ${
                played ? 'bg-accent text-white' : 'text-text-secondary'
              }`}
            >
              <IconCheck size={18} />
            </button>
            <button
              onClick={toggleFavorite}
              title={fav ? '取消收藏' : '收藏'}
              aria-label={fav ? '取消收藏' : '收藏'}
              aria-pressed={fav}
              className={`glass-icon-button h-11 w-11 ${
                fav ? 'text-red-500' : 'text-text-secondary'
              }`}
            >
              <IconHeart size={18} filled={fav} />
            </button>
            <button
              onClick={play}
              disabled={!nextEp}
              className="glass-button-primary flex min-h-11 items-center gap-2 px-7 text-[14px] font-medium disabled:opacity-50"
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
          <div className="mt-5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] text-text-secondary">
            {item.CommunityRating != null && item.CommunityRating > 0 && (
              <span className="font-medium text-amber-500">★{item.CommunityRating.toFixed(1)}</span>
            )}
            {item.OfficialRating && (
              <span className="glass-badge text-[10px] leading-tight">
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
            <p className="mt-4 line-clamp-4 max-w-4xl text-[13px] leading-7 text-text-primary/80">
              {item.Overview}
            </p>
          )}

          </LiquidGlass>

          {/* Season selector + episodes */}
          {seasons.length > 0 && (
            <section className="mt-8">
              <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  {seasons.length <= 6 ? (
                    seasons.map((s) => (
                      <button
                        key={s.Id}
                        onClick={() => selectSeason(s.Id)}
                        aria-pressed={s.Id === seasonId}
                        className={`glass-button max-w-full break-words px-4 py-2 text-[13px] ${
                          s.Id === seasonId
                            ? 'bg-accent text-white'
                            : 'text-text-secondary'
                        }`}
                      >
                        {seasonLabel(s)}
                      </button>
                    ))
                  ) : (
                    <select
                      value={seasonId ?? ''}
                      aria-label="选择季"
                      onChange={(e) => selectSeason(e.target.value)}
                      className="glass-input max-w-full px-4 py-2 text-[13px] text-text-primary"
                    >
                      {seasons.map((s) => (
                        <option key={s.Id} value={s.Id}>
                          {seasonLabel(s)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <ListNavigation title="剧集" scroller={episodeScroller} alwaysShowArrows
                  scrollDisabled={episodesLoading || episodes.length === 0}
                  onMore={seasonId ? () => navigate(`/server/${serverId}/series/${item.Id}/season/${seasonId}/episodes`) : undefined} />
              </div>
              {episodesLoading ? (
                <Spinner />
              ) : episodesError ? (
                <ErrorState message={episodesError} onRetry={() => setEpisodesRetry((value) => value + 1)} />
              ) : episodes.length > 0 ? (
                <EpisodeRow key={`${itemId}:${seasonId}`} ref={episodeScroller} api={api} episodes={episodes} serverId={serverId!} />
              ) : (
                <div className="py-6 text-[12px] text-gray-400">本季暂无剧集</div>
              )}
            </section>
          )}

          {/* Cast */}
          {item.People && item.People.length > 0 && (
            <SectionRow title="演职人员" count={item.People.length} glass onMore={() => navigate(`/server/${serverId}/item/${item.Id}/cast`)}>
              <CastRow api={api} people={item.People} onPersonClick={(person) => navigate(`/server/${serverId}/person/${person.Id}`)} />
            </SectionRow>
          )}

          {/* Similar */}
          {similarItems.length > 0 && (
            <SectionRow title="类似作品" count={similarItems.length} glass onMore={() => navigate(`/server/${serverId}/item/${item.Id}/similar`)}>
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
