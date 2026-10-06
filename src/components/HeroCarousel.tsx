import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MediaServerApi, BaseItem } from '../api/mediaServer';
import { IconChevronLeft, IconChevronRight } from './icons';

/** Full-width cross-fading hero carousel fed by items with backdrops. */
export default function HeroCarousel({
  api,
  items,
  serverId,
}: {
  api: MediaServerApi;
  items: BaseItem[];
  serverId: string;
}) {
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  const count = items.length;
  const safeIndex = count > 0 ? index % count : 0;
  const current = count > 0 ? items[safeIndex] : null;

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

  if (!current) return null;

  const openDetail = () => {
    if (current.Type === 'Series') navigate(`/server/${serverId}/series/${current.Id}`);
    else if (current.Type === 'Movie') navigate(`/server/${serverId}/movie/${current.Id}`);
  };

  const logo = api.logoUrl(current);

  return (
    <div
      className="relative aspect-video w-full cursor-pointer overflow-hidden rounded-2xl bg-gray-900"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onClick={openDetail}
    >
      {/* Cross-fading backdrops */}
      {items.map((item, i) => {
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

      {/* Bottom gradient overlay */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/60 via-black/25 to-transparent" />

      {/* Chevron buttons */}
      {count > 1 && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              go(-1);
            }}
            className="absolute left-4 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/20 text-white backdrop-blur transition hover:bg-white/40"
          >
            <IconChevronLeft size={18} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              go(1);
            }}
            className="absolute right-4 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/20 text-white backdrop-blur transition hover:bg-white/40"
          >
            <IconChevronRight size={18} />
          </button>
        </>
      )}

      {/* Bottom centered content */}
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 px-6 pb-8 text-center sm:gap-2.5 sm:px-10 sm:pb-9">
        {logo ? (
          <img
            src={logo}
            alt={current.Name}
            draggable={false}
            className="max-h-16 max-w-[70%] object-contain sm:max-h-24 drop-shadow-lg"
          />
        ) : (
          <h1 className="line-clamp-2 text-xl font-bold text-white drop-shadow sm:text-3xl">{current.Name}</h1>
        )}

        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[13px] text-white/90">
          {current.CommunityRating != null && (
            <span className="text-amber-300">★ {current.CommunityRating.toFixed(1)}</span>
          )}
          {current.ProductionYear != null && <span>{current.ProductionYear}</span>}
          {current.OfficialRating && (
            <span className="rounded border border-white/50 px-1 text-xs leading-4">
              {current.OfficialRating}
            </span>
          )}
          {current.Genres && current.Genres.length > 0 && (
            <span>{current.Genres.slice(0, 2).join(' · ')}</span>
          )}
        </div>

        {current.Overview && (
          <p className="hidden line-clamp-2 max-w-2xl text-sm text-white/80 sm:[display:-webkit-box]">{current.Overview}</p>
        )}
      </div>

      {/* Dot indicators */}
      {count > 1 && (
        <div className="absolute inset-x-0 bottom-3 flex items-center justify-center gap-1.5">
          {items.map((item, i) => (
            <button
              key={item.Id}
              onClick={(e) => {
                e.stopPropagation();
                setIndex(i);
              }}
              className={`h-1.5 rounded-full transition-all ${
                i === safeIndex ? 'w-5 bg-white' : 'w-1.5 bg-white/40 hover:bg-white/70'
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
