import { useEffect, useState, type ReactNode } from 'react';
import { useSettings } from '../store/settings';
import LiquidGlass from './LiquidGlass';

/** Original title artwork floats over the cover; controls stay on light glass. */
export default function MediaDetailHeader({ title, logoUrl, children }: {
  title: string;
  logoUrl: string | null;
  children: ReactNode;
}) {
  const showPreviewImage = useSettings((settings) => settings.showPreviewImage);
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  const showLogo = showPreviewImage && !!logoUrl && failedLogo !== logoUrl;

  useEffect(() => {
    setFailedLogo(null);
  }, [logoUrl, showPreviewImage]);

  return (
    <div className="detail-header min-w-0 max-w-4xl">
      {showLogo && logoUrl && (
        <div className="detail-logo-stage">
          <div className="detail-logo-artwork" aria-hidden="true">
            <img key={logoUrl} src={logoUrl} alt="" aria-hidden="true" draggable={false}
              className="detail-logo-image" onError={() => setFailedLogo(logoUrl)} />
          </div>
        </div>
      )}
      <LiquidGlass intensity="subtle" className="detail-header-info rounded-[28px] p-6 sm:p-7">
        <h1 className="break-words text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">{title}</h1>
        {children}
      </LiquidGlass>
    </div>
  );
}
