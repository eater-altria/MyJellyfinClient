import { MediaServerApi, Person } from '../api/mediaServer';

const TYPE_LABELS: Record<string, string> = {
  Actor: '演员',
  Director: '导演',
  Producer: '制片人',
  Writer: '编剧',
};

/** Horizontal "演职人员" row with circular avatars. */
export default function CastRow({ api, people, onPersonClick, grid = false }: {
  api: MediaServerApi;
  people: Person[];
  onPersonClick: (person: Person) => void;
  grid?: boolean;
}) {
  if (!people.length) return null;
  return (
    <div className={`flex gap-4 pb-2 ${grid ? 'flex-wrap' : 'shrink-0'}`}>
      {people.map((p, i) => {
        const img = api.personImageUrl(p, 160);
        const sub =
          p.Type === 'Actor' && p.Role
            ? p.Role
            : TYPE_LABELS[p.Type ?? ''] ?? p.Type ?? '';
        return (
          <button key={`${p.Id}-${i}`} onClick={() => onPersonClick(p)}
            className="flex shrink-0 flex-col items-center rounded-lg p-1 transition hover:bg-white/50 focus-visible:outline-accent" title={p.Name}>
            {img ? (
              <img
                src={img}
                alt={p.Name}
                loading="lazy"
                draggable={false}
                className="h-16 w-16 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gray-200 text-gray-400">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="8" r="3.6" />
                  <path d="M4.5 20.5c.6-4 3.8-6 7.5-6s6.9 2 7.5 6Z" />
                </svg>
              </div>
            )}
            <div className="mt-1.5 w-16 truncate text-center text-[11px] text-text-primary">
              {p.Name}
            </div>
            {sub && (
              <div className="w-16 truncate text-center text-[10px] text-text-secondary">{sub}</div>
            )}
          </button>
        );
      })}
    </div>
  );
}
