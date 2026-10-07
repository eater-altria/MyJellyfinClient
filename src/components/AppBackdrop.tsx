import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppBackdrop } from '../store/appBackdrop';

/** Current media artwork supplies scenery behind navigation and glass without extra image variants. */
export default function AppBackdrop() {
  const source = useAppBackdrop((state) => state.source);
  const location = useLocation();
  const [failedSource, setFailedSource] = useState<typeof source>(null);
  if (!source || source.route !== location.pathname || source === failedSource) return null;
  return (
    <div className="app-scene" aria-hidden="true">
      <img key={source.url} src={source.url} alt="" draggable={false}
        onLoad={() => setFailedSource(null)} onError={() => setFailedSource(source)} />
    </div>
  );
}
