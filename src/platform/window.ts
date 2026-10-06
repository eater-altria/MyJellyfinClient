/** Window controls abstraction: uses Tauri APIs when running inside Tauri,
 * degrades to no-ops in a plain browser (vite dev). */

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

type Win = import('@tauri-apps/api/window').Window;

let cached: Win | null = null;

async function win(): Promise<Win | null> {
  if (!isTauri) return null;
  if (!cached) {
    const mod = await import('@tauri-apps/api/window');
    cached = mod.getCurrentWindow();
  }
  return cached;
}

export async function windowMinimize() {
  (await win())?.minimize();
}

export async function windowToggleMaximize() {
  (await win())?.toggleMaximize();
}

export async function windowClose() {
  (await win())?.close();
}

export async function windowSetFullscreen(flag: boolean) {
  (await win())?.setFullscreen(flag);
}

export async function windowIsFullscreen(): Promise<boolean> {
  return (await win())?.isFullscreen() ?? false;
}

export async function windowIsMaximized(): Promise<boolean> {
  return (await win())?.isMaximized() ?? false;
}

export type ResizeDirection = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West';
export async function windowStartResize(direction: ResizeDirection) {
  await (await win())?.startResizeDragging(direction);
}
