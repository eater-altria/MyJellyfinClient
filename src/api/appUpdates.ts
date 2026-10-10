export const RELEASES_PAGE_URL = 'https://github.com/eater-altria/MyJellyfinClient/releases/latest';
export const LATEST_RELEASE_API = 'https://api.github.com/repos/eater-altria/MyJellyfinClient/releases/latest';
const CHECK_TIMEOUT_MS = 15_000;

function parseVersion(value: string) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value.trim());
  if (!match) throw new Error('无法识别版本号，请前往 GitHub Release 页面查看。');
  const numbers = match.slice(1, 4).map(Number);
  const prerelease = match[4]?.split('.') ?? [];
  if (numbers.some(number => !Number.isSafeInteger(number))
    || prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) {
    throw new Error('无法识别版本号，请前往 GitHub Release 页面查看。');
  }
  return { numbers, prerelease };
}

/** Compare semantic versions numerically; build metadata does not affect precedence. */
export function compareAppVersions(left: string, right: string): number {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return x.length !== y.length ? (x.length > y.length ? 1 : -1) : x > y ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export type UpdateCheckResult =
  | { status: 'available' | 'current'; version: string }
  | { status: 'unpublished' };

/** Public GitHub metadata only; never reuse media-server headers or credentials. */
export async function checkForAppUpdate(currentVersion: string, signal: AbortSignal): Promise<UpdateCheckResult> {
  parseVersion(currentVersion);
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
      credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal,
    });
    if (response.status === 404) return { status: 'unpublished' };
    if (response.status === 403 || response.status === 429) throw new Error('GitHub 暂时限制了检查请求，请稍后重试。');
    if (!response.ok) throw new Error('GitHub 暂时无法提供更新信息，请稍后重试。');
    const release: unknown = await response.json();
    if (!release || typeof release !== 'object' || !('tag_name' in release)
      || typeof release.tag_name !== 'string' || !('draft' in release) || release.draft !== false
      || !('prerelease' in release) || release.prerelease !== false) {
      throw new Error('GitHub 返回的 Release 信息无效，请稍后重试。');
    }
    return { status: compareAppVersions(release.tag_name, currentVersion) > 0 ? 'available' : 'current', version: release.tag_name };
  } catch (error) {
    if (signal.aborted) throw error;
    if (timedOut) throw new Error('检查更新超时，请检查网络后重试。');
    if (error instanceof TypeError) throw new Error('无法连接 GitHub，请检查网络后重试。');
    if (error instanceof SyntaxError) throw new Error('GitHub 返回的 Release 信息无效，请稍后重试。');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}
