/** Exercise the actual transient Zustand store without media servers or saved accounts. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');

const storageCalls = [];
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: key => { storageCalls.push(['get', key]); return null; },
    setItem: (key, value) => storageCalls.push(['set', key, value]),
    removeItem: key => storageCalls.push(['remove', key]),
  },
});

try {
  const bundle = esbuild.buildSync({
    entryPoints: ['src/store/appBackdrop.ts'], bundle: true, platform: 'node',
    format: 'cjs', write: false, external: ['react'],
  }).outputFiles[0].text;
  const moduleFixture = { exports: {} };
  new Function('require', 'module', 'exports', bundle)(require, moduleFixture, moduleFixture.exports);
  const store = moduleFixture.exports.useAppBackdrop;
  assert.equal(store.getState().source, null, 'The shell must start with the gradient fallback');

  const firstOwner = {}, secondOwner = {};
  const firstRoute = '/server/fixture-a', secondRoute = '/server/fixture-b';
  const firstUrl = 'https://artwork.fixture.test/first.png';
  const secondUrl = 'https://artwork.fixture.test/second.png';
  const updates = [];
  const unsubscribe = store.subscribe(state => updates.push(state.source));

  store.getState().setBackdrop(firstOwner, firstRoute, firstUrl);
  assert.deepEqual(store.getState().source, { owner: firstOwner, route: firstRoute, url: firstUrl });
  assert.equal(store.getState().source.owner, firstOwner, 'Artwork ownership must use the home instance identity');
  const firstSource = store.getState().source;
  const updateCount = updates.length;
  store.getState().setBackdrop(firstOwner, firstRoute, firstUrl);
  assert.equal(store.getState().source, firstSource, 'Republishing unchanged artwork must retain the source');
  assert.equal(updates.length, updateCount, 'Unchanged carousel artwork must not rerender the shell');

  store.getState().setBackdrop(firstOwner, firstRoute, secondUrl);
  assert.equal(store.getState().source.url, secondUrl, 'Changing the current slide must replace its ambient artwork');
  store.getState().setBackdrop(secondOwner, secondRoute, secondUrl);
  assert.equal(store.getState().source.owner, secondOwner, 'Even identical images must belong to the new home instance');
  assert.equal(store.getState().source.route, secondRoute, 'Artwork must remain scoped to the new route');

  const currentSource = store.getState().source;
  const currentUpdates = updates.length;
  store.getState().clearBackdrop(firstOwner);
  assert.equal(store.getState().source, currentSource, 'Unmounting an older home must not clear a newer home');
  assert.equal(updates.length, currentUpdates, 'An unrelated cleanup must not notify subscribers');
  store.getState().setBackdrop(firstOwner, firstRoute, null);
  assert.equal(store.getState().source, currentSource, 'An older empty-image callback must not clear the new owner');
  store.getState().setBackdrop(secondOwner, secondRoute, null);
  assert.equal(store.getState().source, null, 'Disabling current previews must restore the gradient fallback');

  store.getState().setBackdrop(secondOwner, secondRoute, secondUrl);
  store.getState().clearBackdrop(secondOwner);
  assert.equal(store.getState().source, null, 'Leaving the active home must release its artwork');
  unsubscribe();
  assert.equal(storageCalls.length, 0, 'Artwork URLs and ownership must never enter persistent storage');
  console.log('PASS: transient shell artwork, slide updates, deduplicated subscriptions, scoped ownership and cleanup');

  // Render the real shell component against the real store with a minimal hook runner.
  const hooks = [], effects = [];
  let cursor = 0, pathname = firstRoute;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, next => {
        hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next;
      }];
    },
    useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
    useEffect(callback, dependencies) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        effects.push(() => {
          previous?.cleanup?.();
          hooks[index] = { dependencies, cleanup: callback() };
        });
      }
    },
  };
  const imports = {
    '../hooks/useBrowseActivity': { useBrowseActivity: () => true },
    react, 'react-router-dom': { useLocation: () => ({ pathname }) },
    '../store/appBackdrop': { useAppBackdrop: selector => selector(store.getState()) },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
  };
  const componentCode = esbuild.transformSync(fs.readFileSync('src/components/AppBackdrop.tsx', 'utf8'), {
    loader: 'tsx', format: 'cjs', jsx: 'automatic',
  }).code;
  const componentModule = { exports: {} };
  new Function('require', 'module', 'exports', componentCode)(
    name => imports[name] ?? require(name), componentModule, componentModule.exports);
  const AppBackdrop = componentModule.exports.default;
  const renderBackdrop = () => {
    cursor = 0;
    const result = AppBackdrop();
    for (const effect of effects.splice(0)) effect();
    return result;
  };
  assert.equal(renderBackdrop(), null, 'No current artwork must use the CSS gradient fallback');
  store.getState().setBackdrop(firstOwner, firstRoute, firstUrl);
  let scene = renderBackdrop();
  assert.equal(scene.props['aria-hidden'], 'true', 'Ambient imagery must stay out of the accessibility tree');
  assert.equal(scene.props.children.type, 'img', 'The shell must mount a single current artwork image');
  assert.equal(scene.props.children.props.src, firstUrl);
  pathname = '/settings';
  assert.equal(renderBackdrop(), null, 'Route changes must immediately hide stale home imagery');
  pathname = firstRoute;
  scene = renderBackdrop();
  scene.props.children.props.onError();
  assert.equal(renderBackdrop(), null, 'Failed images must quietly restore the gradient fallback');
  store.getState().setBackdrop(secondOwner, firstRoute, firstUrl);
  scene = renderBackdrop();
  assert(scene, 'A new home instance must be able to retry the same previously failed artwork');
  scene.props.children.props.onLoad?.();
  store.getState().setBackdrop(secondOwner, firstRoute, secondUrl);
  scene = renderBackdrop();
  assert.equal(scene.props.children.props.src, secondUrl, 'The scene must follow the current carousel URL');
  store.getState().clearBackdrop(secondOwner);
  assert.equal(renderBackdrop(), null, 'Cleared artwork must unmount the decorative image');
  assert.equal(storageCalls.length, 0, 'Component rendering must not persist artwork');
  console.log('PASS: actual shell component route scoping, one-image rendering, errors and new-session retry');

  // Exercise the actual detail-page publisher and its effect cleanup against the same store.
  hooks.length = 0;
  effects.length = 0;
  let showPreviewImage = true;
  const detailImports = {
    ...imports,
    '../store/appBackdrop': { useAppBackdrop: store },
    '../store/settings': { useSettings: selector => selector({ showPreviewImage }) },
  };
  const detailCode = esbuild.transformSync(fs.readFileSync('src/components/BackdropPage.tsx', 'utf8'), {
    loader: 'tsx', format: 'cjs', jsx: 'automatic',
  }).code;
  const detailModule = { exports: {} };
  new Function('require', 'module', 'exports', detailCode)(
    name => detailImports[name] ?? require(name), detailModule, detailModule.exports);
  const BackdropPage = detailModule.exports.default;
  const firstItem = { Id: 'detail-1' }, secondItem = { Id: 'detail-2' };
  const artworkCalls = [];
  const detailApi = {
    backdropUrl(item, maxWidth) {
      artworkCalls.push({ itemId: item.Id, maxWidth });
      return item.Id === firstItem.Id ? firstUrl : secondUrl;
    },
  };
  const renderDetail = item => {
    cursor = 0;
    const result = BackdropPage({ api: detailApi, item, children: 'detail-content' });
    for (const effect of effects.splice(0)) effect();
    return result;
  };
  const findImages = tree => {
    if (!tree || typeof tree !== 'object') return [];
    if (Array.isArray(tree)) return tree.flatMap(findImages);
    return [...(tree.type === 'img' ? [tree] : []), ...findImages(tree.props?.children)];
  };
  const unmountDetail = () => {
    for (const hook of hooks) hook?.cleanup?.();
    hooks.length = 0;
  };

  pathname = `${firstRoute}/movie/${firstItem.Id}`;
  let detail = renderDetail(firstItem);
  const detailSource = store.getState().source;
  assert(detailSource, 'A detail page with artwork must publish its ambient background');
  assert.equal(detailSource.url, firstUrl);
  assert.equal(detailSource.route, pathname, 'Detail artwork must be scoped to its current route');
  assert.equal(findImages(detail)[0].props.src, detailSource.url, 'The shell must reuse the exact detail backdrop URL');
  assert.deepEqual(artworkCalls, [{ itemId: firstItem.Id, maxWidth: 1920 }], 'Detail rendering must resolve one existing 1920px artwork URL');
  renderDetail(firstItem);
  assert.equal(store.getState().source, detailSource, 'Unchanged detail artwork must retain its current source');

  detail = renderDetail(secondItem);
  assert.equal(store.getState().source.owner, detailSource.owner, 'Item changes must keep the current detail instance owner');
  assert.equal(store.getState().source.url, secondUrl, 'Changing detail items must replace the ambient artwork');
  assert.equal(findImages(detail)[0].props.src, secondUrl);
  pathname = `${firstRoute}/movie/${secondItem.Id}`;
  renderDetail(secondItem);
  assert.equal(store.getState().source.route, pathname, 'Changing routes must republish even the same artwork URL');
  assert(artworkCalls.every(call => call.maxWidth === 1920), 'Ambient publication must retain the detail backdrop resolution');

  showPreviewImage = false;
  const beforeDisabledArtworkCalls = artworkCalls.length;
  detail = renderDetail(secondItem);
  assert.equal(findImages(detail).length, 0, 'Disabling previews must also remove the detail cover image');
  assert.equal(artworkCalls.length, beforeDisabledArtworkCalls, 'Disabled previews must not resolve an artwork URL');
  assert.equal(store.getState().source, null, 'Disabling previews must release detail ambient artwork');
  showPreviewImage = true;
  renderDetail(secondItem);
  assert.equal(store.getState().source.url, secondUrl, 'Reenabling previews must restore the current detail artwork');
  renderDetail(null);
  assert.equal(store.getState().source, null, 'Missing detail metadata must restore the gradient fallback');
  renderDetail(firstItem);
  unmountDetail();
  assert.equal(store.getState().source, null, 'Unmounting the active detail page must release its artwork');

  renderDetail(secondItem);
  const homeOwner = {};
  store.getState().setBackdrop(homeOwner, firstRoute, firstUrl);
  const newerHomeSource = store.getState().source;
  unmountDetail();
  assert.equal(store.getState().source, newerHomeSource, 'An older detail cleanup must not clear a newer home owner');
  store.getState().clearBackdrop(homeOwner);
  assert.equal(storageCalls.length, 0, 'Detail publication and cleanup must never persist authenticated artwork URLs');
  console.log('PASS: actual detail backdrop publication, shared 1920px URL, item/route updates, preview toggles and scoped cleanup');
} finally {
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
  else delete globalThis.localStorage;
}
