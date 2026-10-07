import { create } from 'zustand';

interface BackdropSource {
  owner: object;
  route: string;
  url: string;
}

interface AppBackdropState {
  source: BackdropSource | null;
  setBackdrop: (owner: object, route: string, url: string | null) => void;
  clearBackdrop: (owner: object) => void;
}

/** Current-page artwork only; authenticated image URLs never enter persistent settings. */
export const useAppBackdrop = create<AppBackdropState>((set, get) => ({
  source: null,
  setBackdrop(owner, route, url) {
    if (!url) { get().clearBackdrop(owner); return; }
    const previous = get().source;
    if (previous?.owner === owner && previous.route === route && previous.url === url) return;
    set({ source: { owner, route, url } });
  },
  clearBackdrop(owner) {
    if (get().source?.owner === owner) set({ source: null });
  },
}));
