/** Offline GitHub fixtures and real React/Chromium settings interaction. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

async function main() {
  const code = esbuild.transformSync(fs.readFileSync('src/api/appUpdates.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} };
  new Function('module', 'exports', code)(module, module.exports);
  const { compareAppVersions, checkForAppUpdate, LATEST_RELEASE_API } = module.exports;
  for (const [left, right, expected] of [
    ['v0.4.4', '0.4.3', 1], ['0.10.0', '0.9.9', 1], ['0.4.3', '0.4.3', 0],
    ['0.4.2', '0.4.3', -1], ['1.0.0', '1.0.0-rc.1', 1], ['1.0.0-rc.10', '1.0.0-rc.2', 1],
    ['1.0.0+build.2', 'v1.0.0+build.1', 0], ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-1', '1.0.0-alpha', -1], ['1.0.0-beta', '1.0.0-alpha', 1],
  ]) assert.equal(compareAppVersions(left, right), expected);
  for (const invalid of ['latest', 'v1', '1.2.3.4', '01.2.3', '1.2.3-01', '9007199254740992.0.0']) {
    assert.throws(() => compareAppVersions(invalid, '0.4.3'), /无法识别/);
  }

  const originalFetch = global.fetch;
  const timers = new Map(); let serial = 0;
  global.window = { setTimeout: callback => { timers.set(++serial, callback); return serial; }, clearTimeout: id => timers.delete(id) };
  const release = tag => ({ tag_name: tag, draft: false, prerelease: false });
  let reply;
  global.fetch = async (url, options) => {
    assert.equal(url, LATEST_RELEASE_API);
    assert.deepEqual(options.headers, { Accept: 'application/vnd.github+json' });
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert.equal(options.referrerPolicy, 'no-referrer');
    return reply;
  };
  const check = () => checkForAppUpdate('0.4.3', new AbortController().signal);
  try {
    for (const [tag, status] of [['v0.4.4', 'available'], ['v0.4.3', 'current'], ['v0.4.2', 'current']]) {
      reply = new Response(JSON.stringify(release(tag)));
      assert.deepEqual(await check(), { status, version: tag });
      assert.equal(timers.size, 0, 'Completed checks must clear their timeout');
    }
    reply = new Response('', { status: 404 }); assert.deepEqual(await check(), { status: 'unpublished' });
    for (const status of [403, 429]) { reply = new Response('', { status }); await assert.rejects(check(), /限制/); }
    reply = new Response('', { status: 500 }); await assert.rejects(check(), /暂时无法/);
    for (const body of [null, {}, { ...release('v0.5.0'), draft: true }, { ...release('v0.5.0'), prerelease: true }, { ...release('v0.5.0'), tag_name: 5 }]) {
      reply = new Response(JSON.stringify(body)); await assert.rejects(check(), /信息无效/);
    }
    reply = new Response('{broken'); await assert.rejects(check(), /信息无效/);
    reply = new Response(JSON.stringify(release('latest'))); await assert.rejects(check(), /无法识别版本号/);
    global.fetch = async () => { throw new TypeError('offline'); }; await assert.rejects(check(), /无法连接/);
    global.fetch = (_url, options) => new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
    });
    const pending = check(); [...timers.values()][0](); await assert.rejects(pending, /超时/);
    const controller = new AbortController();
    const cancelled = checkForAppUpdate('0.4.3', controller.signal); controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.equal(timers.size, 0, 'Cancelled checks must clear their timeout');
  } finally { global.fetch = originalFetch; delete global.window; }
  console.log('PASS: numeric/prerelease version comparison, public unauthenticated GitHub requests, current/new/old releases, missing release, HTTP/network/JSON failures, timeout and cancellation');

  const browser = [process.env.MJC_TEST_CHROMIUM, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
  assert(browser, 'Set MJC_TEST_CHROMIUM to a Chromium executable');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mjc-app-updates-'));
  try {
    const config = (await import(pathToFileURL(path.resolve('tailwind.config.js')).href)).default;
    const css = (await require('postcss')([require('tailwindcss')(config), require('autoprefixer')])
      .process(fs.readFileSync('src/index.css', 'utf8'), { from: path.resolve('src/index.css') })).css;
    const bundle = (await esbuild.build({
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import Settings from './src/pages/Settings';
        import { LATEST_RELEASE_API, RELEASES_PAGE_URL } from './src/api/appUpdates';
        import { isTauri } from './src/platform/window';
        const report = document.getElementById('result');
        const check = (value, message) => { if (!value) throw new Error(message); };
        const root = createRoot(document.getElementById('root'));
        const tick = () => new Promise(resolve => setTimeout(resolve, 25));
        let requests = [], resolveResponse;
        window.fetch = (url, options) => {
          check(url === LATEST_RELEASE_API && options.credentials === 'omit' && !options.headers.Authorization, 'Only public GitHub metadata may be requested');
          requests.push(options);
          return new Promise(resolve => { resolveResponse = resolve; });
        };
        const button = () => [...document.querySelectorAll('button')].find(node => ['检查更新', '正在检查…'].includes(node.textContent));
        const status = () => document.querySelector('[role="status"]').textContent;
        const reply = async (body, code = 200) => { resolveResponse(new Response(JSON.stringify(body), { status: code })); await tick(); };
        const release = tag => ({ tag_name: tag, draft: false, prerelease: false });
        (async () => {
          try {
            flushSync(() => root.render(<React.StrictMode><Settings /></React.StrictMode>)); await tick();
            check(requests.length === 0, 'Opening settings must never automatically check GitHub');
            check(document.body.textContent.includes('当前版本：0.4.2'), 'Display the running application version rather than a hardcoded package version');
            flushSync(() => { button().click(); button().click(); });
            check(requests.length === 1 && button().disabled, 'Repeated clicks must start one request and disable the button');
            await reply(release('v0.5.0'));
            check(status().includes('发现新版本 v0.5.0'), 'A newer release must prompt the user to update');
            const link = document.querySelector('a[href="' + RELEASES_PAGE_URL + '"]');
            check(link && link.target === '_blank' && link.rel.includes('noopener'), 'Expose the fixed project Release page, never an API-provided arbitrary URL');
            if (isTauri) {
              link.click(); await tick();
              check(window.__releaseOpenCount === 1, 'The desktop link must call the native fixed-page browser bridge');
            }
            flushSync(() => button().click()); await reply(release('v0.4.2'));
            check(status().includes('无需更新') && !document.querySelector('a'), 'Equal versions need no update prompt');
            flushSync(() => button().click()); await reply(release('v0.4.1'));
            check(!status().includes('发现新版本'), 'An older Release must never prompt a downgrade');
            flushSync(() => button().click()); await reply({}, 403);
            check(status().includes('限制') && !button().disabled, 'Rate limits must be visible and retryable');
            flushSync(() => button().click()); await reply(null, 404);
            check(status().includes('暂未找到'), 'No Release must be distinct from already current');
            flushSync(() => button().click()); await reply({ tag_name: 'latest', draft: false, prerelease: false });
            check(status().includes('无法识别'), 'Invalid version tags must never claim the app is current');
            flushSync(() => button().click());
            const pending = requests.at(-1), late = resolveResponse;
            flushSync(() => document.getElementById('settings-tab-list').click());
            check(pending.signal.aborted, 'Leaving the general tab must cancel the pending check');
            late(new Response(JSON.stringify(release('v9.0.0')))); await tick();
            const count = requests.length;
            flushSync(() => document.getElementById('settings-tab-general').click()); await tick();
            check(!status().includes('v9.0.0'), 'A cancelled late response must not affect the reopened settings');
            check(count === requests.length && !status(), 'Returning to settings must not start an automatic check');
            flushSync(() => button().click()); await reply(release('v0.5.0'));
            button().scrollIntoView({ block: 'center' });
            for (const node of [button(), document.querySelector('a')]) {
              const rect = node.getBoundingClientRect();
              check(rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth, 'Update actions must remain within a narrow viewport at every DPI');
            }
            report.dataset.status = 'pass';
            report.textContent = 'PASS: actual Settings/React manual-only checks, installed version, repeated clicks, update prompt/link, current/older/missing/invalid releases, retry, abort/late response and responsive actions';
          } catch (error) { report.dataset.status = 'fail'; report.textContent = String(error.stack || error); }
        })();
      ` },
      bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'local-installed-version-fixture', setup(build) {
        build.onLoad({ filter: /[\\/]platform[\\/]appUpdates\.ts$/ }, () => ({ loader: 'ts', contents:
          "export async function currentAppVersion() { return '0.4.2'; } export async function openProjectReleases() { window.__releaseOpenCount = (window.__releaseOpenCount || 0) + 1; }" }));
      } }],
    })).outputFiles[0].text;
    const page = path.join(directory, 'fixture.html');
    fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="root"></div><pre id="result" data-status="pending" style="display:none"></pre><script>if (location.search) window.__TAURI_INTERNALS__ = {};</script><script>' + bundle.replace(/<\/script/gi, '<\\/script') + '</script>');
    for (const [width, scale, native] of [[1100, 1, false], [480, 1, false], [1100, 1.25, false], [480, 1.5, false], [1100, 1, true]]) {
      const artifactDirectory = path.resolve(process.env.MJC_TEST_ARTIFACT_DIR || directory);
      fs.mkdirSync(artifactDirectory, { recursive: true });
      const execution = spawnSync(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        '--allow-file-access-from-files', '--user-data-dir=' + path.join(directory, 'profile-' + width + '-' + scale),
        '--window-size=' + width + ',900', '--force-device-scale-factor=' + scale,
        '--screenshot=' + path.join(artifactDirectory, 'app-updates-' + width + '-' + scale + '.png'),
        '--dump-dom', '--virtual-time-budget=3000', pathToFileURL(page).href + (native ? '?native' : '')],
        { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 6 * 1024 * 1024 });
      if (execution.error) throw execution.error;
      assert.equal(execution.status, 0, execution.stderr);
      const result = execution.stdout.match(/<pre id="result" data-status="([^"]+)"[^>]*>([\s\S]*?)<\/pre>/);
      assert.equal(result?.[1], 'pass', result?.[2] ?? execution.stderr);
      console.log(result[2] + ' (' + width + 'px, ' + scale + 'x' + (native ? ', native bridge' : '') + ')');
    }
  } finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('mjc-app-updates-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
