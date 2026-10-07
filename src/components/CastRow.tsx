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
    <div className={`flex gap-3 pb-2 ${grid ? 'flex-wrap' : 'shrink-0'}`}>
      {people.map((p, i) => {
        const img = api.personImageUrl(p, 160);
        const sub =
          p.Type === 'Actor' && p.Role
            ? p.Role
            : TYPE_LABELS[p.Type ?? ''] ?? p.Type ?? '';
        return (
          <button key={`${p.Id}-${i}`} onClick={() => onPersonClick(p)}
            className="media-card glass-surface cast-glass-card flex w-[100px] shrink-0 flex-col items-center rounded-[22px] px-2 py-3" title={p.Name}>
            {img ? (
              <img
                src={img}
                alt={p.Name}
                loading="lazy"
                draggable={false}
                className="h-16 w-16 rounded-full object-cover shadow-sm ring-2 ring-white/70"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/50 text-slate-400 ring-1 ring-white/80">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="8" r="3.6" />
                  <path d="M4.5 20.5c.6-4 3.8-6 7.5-6s6.9 2 7.5 6Z" />
                </svg>
              </div>
            )}
            <div className="mt-2 w-full truncate text-center text-[11px] font-medium text-text-primary">
              {p.Name}
            </div>
            {sub && (
              <div className="mt-0.5 w-full truncate text-center text-[10px] text-text-secondary">{sub}</div>
            )}
          </button>
        );
      })}
    </div>
  );
}
