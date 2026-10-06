import { useState } from 'react';
import { MediaServerApi, BaseItem, formatTime } from '../api/mediaServer';
import { useSettings } from '../store/settings';
import { isNewMedia, mediaHdrLabel, mediaListMetadata, mediaPreviewUrls, mediaVideoStream } from '../utils/listPresentation';
import { IconPlay } from './icons';

/** Poster card (2:3) for movies/series; thumb card (16:9) for episodes/resume items. */
export default function PosterCard({
  api,
  item,
  onClick,
  width = 150,
  landscape,
  progress,
  label,
  description,
  showRating,
}: {
  api: MediaServerApi;
  item: BaseItem;
  onClick?: () => void;
  width?: number;
  landscape?: boolean;
  /** 0..100 resume progress; overrides item.UserData percentage */
  progress?: number;
  label?: string;
  description?: string;
  showRating?: boolean;
}) {
  const settings = useSettings();
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const previews = mediaPreviewUrls(api, item, settings, !!landscape);
  const img = [previews.primary, previews.fallback].find((url) => url && !failedImages.includes(url));
  const metadata = mediaListMetadata(item, settings);
  const hdr = settings.showHdrBadge ? mediaHdrLabel(mediaVideoStream(item)) : '';
  const runtime = item.RunTimeTicks ?? item.MediaSources?.[0]?.RunTimeTicks;
  const position = item.UserData?.PlaybackPositionTicks ?? 0;
  const pct =
    progress ??
    (item.UserData?.PlayedPercentage && item.UserData.PlayedPercentage > 0
      ? item.UserData.PlayedPercentage
      : runtime && runtime > 0 && position > 0 ? position / runtime * 100 : null);

  const w = landscape ? Math.round(width * (16 / 9)) : width;
  const h = landscape ? width : Math.round(width * 1.5);

  const subtitle =
    item.Type === 'Episode' && item.SeriesName
      ? `${item.SeriesName}${item.IndexNumber != null ? ` · 第${item.IndexNumber}集` : ''}`
      : item.ProductionYear
        ? String(item.ProductionYear)
        : '';

  const remainingSec =
    landscape && settings.showMediaDuration && settings.showPlayProgress && runtime && position > 0
      ? Math.round((runtime - position) / 10_000_000)
      : null;

  return (
    <button
      onClick={onClick}
      className="group shrink-0 text-left"
      style={{ width: w }}
      title={item.Name}
    >
      <div
        className="relative overflow-hidden rounded-xl bg-gray-200 shadow-card transition-shadow group-hover:shadow-card-hover"
        style={{ width: w, height: h }}
      >
        {img ? (
          <img
            src={img}
            alt={item.Name}
            loading="lazy"
            className={`h-full w-full transition-transform duration-300 ${settings.thumbnailFill ? 'object-cover group-hover:scale-[1.04]' : 'object-contain'}`}
            onError={() => setFailedImages((previous) => [...previous, img])}
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-indigo-200 to-purple-200 text-2xl font-bold text-white/80">
            {item.Name?.slice(0, 1)}
          </div>
        )}

        {landscape && pct == null && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/25 group-hover:opacity-100">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-gray-800">
              <IconPlay size={16} />
            </span>
          </div>
        )}

        {landscape && remainingSec != null && remainingSec > 0 && (
          <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
            剩余 {formatTime(remainingSec)}
          </span>
        )}

        {settings.showPlayProgress && pct != null && pct > 0 && (
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/25">
            <div className="h-full bg-accent" style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
        )}

        {settings.showNewBadge && isNewMedia(item) && (
          <span title="最近 7 天添加且未播放" className="absolute left-1.5 top-1.5 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white">New</span>
        )}

        {hdr && <span className="absolute bottom-1.5 left-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white">{hdr}</span>}

        {showRating && item.CommunityRating != null && item.CommunityRating > 0 && !item.UserData?.Played && (
          <span className="absolute right-1.5 top-1.5 rounded bg-black/60 px-1 py-0.5 text-[10px] text-white">★{item.CommunityRating.toFixed(1)}</span>
        )}

        {item.UserData?.Played && (
          <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent p-1 text-white">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"><path d="m4 12.5 5 5L20 6.5" /></svg>
          </span>
        )}
      </div>
      <div className="mt-1.5 px-0.5">
        <div className="truncate text-[12px] font-medium text-text-primary">{label ?? item.Name}</div>
        {subtitle && <div className="truncate text-[11px] text-text-secondary">{subtitle}</div>}
        {metadata.length > 0 && <div className="mt-0.5 flex flex-wrap gap-x-1.5 gap-y-0.5 text-[10px] text-text-secondary">{metadata.map((value) => <span key={value}>{value}</span>)}</div>}
        {description && <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-text-secondary">{description}</div>}
      </div>
    </button>
  );
}
