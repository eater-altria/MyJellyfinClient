import { BaseItem, MediaServerApi, MediaStream, formatDuration, formatSize } from '../api/mediaServer';
import { AppSettings } from '../store/settings';

const FOLDER_TYPES = new Set(['Series', 'Season', 'CollectionFolder', 'Folder', 'BoxSet', 'UserView']);

export const isMediaFolder = (item: BaseItem) => item.IsFolder ?? FOLDER_TYPES.has(item.Type ?? '');

/** Keep the server's sort order inside each group, including date/rating order. */
export function orderMediaItems(items: BaseItem[], foldersFirst: boolean): BaseItem[] {
  if (!foldersFirst) return items;
  return [...items.filter(isMediaFolder), ...items.filter((item) => !isMediaFolder(item))];
}

/** Recursive queries order the stored IsFolder boolean; descending puts true (folders) first. */
export function mediaSortParams(sortBy: string, sortOrder: string, foldersFirst: boolean) {
  return foldersFirst
    ? { SortBy: `IsFolder,${sortBy}`, SortOrder: `Descending,${sortOrder}` }
    : { SortBy: sortBy, SortOrder: sortOrder };
}

export function mediaFolderDate(item: BaseItem): string {
  if (!isMediaFolder(item) || !item.DateCreated) return '';
  const date = new Date(item.DateCreated);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function mediaVideoStream(item: BaseItem): MediaStream | undefined {
  return item.MediaStreams?.find((stream) => stream.Type === 'Video')
    ?? item.MediaSources?.[0]?.MediaStreams?.find((stream) => stream.Type === 'Video');
}

export function mediaResolution(width?: number, height?: number, simple = true): string {
  if (!width || !height || width <= 0 || height <= 0) return '';
  if (!simple) return `${width} × ${height}`;
  // Classify letterboxed movies by their width too (e.g. 1920 × 800 is 1080p).
  if (width >= 7680 || height >= 4320) return '8K';
  if (width >= 3840 || height >= 2160) return '4K';
  if (width >= 2560 || height >= 1440) return '1440p';
  if (width >= 1920 || height >= 1080) return '1080p';
  if (width >= 1280 || height >= 720) return '720p';
  return `${height}p`;
}

export function mediaHdrLabel(stream?: MediaStream): string {
  if (!stream) return '';
  const range = `${stream.VideoRangeType ?? ''} ${stream.VideoRange ?? ''}`.toUpperCase();
  if (/DOVI|DOLBY\s*VISION/.test(range)) return 'Dolby Vision';
  if (/HDR10\+|HDR10PLUS/.test(range)) return 'HDR10+';
  if (/HDR10/.test(range)) return 'HDR10';
  if (/HLG/.test(range)) return 'HLG';
  return /HDR|PQ/.test(range) || /SMPTE2084|ARIB-STD-B67/i.test(stream.ColorTransfer ?? '') ? 'HDR' : '';
}

/** New means added within seven days and not yet played; missing dates aren't guessed. */
export function isNewMedia(item: BaseItem, now = Date.now()): boolean {
  if (item.UserData?.Played || !item.DateCreated) return false;
  const age = now - new Date(item.DateCreated).getTime();
  return Number.isFinite(age) && age >= 0 && age <= 7 * 86_400_000;
}

export function mediaListMetadata(item: BaseItem, settings: AppSettings): string[] {
  const source = item.MediaSources?.[0];
  const video = mediaVideoStream(item);
  const fps = video?.RealFrameRate ?? video?.AverageFrameRate;
  return [
    settings.showFolderTime ? mediaFolderDate(item) : '',
    settings.showMediaDuration ? formatDuration(item.RunTimeTicks ?? source?.RunTimeTicks) : '',
    settings.showFileSize ? formatSize(source?.Size ?? item.Size) : '',
    settings.showFrameRate && fps && Number.isFinite(fps) && fps > 0
      ? `${Number(fps.toFixed(3))} fps` : '',
    settings.showResolution ? mediaResolution(video?.Width ?? item.Width, video?.Height ?? item.Height, settings.simplifyResolution) : '',
  ].filter((value): value is string => !!value);
}

/** Only use thumbnails the server advertises; never probe or decode a remote movie for a list. */
export function mediaPreviewUrls(api: MediaServerApi, item: BaseItem, settings: AppSettings, landscape = false) {
  if (!settings.showPreviewImage) return { primary: null, fallback: null };
  const cover = landscape ? api.thumbUrl(item, 600) ?? api.posterUrl(item, 400) : api.posterUrl(item, 400);
  const runtime = item.RunTimeTicks ?? item.MediaSources?.[0]?.RunTimeTicks;
  if (settings.preferEmbeddedCover && cover) return { primary: cover, fallback: null };
  if (!runtime || runtime <= 0) return { primary: cover, fallback: null };
  const target = runtime * Math.min(100, Math.max(0, settings.previewTimePercent)) / 100;
  const chapters = (item.Chapters ?? []).map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter }) => chapter.ImageTag && chapter.StartPositionTicks != null && chapter.StartPositionTicks >= 0);
  const nearest = chapters.reduce<typeof chapters[number] | undefined>((best, entry) =>
    !best || Math.abs(entry.chapter.StartPositionTicks! - target) < Math.abs(best.chapter.StartPositionTicks! - target) ? entry : best,
  undefined);
  if (!nearest) return { primary: cover, fallback: null };
  return {
    primary: api.imageUrl(item.Id, 'Chapter', { imageIndex: nearest.index, tag: nearest.chapter.ImageTag, maxWidth: 600 }),
    fallback: cover,
  };
}
