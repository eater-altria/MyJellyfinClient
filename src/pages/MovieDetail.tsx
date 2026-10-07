import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  BaseItem,
  formatDuration,
  formatSize,
  formatTime,
  ticksToSeconds,
} from '../api/mediaServer';
import { useServers } from '../store/servers';
import { useSettings } from '../store/settings';
import BackdropPage from '../components/BackdropPage';
import SectionRow from '../components/SectionRow';
import PosterCard from '../components/PosterCard';
import CastRow from '../components/CastRow';
import MediaInfo from '../components/MediaInfo';
import LiquidGlass from '../components/LiquidGlass';
import { Spinner, EmptyState, ErrorState } from '../components/Feedback';
import { IconChevronLeft, IconHome, IconPlay, IconHeart, IconCheck } from '../components/icons';

export default function MovieDetailPage() {
  const { serverId, itemId } = useParams<{ serverId: string; itemId: string }>();
  const navigate = useNavigate();
  const resumeFromLastPosition = useSettings((s) => s.resumeFromLastPosition);
  const api = useServers.getState().getApi(serverId);
  const serverName = useServers((state) => state.servers.find((s) => s.id === serverId)?.name);

  const [item, setItem] = useState<BaseItem | null>(null);
  const [similar, setSimilar] = useState<BaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!api || !itemId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
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
  const pos = resumeFromLastPosition ? item?.UserData?.PlaybackPositionTicks ?? 0 : 0;

  const play = () => {
    if (!item) return;
    navigate(`/player/${serverId}/${item.Id}${pos > 0 ? `?pos=${pos}` : ''}`);
  };

  const isEpisode = item?.Type === 'Episode';
  const logo = item && !isEpisode ? api.logoUrl(item) : null;

  // Meta line 2: duration · premiere date · resolution · codec · size
  const ms = item?.MediaSources?.[0];
  const video = ms?.MediaStreams?.find((s) => s.Type === 'Video');
  const resLabel = video?.Height
    ? video.Height >= 2160
      ? '4K'
      : video.Height >= 1080
        ? '1080P'
        : video.Height >= 720
          ? '720P'
          : null
    : null;
  const metaLine2 = item
    ? [
        formatDuration(item.RunTimeTicks),
        item.PremiereDate ? new Date(item.PremiereDate).toLocaleDateString('zh-CN') : null,
        resLabel,
        video?.Codec ? video.Codec.toUpperCase() : null,
        ms?.Size ? formatSize(ms.Size) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  const similarItems = similar.filter((s) => s.Type === 'Movie' || s.Type === 'Series');

  return (
    <BackdropPage api={api} item={item} header={header}>
      {loading ? (
        <Spinner label="加载文件信息…" />
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

          {isEpisode && <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-gray-500">
            {item.SeriesId && <Link to={`/server/${serverId}/series/${item.SeriesId}`} className="text-accent hover:underline">{item.SeriesName ?? '返回剧集'}</Link>}
            {item.ParentIndexNumber != null && <span>{item.ParentIndexNumber === 0 ? '特别篇' : `第 ${item.ParentIndexNumber} 季`}</span>}
            {item.IndexNumber != null && <span>第 {item.IndexNumber} 集</span>}
          </div>}

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
              className="glass-button-primary flex min-h-11 items-center gap-2 px-7 text-[14px] font-medium"
            >
              <IconPlay size={16} />
              播放
              {pos > 0 && <span className="text-white/80">{formatTime(ticksToSeconds(pos))}</span>}
            </button>
          </div>

          {/* Meta line 1 */}
          <div className="mt-5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] text-text-secondary">
            {item.CommunityRating != null && item.CommunityRating > 0 && (
              <span className="font-medium text-amber-500">★{item.CommunityRating.toFixed(1)}</span>
            )}
            {item.CriticRating != null && <span>🍅{Math.round(item.CriticRating)}%</span>}
            {item.OfficialRating && (
              <span className="glass-badge text-[10px] leading-tight">
                {item.OfficialRating}
              </span>
            )}
            {item.Genres && item.Genres.length > 0 && <span>{item.Genres.join(' · ')}</span>}
          </div>
          {metaLine2 && <div className="mt-2 text-[12px] text-text-secondary">{metaLine2}</div>}

          {/* Overview */}
          {item.Overview && (
            <p className="mt-4 line-clamp-4 max-w-4xl text-[13px] leading-7 text-text-primary/80">
              {item.Overview}
            </p>
          )}

          </LiquidGlass>

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
          <MediaInfo key={item.Id} item={item} serverName={serverName} />
        </div>
      ) : null}
    </BackdropPage>
  );
}
