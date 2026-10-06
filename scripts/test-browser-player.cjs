/** Exercise the actual browser player's gestures, menu and inactivity timer. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');
const code = esbuild.transformSync(fs.readFileSync('src/pages/Player.tsx', 'utf8'), {
  loader: 'tsx', format: 'cjs', jsx: 'automatic',
}).code;
const states = [], refs = [], effects = [], timers = new Map(), navigation = [];
let stateIndex = 0, refIndex = 0, serial = 0, actions;
const settings = { autoHideControlsSeconds: 3, autoLockOnPause: true, mouseLeftClick: 'none',
  mouseLeftDoubleClick: 'playpause', mouseRightClick: 'toggleControls', showSkipButtons: true,
  showSwitchMediaButton: true, showScreenshotButton: true };
const useSettings = Object.assign(() => settings, { getState: () => settings });
const modules = {
  react: {
    useState: initial => {
      const i = stateIndex++;
      if (!(i in states)) states[i] = initial;
      return [states[i], value => { states[i] = value; }];
    },
    useRef: initial => refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
    useEffect: callback => effects.push(callback), useCallback: callback => callback,
  },
  'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
  'react-router-dom': { useParams: () => ({ serverId: 'fixture', itemId: 'movie' }),
    useSearchParams: () => [new URLSearchParams()], useNavigate: () => value => navigation.push(value) },
  'hls.js': {},
  '../api/mediaServer': { formatTime: value => String(value) },
  '../store/servers': { useServers: { getState: () => ({ getApi: () => null }) } },
  '../store/settings': { useSettings },
  '../components/icons': new Proxy({}, { get: () => function Icon() {} }),
  '../platform/window': { isTauri: false },
  '../player/browserKeyboard': { bindBrowserPlaybackKeys: (_target, _video, _settings, value) => { actions = value; return () => {}; } },
  '../player/playbackPreferences': {}, '../player/trackSelection': {},
  '../player/exitPlayback': { PLAYER_EXIT_EVENT: 'mjc:exit-playback' },
  '../player/playbackTitle': { mediaTitle: item => item.Name, usePlaybackTitle: { getState: () => ({ setTitle() {} }) } },
};
const fakeWindow = { clearTimeout: id => timers.delete(id), setTimeout: (callback, ms) => {
  const id = ++serial; timers.set(id, { callback, ms }); return id;
} };
const bundle = { exports: {} };
new Function('require', 'module', 'exports', 'window', 'document', code)(name => {
  assert(modules[name], `Unexpected import: ${name}`); return modules[name];
}, bundle, bundle.exports, fakeWindow, { fullscreenElement: null });
const render = () => { stateIndex = 0; refIndex = 0; return bundle.exports.default(); };
const find = (node, predicate) => {
  if (predicate(node)) return node;
  for (const child of [node?.props?.children].flat(Infinity)) {
    if (child && typeof child === 'object') {
      const found = find(child, predicate); if (found) return found;
    }
  }
};
let page = render();
const video = { paused: false, playbackRate: 1, pauses: 0, plays: 0,
  pause() { this.pauses++; this.paused = true; },
  play() { this.plays++; this.paused = false; return Promise.resolve(); } };
find(page, node => node.type === 'video').props.ref.current = video;
effects.find(callback => callback.toString().includes('bindBrowserPlaybackKeys'))();
page.props.onClick();
assert.equal(video.pauses, 0, 'Default single-click must not pause the video');
page.props.onDoubleClick(); assert.equal(video.pauses, 1);
find(page, node => node.type === 'video').props.onPause();
page = render();
assert(!find(page, node => node.props?.['data-tooltip'] === '更多').props.disabled, 'Paused controls must remain usable');
assert(!find(page, node => node.props?.['data-tooltip'] === '下一项媒体').props.disabled, 'Paused playback must still allow adjacent media');
page.props.onDoubleClick(); assert.equal(video.plays, 1, 'Double-click must resume paused playback without an unlock action');
page = render();
find(page, node => node.props?.['data-tooltip'] === '更多').props.onClick(); page = render();
assert.equal(find(page, node => node.props?.['data-tooltip'] === '更多').props['aria-expanded'], true);
find(page, node => node.props?.['aria-label'] === '倍速').props.onChange({ target: { value: '1.25' } });
assert.equal(video.playbackRate, 1.25, 'The speed menu must change actual video playback rate');
const pending = [...timers.values()].at(-1);
assert.equal(pending.ms, 3000, 'Browser inactivity timer must use 3 seconds');
pending.callback(); page = render();
assert(!page.props.className.includes('cursor-none'), 'An open menu must keep controls visible');
actions.exit(); page = render();
assert.equal(navigation.length, 0, 'First Escape must close the menu without leaving playback');
assert.equal(find(page, node => node.props?.['data-tooltip'] === '更多').props['aria-expanded'], false);
actions.exit(); assert.deepEqual(navigation, [-1]);
find(page, node => node.props?.['data-tooltip'] === '更多').props.onClick(); page = render();
page.props.onClick(); page = render();
page.props.onDoubleClick();
assert.equal(video.pauses, 1, 'Dismissing a menu must not turn the same double-click into a background pause');
page.props.onMouseMove();
[...timers.values()].at(-1).callback(); page = render();
actions.togglePlay();
find(page, node => node.type === 'video').props.onPause();
page = render();
assert(page.props.className.includes('cursor-none'), 'Pause events must not wake hidden controls');
actions.togglePlay();
find(page, node => node.type === 'video').props.onPlay();
page = render();
assert(page.props.className.includes('cursor-none'), 'Idle controls must hide when no overlay is open');
console.log('PASS: actual browser player double-click pause/resume, paused controls, hidden Space playback, speed selection, menu Escape, 3-second inactivity and overlay protection');
