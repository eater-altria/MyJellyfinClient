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
  '../components/LiquidGlass': { default: function LiquidGlass() {} },
  '../player/liquid-glass.css': {},
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
page.props.onMouseMove(); page = render();
video.volume = 1; video.muted = true;
find(page, node => node.type === 'video').props.onVolumeChange(); page = render();
const sliderNode = find(page, node => node.type?.name === 'VolumeSlider');
assert(sliderNode, 'Volume must be directly adjustable in the control bar');
let slider = sliderNode.type(sliderNode.props);
assert.equal(slider.props['aria-valuenow'], 0, 'Muted slider must display zero without losing the saved volume');
slider.props.children.props.ref.current = { getBoundingClientRect: () => ({ left: 100, width: 64 }) };
slider.props.onPointerDown({ currentTarget: { setPointerCapture() {} }, pointerId: 1, clientX: 116, preventDefault() {} });
assert.equal(video.volume, 0.25); assert.equal(video.muted, false, 'Dragging a positive value must unmute');
[...timers.values()].at(-1).callback(); page = render();
assert(!page.props.className.includes('cursor-none'), 'A volume drag must prevent auto-hide');
slider.props.onPointerMove({ buttons: 1, clientX: 300 });
assert.equal(video.volume, 1, 'Pointer volume must clamp at 100 percent');
slider.props.onPointerMove({ buttons: 1, clientX: 0 });
assert.equal(video.volume, 0, 'Pointer volume must clamp at zero');
slider.props.onPointerUp({ clientX: 0 });
find(page, node => node.type === 'video').props.onVolumeChange(); page = render();
const currentSlider = find(page, node => node.type?.name === 'VolumeSlider');
slider = currentSlider.type(currentSlider.props);
slider.props.onKeyDown({ key: 'End', preventDefault() {}, stopPropagation() {} });
assert.equal(video.volume, 1, 'Keyboard must support direct slider adjustment');
find(page, node => node.props?.['aria-label'] === '静音 · M').props.onClick();
assert.equal(video.muted, true); assert.equal(video.volume, 1, 'The existing mute button must preserve volume');
[...timers.values()].at(-1).callback(); page = render();
assert(page.props.className.includes('cursor-none'), 'Auto-hide must resume after the volume drag ends');
console.log('PASS: inline volume slider, pointer and keyboard adjustments, mute preservation and drag auto-hide protection');
page.props.onMouseMove(); page = render();
const seekNode = find(page, node => node.type?.name === 'SeekBar');
let seek = seekNode.type({ ...seekNode.props, duration: 100, onSeek: value => { video.currentTime = value; } });
seek.props.children[0].props.ref.current = { getBoundingClientRect: () => ({ left: 100, width: 400 }) };
seek.props.onPointerDown({ currentTarget: { setPointerCapture() {} }, pointerId: 1, clientX: 200, preventDefault() {} });
assert.equal(video.currentTime, 25);
seek.props.onPointerLeave();
seek.props.onPointerMove({ clientX: 600, clientY: -100 });
assert.equal(video.currentTime, 100, 'Captured seek dragging must continue outside the slider');
[...timers.values()].at(-1).callback(); page = render();
assert(!page.props.className.includes('cursor-none'), 'A held seek drag must prevent auto-hide');
seek.props.onPointerUp({ clientX: 0 });
assert.equal(video.currentTime, 0, 'Release outside the bar must apply the final clamped position');
seek.props.onPointerMove({ clientX: 300 }); assert.equal(video.currentTime, 0, 'Seeking must stop after release');
seek.props.onPointerDown({ currentTarget: { setPointerCapture() {} }, pointerId: 2, clientX: 200, preventDefault() {} });
seek.props.onLostPointerCapture();
seek.props.onPointerMove({ clientX: 300 }); assert.equal(video.currentTime, 25, 'Lost capture must end the seek drag');
console.log('PASS: seek dragging outside the bar, final release position, capture loss and auto-hide protection');

// Exercise the page's actual media events and resulting seek-bar layers.
video.duration = 100;
video.currentTime = 25;
let bufferedRanges = [[0, 40], [60, 80]];
video.buffered = { get length() { return bufferedRanges.length; },
  start: i => bufferedRanges[i][0], end: i => bufferedRanges[i][1] };
let videoNode = find(page, node => node.type === 'video');
videoNode.props.onDurationChange();
videoNode.props.onTimeUpdate();
videoNode.props.onProgress();
page = render();
let cacheSeekNode = find(page, node => node.type?.name === 'SeekBar');
assert.deepEqual(cacheSeekNode.props.buffered, [[0, 40], [60, 80]], 'Read actual buffered TimeRanges, preserving unbuffered gaps');
seek = cacheSeekNode.type(cacheSeekNode.props);
const track = seek.props.children[0];
const fills = track.props.children[0];
assert(track.props.className.includes('bg-white/[0.18]'));
assert.deepEqual(fills.map(fill => fill.props.style), [{ left: '0%', width: '40%' }, { left: '60%', width: '20%' }]);
assert(fills.every(fill => fill.props.className.includes('bg-white/40')));
assert.equal(track.props.children[1].props.style.width, '25%', 'The brighter played fill must remain above the cached fills');
assert(track.props.children[1].props.className.includes('bg-white/[0.82]'));
bufferedRanges = [[70, 90]];
videoNode = find(page, node => node.type === 'video');
videoNode.props.onSeeked(); page = render();
assert.deepEqual(find(page, node => node.type?.name === 'SeekBar').props.buffered, [[70, 90]], 'Seeking must refresh cache ranges even without another progress event');
bufferedRanges = [];
find(page, node => node.type === 'video').props.onTimeUpdate(); page = render();
assert.deepEqual(find(page, node => node.type?.name === 'SeekBar').props.buffered, [], 'Cache eviction must remove stale ranges during playback');
seek = cacheSeekNode.type({ ...cacheSeekNode.props, buffered: [[-10, 20], [90, 120], [110, 130], [10, 5], [NaN, 50]] });
assert.deepEqual(seek.props.children[0].props.children[0].map(fill => fill.props.style),
  [{ left: '0%', width: '20%' }, { left: '90%', width: '10%' }], 'Cache fills must stay inside the finite timeline');
seek = cacheSeekNode.type({ ...cacheSeekNode.props, duration: 0 });
assert.equal(seek.props['aria-disabled'], true, 'Unknown duration must keep the seek bar disabled');
find(page, node => node.type === 'video').props.onEmptied(); page = render();
assert.deepEqual(find(page, node => node.type?.name === 'SeekBar').props.buffered, [], 'Emptying the media element must clear cache display');
console.log('PASS: actual cache events, layered playback/cache progress, discontinuous ranges, seeking, eviction, bounds and media reset');
