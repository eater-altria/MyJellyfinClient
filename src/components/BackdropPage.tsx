import { MediaServerApi, BaseItem } from '../api/mediaServer';

/** Page wrapper that paints a blurred, color-tinted backdrop behind content —
 * the signature SenPlayer detail-page look. */
export default function BackdropPage({
  api,
  item,
  children,
  header,
}: {
  api: MediaServerApi;
  item?: BaseItem | null;
  children: React.ReactNode;
  header?: React.ReactNode;
}) {
  const bg = item ? api.backdropUrl(item, 1920) : null;

  return (
    <div className="relative h-full overflow-y-auto">
      {bg && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-0" style={{ height: 620 }}>
          <img
            src={bg}
            alt=""
            className="h-full w-full object-cover"
            style={{
              maskImage: 'linear-gradient(to bottom, black 55%, transparent 100%)',
              WebkitMaskImage: 'linear-gradient(to bottom, black 55%, transparent 100%)',
            }}
            draggable={false}
          />
          <div className="absolute inset-0 bg-gradient-to-b from-white/10 via-white/40 to-page-bg" />
        </div>
      )}
      <div className="relative z-10">
        {header}
        <div className="px-8 pb-10">{children}</div>
      </div>
    </div>
  );
}
