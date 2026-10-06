/** Exercise the actual player effect with delayed server / IPC promises. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');

const code = esbuild.transformSync(fs.readFileSync('src/pages/NativePlayer.tsx', 'utf8'), {
  loader: 'tsx', format: 'cjs', jsx: 'automatic',
}).code;
const titleCode = esbuild.transformSync(fs.readFileSync('src/components/TitleBar.tsx', 'utf8'), {
  loader: 'tsx', format: 'cjs', jsx: 'automatic',
}).code;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

function mount(protocol, pending) {
  const effects = [], calls = [], keys = new Map(), events = new Map(), states = [];
  const item = { Id: 'movie', Name: 'Test', UserData: { PlaybackPositionTicks: 1200000000 },
    MediaSources: [{ Id: 'source', Container: 'mp4', SupportsDirectPlay: true }] };
  const signals = [];
  const api = {
    protocol,
    getItem: (_id, signal) => { signals.push(signal); return pending === 'item' ? delayed.promise : Promise.resolve(item); },
    getPlaybackInfo: (_id, _player, signal) => {
      signals.push(signal);
      return pending === 'info' ? delayed.promise : Promise.resolve({ MediaSources: item.MediaSources });
    },
    directStreamUrl: () => 'http://fixture/slow-video', externalSubtitleUrls: () => [],
    reportPlaybackStart: async () => calls.push(['report-start']),
    reportPlaybackProgress: async () => calls.push(['report-progress']),
    reportPlaybackStopped: async payload => calls.push(['report-stop', payload]),
  };
  const delayed = deferred();
  const fakeWindow = {
    addEventListener: (name, handler) => keys.set(name, handler),
    removeEventListener: name => keys.delete(name),
    setInterval: () => 1, clearInterval: () => {},
    dispatchEvent: event => { keys.get(event.type)?.(event); return !event.defaultPrevented; },
  };
  const modules = {
    react: { useEffect: fn => effects.push(fn), useRef: current => ({ current }),
      useState: initial => [initial, value => states.push(value)] },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'react-router-dom': { useParams: () => ({ serverId: 'server', itemId: 'movie' }), useLocation: () => ({ pathname: '/player/server/movie' }),
      useSearchParams: () => [new URLSearchParams()], useNavigate: () => n => calls.push(['navigate', n]) },
    '@tauri-apps/api/core': { invoke: (name, args) => {
      calls.push([name, args]);
      if (name === 'player_escape') return Promise.resolve(true);
      return name === 'start_playback' && pending === 'ipc' ? delayed.promise : Promise.resolve();
    } },
    '@tauri-apps/api/event': { listen: async (name, handler) => {
      events.set(name, handler);
      return () => events.delete(name);
    } },
    '../store/servers': { useServers: { getState: () => ({ getApi: () => pending === 'noserver' ? null : api, servers: [] }) } },
    '../store/settings': { useSettings: { getState: () => ({ resumeFromLastPosition: true }) } },
    '../player/playbackPreferences': { getPlaybackPreferences: () => ({}), rememberTrack: () => {},
      saveSubtitleSearchQueries: () => {}, getAdjacentMedia: async () => undefined },
    '../player/exitPlayback': { PLAYER_EXIT_EVENT: 'mjc:exit-playback' },
    '../platform/window': { isTauri: false, windowClose: () => calls.push(['window-close']), windowIsMaximized: async () => false,
      windowIsFullscreen: async () => false, windowMinimize() {}, windowToggleMaximize() {} },
    './icons': { IconClose() {}, IconMaximize() {}, IconMinimize() {} },
  };
  const bundle = { exports: {} };
  new Function('require', 'module', 'exports', 'window', code)(name => {
    assert(modules[name], `Unexpected import: ${name}`);
    return modules[name];
  }, bundle, bundle.exports, fakeWindow);
  const view = bundle.exports.default();
  const cleanup = effects[0]() ?? (() => {});
  const title = {exports:{}};
  new Function('require', 'module', 'exports', 'window', titleCode)(name => modules[name], title, title.exports, fakeWindow);
  const header = title.exports.default({ dark: true });
  const findClose = element => {
    if (element?.props?.title === '关闭播放器') return element;
    for (const child of [element?.props?.children].flat(Infinity)) {
      const found = child && typeof child === 'object' ? findClose(child) : undefined;
      if (found) return found;
    }
  };
  const closeButton = findClose(header);
  assert(closeButton, 'Player title bar must provide a close control');
  return { calls, events, states, signals, delayed, item, cleanup,
    escape: () => keys.get('keydown')({ key: 'Escape', preventDefault() {} }),
    close: () => closeButton.props.onClick() };
}

(async () => {
  for (const protocol of ['jellyfin', 'emby']) {
    for (const pending of ['item', 'info', 'ipc', 'media']) {
      // Jellyfin's direct-play fast path skips playback-info negotiation.
      if (protocol === 'jellyfin' && pending === 'info') continue;
      for (const exit of ['escape', 'close']) {
        const player = mount(protocol, pending);
        await flush();
        assert(player.signals.every(s => !s.aborted));
        if (pending === 'media') {
          assert(player.calls.some(c => c[0] === 'start_playback'));
          assert(!player.states.includes(false), 'IPC startup must not end the media loading screen');
          player.events.get('mpv://position')({ payload: { position: 0, duration: 0, paused: false, active: true } });
        }
        player[exit]();
        assert.equal(player.calls.filter(c => c[0] === 'navigate').length, 1, 'Exit must navigate without waiting for the network');
        assert(!player.calls.some(c => c[0] === 'window-close'), 'Player close must keep the app window open');
        assert(player.signals.every(s => s.aborted), 'Exit must abort server requests');
        player[exit]();
        assert.equal(player.calls.filter(c => c[0] === 'navigate').length, 1, 'Repeated exit must be ignored');
        player.cleanup();
        player.delayed.resolve(pending === 'info' ? { MediaSources: player.item.MediaSources } : player.item);
        await flush();
        const commands = player.calls.filter(c => c[0] === 'start_playback');
        assert.equal(commands.length, pending === 'ipc' || pending === 'media' ? 1 : 0, 'Late server response must not start playback');
        assert.equal(player.calls.filter(c => c[0] === 'stop_playback').length, commands.length, 'Exit must stop an already requested native player');
        assert.equal(player.events.size, 0, 'All listeners must be disposed');
        const stopped = player.calls.find(c => c[0] === 'report-stop');
        if (stopped) assert.equal(stopped[1].PositionTicks, 1200000000, 'Cancelling loading must preserve the resume position');
      }
    }
  }
  const loaded = mount('emby', 'media');
  await flush();
  loaded.events.get('mpv://ready')({ payload: null });
  assert(loaded.states.includes(false), 'Loaded media must dismiss the loading screen');
  await loaded.escape();
  assert(loaded.calls.some(c => c[0] === 'player_escape'), 'Loaded Escape must go through the native modal stack even when the title bar has focus');
  assert(!loaded.calls.some(c => c[0] === 'navigate'), 'The frontend must not bypass an open native modal');
  loaded.close();
  assert.equal(loaded.calls.filter(c => c[0] === 'navigate').length, 1);
  assert(!loaded.calls.some(c => c[0] === 'window-close'));
  loaded.cleanup();
  const failedBeforeReady = mount('emby', 'media');
  await flush();
  failedBeforeReady.events.get('mpv://exit')({ payload: { position: 0, duration: 0, paused: false, active: false } });
  assert.equal(failedBeforeReady.calls.find(call => call[0] === 'report-stop')[1].PositionTicks, 1200000000,
    'A native exit before first media-ready must preserve the resume position');
  assert.equal(failedBeforeReady.calls.filter(call => call[0] === 'navigate').length, 1);
  failedBeforeReady.cleanup();
  const disposed = mount('jellyfin', 'item');
  disposed.cleanup(); // StrictMode cleanup while listen() is still resolving.
  await flush();
  assert.equal(disposed.events.size, 0);
  assert.equal(disposed.calls.length, 0);
  const missing = mount('emby', 'noserver');
  missing.close();
  assert.equal(missing.calls.filter(c => c[0] === 'navigate').length, 1, 'Close must also exit a missing-server error page');
  assert(!missing.calls.some(c => c[0] === 'window-close'));
  console.log('PASS: real title-bar close exits playback without closing the app; Jellyfin / Emby cancellation during metadata, negotiation, IPC startup and stalled media; late responses, ready event and cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
