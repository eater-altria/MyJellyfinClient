import { updateBrowseUserData } from '../utils/browseHistory';

/** Publish the last observed position before returning to retained browse pages.
 * Server reporting may still be pending (or fail), so it must not delay this
 * update or let a late response overwrite a newer playback session.
 */
export function publishPlaybackPosition(owner: object, itemId: string, positionSeconds: number, durationSeconds: number) {
  // Startup/failed playback must not erase an existing resume position.
  if (!Number.isFinite(positionSeconds) || positionSeconds <= 0) return;
  updateBrowseUserData(owner, itemId, {
    PlaybackPositionTicks: Math.round(positionSeconds * 10_000_000),
    PlayedPercentage: Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.min(100, positionSeconds / durationSeconds * 100) : undefined,
  });
}
