import { useEffect, useState } from 'react';
import { MediaServerApi, BaseItem, formatTime } from '../api/mediaServer';
import { useSettings } from '../store/settings';
import { isNewMedia, mediaHdrLabel, mediaListMetadata, mediaPreviewUrls, mediaVideoStream } from '../utils/listPresentation';
import { subscribeBrowseUserData } from '../utils/browseHistory';
import { contextMenuProps } from './ContextMenu';
import { IconCheck, IconStar, IconPlay } from './icons';

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
  contextActions,
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
  contextActions?: ReturnType<typeof contextMenuProps>;
}) {
  const settings = useSettings();
  const [userData, setUserData] = useState(item.UserData);
  useEffect(() => setUserData(item.UserData), [api, item]);
  useEffect(() => subscribeBrowseUserData((owner, id, fields) => {
    if (owner === api && id === item.Id) setUserData(previous => ({ ...previous, ...fields }));
  }), [api, item.Id]);
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const previews = mediaPreviewUrls(api, item, settings, !!landscape);
  const img = [previews.primary, previews.fallback].find((url) => url && !failedImages.includes(url));
  const metadata = mediaListMetadata(item, settings);
  const hdr = settings.showHdrBadge ? mediaHdrLabel(mediaVideoStream(item)) : '';
  const runtime = item.RunTimeTicks ?? item.MediaSources?.[0]?.RunTimeTicks;
  const position = userData?.PlaybackPositionTicks ?? 0;
  const pct =
    progress ??
    (userData?.PlayedPercentage && userData.PlayedPercentage > 0
      ? userData.PlayedPercentage
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
      {...contextActions}
      onClick={onClick}
      type="button"
      className="media-card group flex shrink-0 flex-col rounded-[20px] text-left"
      style={{ width: w }}
      title={item.Name}
    >
      <div
        className="relative overflow-hidden rounded-[18px] bg-white/40 shadow-card ring-1 ring-white/65 transition-shadow group-hover:shadow-card-hover"
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
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-sky-100 via-white/60 to-indigo-100 text-3xl font-medium text-slate-400">
            {item.Name?.slice(0, 1)}
          </div>
        )}

        {landscape && pct == null && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/20 group-hover:opacity-100 group-focus-visible:bg-black/20 group-focus-visible:opacity-100">
            <span className="glass-surface flex h-11 w-11 items-center justify-center rounded-full text-text-primary">
              <IconPlay size={16} />
            </span>
          </div>
        )}

        {landscape && !userData?.Played && remainingSec != null && remainingSec > 0 && (
          <span className="glass-badge glass-dark absolute bottom-2 right-2 text-[10px] text-white">
            剩余 {formatTime(remainingSec)}
          </span>
        )}

        {settings.showPlayProgress && pct != null && pct > 0 && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/20">
            <div className="h-full bg-accent" style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
        )}

        {settings.showNewBadge && isNewMedia({ ...item, UserData: userData }) && (
          <span title="最近 7 天添加且未播放" className={`glass-badge absolute top-2 bg-accent text-[10px] font-semibold text-white ${userData?.IsFavorite ? 'left-10' : 'left-2'}`}>New</span>
        )}

        {hdr && <span className="glass-badge glass-dark absolute bottom-2 left-2 text-[10px] text-white">{hdr}</span>}

        {showRating && item.CommunityRating != null && item.CommunityRating > 0 && !userData?.Played && (
          <span className="glass-badge glass-dark absolute right-2 top-2 text-[10px] text-white">★{item.CommunityRating.toFixed(1)}</span>
        )}

        {userData?.IsFavorite && (
          <span role="img" aria-label="已收藏" title="已收藏" className="glass-badge glass-dark absolute left-2 top-2 flex h-6 w-6 items-center justify-center !rounded-full !p-0 text-white">
            <IconStar size={13} />
          </span>
        )}
        {userData?.Played && (
          <span role="img" aria-label="已观看" title="已观看" className="glass-badge glass-dark absolute bottom-2 right-2 flex h-6 w-6 items-center justify-center !rounded-full !p-0 text-white">
            <IconCheck size={14} />
          </span>
        )}
      </div>
      <div className="mt-2.5 px-1">
        <div className="truncate text-[12px] font-semibold text-text-primary">{label ?? item.Name}</div>
        {subtitle && <div className="truncate text-[11px] text-text-secondary">{subtitle}</div>}
        {metadata.length > 0 && <div className="mt-0.5 flex flex-wrap gap-x-1.5 gap-y-0.5 text-[10px] text-text-secondary">{metadata.map((value) => <span key={value}>{value}</span>)}</div>}
        {description && <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-text-secondary">{description}</div>}
      </div>
    </button>
  );
}
