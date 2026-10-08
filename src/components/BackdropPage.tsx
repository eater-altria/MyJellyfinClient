import { MediaServerApi, BaseItem } from '../api/mediaServer';
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppBackdrop } from '../store/appBackdrop';
import { useSettings } from '../store/settings';

/** Scenic detail-page backdrop; foreground glass surfaces keep text legible. */
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
  const location = useLocation();
  const showPreviewImage = useSettings((settings) => settings.showPreviewImage);
  const bg = showPreviewImage && item ? api.backdropUrl(item, 1920) : null;
  const backdropOwner = useRef({});

  useEffect(() => {
    const owner = backdropOwner.current;
    useAppBackdrop.getState().setBackdrop(owner, location.pathname, showPreviewImage ? bg : null);
    return () => useAppBackdrop.getState().clearBackdrop(owner);
  }, [bg, location.pathname, showPreviewImage]);

  return (
    <div className="relative isolate h-full overflow-y-auto">
      {bg && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-0" style={{
          height: 680,
          maskImage: 'linear-gradient(to bottom, black 35%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, black 35%, transparent 100%)',
        }}>
          <img
            src={bg}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
          <div className="absolute inset-0 bg-gradient-to-b from-white/15 via-page-bg/50 to-page-bg" />
        </div>
      )}
      <div className="relative z-10">
        {header}
        <div className="px-5 pb-10 lg:px-8">{children}</div>
      </div>
    </div>
  );
}
