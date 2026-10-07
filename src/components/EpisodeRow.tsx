import { useNavigate } from 'react-router-dom';
import { BaseItem, MediaServerApi } from '../api/mediaServer';
import PosterCard from './PosterCard';

/** Episode cards share preview, progress and metadata preferences with every other media list. */
export default function EpisodeRow({ api, episodes, serverId }: {
  api: MediaServerApi;
  episodes: BaseItem[];
  serverId: string;
}) {
  const navigate = useNavigate();
  return (
    <div className="flex gap-4 overflow-x-auto pb-3 pt-1" style={{ scrollbarWidth: 'none' }}>
      {episodes.map((episode) => (
        <PosterCard
          key={episode.Id}
          api={api}
          item={episode}
          landscape
          width={118}
          label={`${episode.IndexNumber != null ? `E${episode.IndexNumber} · ` : ''}${episode.Name}`}
          description={episode.Overview}
          showRating
          onClick={() => navigate(`/server/${serverId}/episode/${episode.Id}`)}
        />
      ))}
    </div>
  );
}
