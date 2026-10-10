import { isTauri } from './window';
import { invoke } from '@tauri-apps/api/core';
import packageInfo from '../../package.json';

export async function currentAppVersion(): Promise<string> {
  if (!isTauri) return packageInfo.version;
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
}

/** Open only this project's fixed Release page in the Windows default browser. */
export async function openProjectReleases(): Promise<void> {
  await invoke('open_project_releases');
}
