/** Exercise lens geometry, bounded textures and the actual component's resize lifecycle. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');
function load(file, imports = {}, globals = {}) {
  const code = esbuild.transformSync(fs.readFileSync(file, 'utf8'), {
    loader: file.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', jsx: 'automatic',
  }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), code)(
    name => imports[name] ?? require(name), module, module.exports, ...Object.values(globals));
  return module.exports;
}

let canvases = 0;
const textures = [];
const documentFixture = { createElement() {
  const canvas = { width: 0, height: 0,
    getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData(image) { textures.push({ width: canvas.width, height: canvas.height, image }); } }),
    toDataURL: () => `data:image/png;fixture,${++canvases}` };
  return canvas;
} };
const geometry = load('src/utils/liquidGlass.ts', {}, { document: documentFixture });
for (const [w, h, radius] of [[420, 200, 24], [1200, 52, 18], [64, 600, 28], [320, 88, 18]]) {
  for (const profile of ['regular', 'prominent']) {
    assert.deepEqual(geometry.glassDisplacement(w / 2, h / 2, w, h, radius, profile), { x: 0, y: 0 }, 'Center must not bend text or scenery');
    assert.deepEqual(geometry.glassDisplacement(-5, h / 2, w, h, radius, profile), { x: 0, y: 0 }, 'Outside the glass must remain unchanged');
    const left = geometry.glassDisplacement(4, h / 2, w, h, radius, profile);
    const right = geometry.glassDisplacement(w - 4, h / 2, w, h, radius, profile);
    assert(left.x < 0 && right.x > 0 && Math.abs(left.x + right.x) < 1e-8, 'Opposite rims must bend symmetrically');
    assert.equal(left.y, 0, 'Straight rims must not introduce diagonal distortion');
    const top = geometry.glassDisplacement(w / 2, 4, w, h, radius, profile);
    assert(top.y < 0 && top.x === 0);
    const texture = geometry.glassDisplacementMap(w, h, radius, profile);
    assert.equal(geometry.glassDisplacementMap(w, h, radius, profile), texture, 'Repeated dimensions and material must reuse their lens');
    const latest = textures.at(-1);
    assert(latest.width <= 384 && latest.height <= 384, 'Large panels must retain bounded texture cost');
    assert(latest.image.data.every((v, index) => index % 4 !== 3 || v === 255), 'Lens pixels must be fully opaque');
  }
}
const corner = geometry.glassDisplacement(13, 13, 200, 200, 24);
assert(corner.x < 0 && corner.y < 0, 'Rounded corners need a two-axis lens');
assert.equal(geometry.glassDisplacement(24, 200, 420, 400, 28).x, 0, 'The established regular material must retain its narrow rim');
assert(geometry.glassDisplacement(24, 200, 420, 400, 28, 'prominent').x < 0, 'Prominent panels need a broader optical rim');
geometry.glassDisplacementMap(1040, 8000, 28, 'prominent');
const longTexture = textures.at(-1);
const pixel = (texture, x, y, channel) => texture.image.data[(y * texture.width + x) * 4 + channel];
for (let depth = 0; depth < 3; depth++) {
  assert(pixel(longTexture, depth, Math.floor(longTexture.height / 2), 0) < 128, 'Long panels must preserve a sampled left rim');
  assert(pixel(longTexture, Math.floor(longTexture.width / 2), depth, 1) < 128, 'Long panels must preserve a sampled top rim');
  assert(pixel(longTexture, longTexture.width - 1 - depth, Math.floor(longTexture.height / 2), 0) > 128, 'Rounded texture dimensions must preserve the right rim');
  assert(pixel(longTexture, Math.floor(longTexture.width / 2), longTexture.height - 1 - depth, 1) > 128, 'Rounded texture dimensions must preserve the bottom rim');
}
assert.equal(pixel(longTexture, Math.floor(longTexture.width / 2), Math.floor(longTexture.height / 2), 0), 128, 'Large-panel center must remain neutral');
const cached = geometry.glassDisplacementMap(90, 300, 24, 'prominent');
for (let i = 0; i < 16; i++) geometry.glassDisplacementMap(400 + i, 600, 24, 'prominent');
assert.notEqual(geometry.glassDisplacementMap(90, 300, 24, 'prominent'), cached, 'The lens cache must evict after 16 distinct textures');
console.log('PASS: neutral centers, prominent optical rims, long-panel sampling, symmetric refraction and bounded texture caching');

const effects = [], refs = [], states = [], frames = new Map(), observers = [];
let cursor = 0, refCursor = 0, frameId = 0;
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useId: () => ':fixture:',
  useRef: value => refs[refCursor++] ??= { current: value },
  useState: initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
  useEffect: (callback, dependencies) => effects.push({ callback, dependencies }),
};
class Observer {
  constructor(callback) { this.callback = callback; observers.push(this); }
  observe(node) { this.node = node; }
  disconnect() { this.disconnected = true; }
}
const globals = {
  ResizeObserver: Observer, navigator: { userAgent: 'Chrome/140' },
  getComputedStyle: () => ({ borderTopLeftRadius: '24px' }),
  requestAnimationFrame: callback => { const id = ++frameId; frames.set(id, callback); return id; },
  cancelAnimationFrame: id => frames.delete(id),
};
const LiquidGlass = load('src/components/LiquidGlass.tsx', {
  react, '../utils/liquidGlass': geometry,
  'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
}, globals).default;
let forwarded = 0;
const render = props => { cursor = 0; refCursor = 0; return LiquidGlass(props); };
const props = { interactive: true, children: 'Clear content', onPointerMove: () => forwarded++ };
const tree = render(props);
assert.equal(tree.type, 'div', 'Existing surfaces must keep the default div root');
const css = new Map();
const node = { clientWidth: 420, clientHeight: 200,
  style: { setProperty: (key, value) => css.set(key, value), removeProperty: key => css.delete(key) },
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 420, height: 200 }) };
tree.props.ref.current = node;
let dispose = effects[0].callback();
observers[0].callback(); observers[0].callback();
assert.equal(frames.size, 1, 'Resize bursts must be coalesced');
const runFrame = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); };
runFrame();
assert(states[0]?.url, 'A visible Chromium panel must get a lens');
const canvasCount = canvases;
for (let i = 0; i < 25; i++) tree.props.onPointerMove({ pointerType: 'mouse', currentTarget: node, clientX: i, clientY: i });
assert.equal(canvases, canvasCount, 'Pointer highlights must not regenerate textures or trigger lens state updates');
assert.equal(forwarded, 25, 'Consumer pointer handlers must continue to work');
tree.props.onPointerLeave({});
assert.equal(css.size, 0, 'Pointer highlights must reset on leave');
const findNodes = (node, type) => {
  if (!node || typeof node !== 'object') return [];
  const children = [node.props?.children].flat();
  return [...(node.type === type ? [node] : []), ...children.flatMap(child => findNodes(child, type))];
};
const scaleValues = node => findNodes(node, 'feDisplacementMap').map(filter => filter.props.scale);
assert.deepEqual(scaleValues(render(props)), [22, 20, 18], 'Existing regular material must retain its RGB displacement');
assert.deepEqual(scaleValues(render({ ...props, intensity: 'subtle', tone: 'dark' })), [10, 9, 8], 'Player/subtle material must retain its RGB displacement');
assert.deepEqual(effects.at(-1).dependencies, ['regular', 'div'], 'Subtle and regular surfaces share the same lens geometry');
const prominent = render({ ...props, intensity: 'prominent' });
assert.deepEqual(scaleValues(prominent), [48, 43, 38], 'Prominent panels must apply stronger RGB refraction only to the background');
assert.equal(prominent.props.children.at(-1), 'Clear content', 'Content must remain outside the backdrop SVG filter');
assert.deepEqual(effects.at(-1).dependencies, ['prominent', 'div'], 'Switching intensity must refresh the observed material');
const oldLens = states[0].url;
observers[0].callback(); dispose();
assert(observers[0].disconnected && frames.size === 0, 'Unmount must dispose the observer and queued rendering');
dispose = effects.at(-1).callback(); runFrame();
assert.notEqual(states[0].url, oldLens, 'The prominent lens must replace the cached regular lens at identical dimensions');
const prominentLens = states[0];
observers[1].callback(); runFrame();
assert.equal(states[0], prominentLens, 'Repeated resize notifications must retain unchanged lens state');
dispose();
dispose = effects.at(-1).callback(); runFrame(); dispose();
assert(observers[2].disconnected && frames.size === 0, 'StrictMode setup/cleanup/setup must remain safe');
const phrasing = render({ ...props, as: 'span', intensity: 'prominent' });
assert.equal(phrasing.type, 'span', 'Button material must use native phrasing content');
assert.strictEqual(phrasing.props.ref, tree.props.ref, 'Both supported elements share the same geometry ref');
assert.deepEqual(effects.at(-1).dependencies, ['prominent', 'span'], 'Changing the native element must refresh its geometry observer');
console.log('PASS: actual glass component RGB presets, intensity updates, resize coalescing, pointer handlers and StrictMode cleanup');
