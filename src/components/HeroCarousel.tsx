import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MediaServerApi, BaseItem } from '../api/mediaServer';
import { IconChevronLeft, IconChevronRight, IconSearch } from './icons';
import LiquidGlass from './LiquidGlass';

/** Full-width cross-fading hero carousel fed by items with backdrops. */
export default function HeroCarousel({
  api,
  items,
  serverId,
  onCurrentItemChange,
}: {
  api: MediaServerApi;
  items: BaseItem[];
  serverId: string;
  onCurrentItemChange?: (item: BaseItem | null) => void;
}) {
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  const count = items.length;
  const safeIndex = count > 0 ? index % count : 0;
  const current = count > 0 ? items[safeIndex] : null;
  // Keep all items navigable without mounting/downloading every backdrop.
  const visibleIndexes = [...new Set([safeIndex, (safeIndex + count - 1) % count, (safeIndex + 1) % count])];
  const dotStart = Math.max(0, Math.min(count - 7, safeIndex - 3));
  const dotIndexes = Array.from({ length: Math.min(7, count) }, (_, i) => dotStart + i);

  const go = useCallback(
    (dir: number) => {
      if (count < 2) return;
      setIndex((i) => (i + dir + count) % count);
    },
    [count],
  );

  useEffect(() => {
    if (paused || count < 2) return;
    const t = setInterval(() => go(1), 7000);
    return () => clearInterval(t);
  }, [paused, count, go]);

  // Keep index in range when the item list changes
  useEffect(() => {
    if (count > 0 && index >= count) setIndex(0);
  }, [count, index]);

  useEffect(() => { onCurrentItemChange?.(current); }, [current, onCurrentItemChange]);

  if (!current) return null;

  const openDetail = () => {
    if (current.Type === 'Series') navigate(`/server/${serverId}/series/${current.Id}`);
    else if (current.Type === 'Movie') navigate(`/server/${serverId}/movie/${current.Id}`);
  };

  const logo = api.logoUrl(current);

  return (
    <div
      className="relative aspect-video min-h-[240px] w-full overflow-hidden rounded-[28px] bg-slate-900 shadow-card ring-1 ring-white/70"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Cross-fading backdrops */}
      {visibleIndexes.map(i => {
        const item = items[i];
        const url = api.backdropUrl(item, 1920);
        if (!url) return null;
        return (
          <img
            key={item.Id}
            src={url}
            alt={item.Name}
            draggable={false}
            className={`absolute inset-0 h-full w-full object-contain object-center transition-opacity duration-700 ${
              i === safeIndex ? 'opacity-100' : 'opacity-0'
            }`}
          />
        );
      })}

      <button
        onClick={openDetail}
        aria-label={`查看${current.Name}详情`}
        className="absolute inset-0 rounded-[28px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-white"
      />

      {/* Bottom gradient overlay */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/50 via-black/10 to-transparent" />

      {/* Search and carousel navigation share the same floating controls. */}
      <div className="absolute right-5 top-5 z-20 flex items-center gap-2">
        <button type="button"
          onClick={event => {
            event.stopPropagation();
            navigate(`/search?${new URLSearchParams({ serverId })}`);
          }}
          aria-label="搜索当前服务器媒体库" title="搜索"
          className="glass-icon-button glass-dark h-10 w-10 text-white">
          <IconSearch size={18} />
        </button>
        {count > 1 && <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              go(-1);
            }}
            aria-label="上一张预览"
            className="glass-icon-button glass-dark h-10 w-10 text-white"
          >
            <IconChevronLeft size={18} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              go(1);
            }}
            aria-label="下一张预览"
            className="glass-icon-button glass-dark h-10 w-10 text-white"
          >
            <IconChevronRight size={18} />
          </button>
        </>}
      </div>

      {/* The scenic image remains dominant; the caption floats on a glass surface. */}
      <LiquidGlass tone="dark" intensity="subtle" className="pointer-events-none absolute bottom-12 left-5 right-5 flex flex-col items-start gap-2 rounded-[24px] p-4 text-left sm:left-6 sm:right-auto sm:max-w-[62%] sm:gap-3 sm:p-5">
        {logo ? (
          <img
            src={logo}
            alt={current.Name}
            draggable={false}
            className="max-h-14 max-w-full object-contain drop-shadow-lg sm:max-h-20"
          />
        ) : (
          <h1 className="line-clamp-2 text-xl font-semibold tracking-tight text-white drop-shadow sm:text-3xl">{current.Name}</h1>
        )}

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-white/90">
          {current.CommunityRating != null && (
            <span className="text-amber-300">★ {current.CommunityRating.toFixed(1)}</span>
          )}
          {current.ProductionYear != null && <span>{current.ProductionYear}</span>}
          {current.OfficialRating && (
            <span className="rounded-md border border-white/30 px-1.5 py-0.5 text-[10px] leading-4">
              {current.OfficialRating}
            </span>
          )}
          {current.Genres && current.Genres.length > 0 && (
            <span>{current.Genres.slice(0, 2).join(' · ')}</span>
          )}
        </div>

        {current.Overview && (
          <p className="hidden line-clamp-2 max-w-2xl text-[12px] leading-relaxed text-white/85 sm:[display:-webkit-box]">{current.Overview}</p>
        )}
      </LiquidGlass>

      {/* Dot indicators */}
      {count > 1 && (
        <div className="glass-surface glass-dark absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center justify-center gap-0.5 rounded-full px-2">
          {dotIndexes.map(i => (
            <button
              key={items[i].Id}
              aria-label={`查看第 ${i + 1} 张预览`}
              onClick={(e) => {
                e.stopPropagation();
                setIndex(i);
              }}
              aria-current={i === safeIndex ? 'true' : undefined}
              className="flex h-6 w-6 items-center justify-center rounded-full"
            >
              <span className={`h-1.5 rounded-full transition-all ${i === safeIndex ? 'w-5 bg-white' : 'w-1.5 bg-white/45'}`} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
