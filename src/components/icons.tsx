import React from 'react';

type P = React.SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 18, ...props }: P, children: React.ReactNode) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconFolder = (p: P) =>
  base(p, <>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </>);

export const IconServer = (p: P) =>
  base(p, <>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <circle cx="7" cy="7.5" r="0.5" fill="currentColor" />
    <circle cx="7" cy="16.5" r="0.5" fill="currentColor" />
  </>);

export const IconTv = (p: P) =>
  base(p, <>
    <rect x="3" y="5" width="18" height="12" rx="2" />
    <path d="M9 21h6" />
  </>);

export const IconHistory = (p: P) =>
  base(p, <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>);

export const IconSearch = (p: P) =>
  base(p, <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>);

export const IconSettings = (p: P) =>
  base(p, <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.51 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.6.74 1 1.51 1H21a2 2 0 1 1 0 4h-.09c-.77 0-1.37.4-1.51 1Z" />
  </>);

export const IconPlus = (p: P) => base(p, <path d="M12 5v14M5 12h14" />);

export const IconChevronLeft = (p: P) => base(p, <path d="m15 6-6 6 6 6" />);
export const IconChevronRight = (p: P) => base(p, <path d="m9 6 6 6-6 6" />);
export const IconChevronDown = (p: P) => base(p, <path d="m6 9 6 6 6-6" />);

export const IconPlay = (p: P) =>
  base(p, <path d="M8 5.5v13c0 .8.9 1.3 1.6.9l10-6.5a1.05 1.05 0 0 0 0-1.8l-10-6.5c-.7-.4-1.6.1-1.6.9Z" fill="currentColor" stroke="none" />);

export const IconPause = (p: P) =>
  base(p, <>
    <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
    <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
  </>);

export const IconHeart = (p: P & { filled?: boolean }) => {
  const { filled, ...rest } = p;
  return base(
    rest,
    <path
      d="M12 20.7C6.4 17 3 13.6 3 9.6 3 7 5 5 7.5 5c1.7 0 3.3.9 4.5 2.6C13.2 5.9 14.8 5 16.5 5 19 5 21 7 21 9.6c0 4-3.4 7.4-9 11.1Z"
      fill={filled ? 'currentColor' : 'none'}
    />,
  );
};

export const IconCheck = (p: P) => base(p, <path d="m4 12.5 5 5L20 6.5" />);

export const IconRefresh = (p: P) =>
  base(p, <>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </>);

export const IconStar = (p: P) =>
  base(p, <path d="m12 3 2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 17l-5.4 2.8 1.1-6.1L3.2 9.4l6.1-.8Z" fill="currentColor" stroke="none" />);

export const IconFullscreen = (p: P) =>
  base(p, <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />);

export const IconMinimize = (p: P) => base(p, <path d="M5 12h14" />);
export const IconClose = (p: P) => base(p, <path d="M6 6l12 12M18 6 6 18" />);
export const IconMaximize = (p: P) => base(p, <rect x="5" y="5" width="14" height="14" rx="2" />);

export const IconVolume = (p: P) =>
  base(p, <>
    <path d="M11 5 6 9H3v6h3l5 4Z" fill="currentColor" stroke="none" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.4 5.6a9 9 0 0 1 0 12.8" />
  </>);

export const IconSkipBack = (p: P) =>
  base(p, <>
    <path d="M11 17.5 4.6 12.9a1.2 1.2 0 0 1 0-1.8L11 6.5c.7-.5 1.6 0 1.6.9v9.2c0 .9-.9 1.4-1.6.9Z" fill="currentColor" stroke="none" />
    <path d="M20 17.5 13.6 12.9a1.2 1.2 0 0 1 0-1.8L20 6.5c.7-.5 1.6 0 1.6.9v9.2c0 .9-.9 1.4-1.6.9Z" fill="currentColor" stroke="none" />
  </>);

export const IconSkipForward = (p: P) =>
  base(p, <>
    <path d="M13 17.5l6.4-4.6a1.2 1.2 0 0 0 0-1.8L13 6.5c-.7-.5-1.6 0-1.6.9v9.2c0 .9.9 1.4 1.6.9Z" fill="currentColor" stroke="none" />
    <path d="M4 17.5l6.4-4.6a1.2 1.2 0 0 0 0-1.8L4 6.5c-.7-.5-1.6 0-1.6.9v9.2c0 .9.9 1.4 1.6.9Z" fill="currentColor" stroke="none" />
  </>);

export const IconHome = (p: P) =>
  base(p, <>
    <path d="m3 11 9-8 9 8" />
    <path d="M5 10v10h14V10" />
  </>);

export const IconList = (p: P) =>
  base(p, <>
    <path d="M8 6h13M8 12h13M8 18h13" />
    <circle cx="4" cy="6" r="0.6" fill="currentColor" />
    <circle cx="4" cy="12" r="0.6" fill="currentColor" />
    <circle cx="4" cy="18" r="0.6" fill="currentColor" />
  </>);

export const IconLibrary = (p: P) =>
  base(p, <>
    <rect x="3" y="4" width="5" height="16" rx="1" />
    <rect x="10" y="4" width="5" height="16" rx="1" />
    <path d="m17.5 5 4 1-3.5 14-4-1Z" />
  </>);

export const IconGesture = (p: P) =>
  base(p, <path d="M8 13V6a1.5 1.5 0 0 1 3 0v5m0-3a1.5 1.5 0 0 1 3 0v3m0-2a1.5 1.5 0 0 1 3 0v3m0-1a1.5 1.5 0 0 1 3 0v3a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L4.6 15a1.6 1.6 0 0 1 2.6-1.9L8 14.5" />);

export const IconVideo = (p: P) =>
  base(p, <>
    <rect x="3" y="6" width="13" height="12" rx="2" />
    <path d="m16 10 5-3v10l-5-3" />
  </>);

export const IconAudio = (p: P) =>
  base(p, <>
    <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
  </>);

export const IconSubtitle = (p: P) =>
  base(p, <>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 12h4M13 12h4M7 15h2M11 15h6" />
  </>);

export const IconDanmaku = (p: P) =>
  base(p, <>
    <path d="M4 6h12a4 4 0 0 1 0 8H9l-5 4Z" />
    <path d="M9 10h.01M13 10h.01" />
  </>);

export const IconMonitor = (p: P) =>
  base(p, <>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M9 20h6M12 16v4" />
  </>);

/** Small-size server mark: rounded purple tile and a cyan play triangle. */
export const IconJellyfin = ({ size = 18, ...props }: P) => {
  const gradient = React.useId();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <defs>
        <linearGradient id={gradient} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#a855f7" /><stop offset="1" stopColor="#4263eb" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="6" fill={`url(#${gradient})`} />
      <path d="M11.1 5.4a1.05 1.05 0 0 1 1.8 0l6.15 10.65a1.05 1.05 0 0 1-.9 1.58H5.85a1.05 1.05 0 0 1-.9-1.58Z" stroke="white" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="m10 9 5 3-5 3Z" fill="#67e8f9" />
    </svg>
  );
};

export const IconEmby = ({ size = 18, ...props }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
    <rect x="1" y="1" width="22" height="22" rx="6" fill="#52b54b" />
    <path d="M7.5 6.5h9v3h-6v1h5v3h-5v1h6v3h-9Z" fill="white" />
  </svg>
);
