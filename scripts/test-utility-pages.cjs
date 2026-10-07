/** Exercise search/history retries and stale responses through the actual page effects. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');

function load(file, imports = {}) {
  const code = esbuild.transformSync(fs.readFileSync(file, 'utf8'), {
    loader: file.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', jsx: 'automatic',
  }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => imports[name] ?? require(name), module, module.exports);
  return module.exports;
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const find = (tree, predicate) => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree)
  ? tree.flatMap(node => find(node, predicate))
  : [...(predicate(tree) ? [tree] : []), ...find(tree.props?.children, predicate)];
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const mediaItem = id => ({ Id: id, Name: id, Type: 'Movie' });
const timers = new Map();
let timerId = 0;
global.window = {
  setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
  clearTimeout(id) { timers.delete(id); },
};
const runTimers = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };

function renderHarness(file, serverState) {
  let cursor = 0, unmounted = false, writesAfterUnmount = 0;
  const hooks = [], effects = [];
  const changed = (previous, deps) => !previous || deps.some((value, index) => !Object.is(value, previous[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, next => {
        if (unmounted) writesAfterUnmount++;
        hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next;
      }];
    },
    useRef(initial) { const index = cursor++; hooks[index] ??= { current: initial }; return hooks[index]; },
    useMemo(factory, deps) {
      const index = cursor++;
      if (changed(hooks[index]?.deps, deps)) hooks[index] = { value: factory(), deps };
      return hooks[index].value;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (changed(hooks[index]?.deps, deps)) effects.push(() => {
        hooks[index]?.cleanup?.();
        hooks[index] = { deps, cleanup: effect() };
      });
    },
  };
  const useServers = Object.assign(selector => selector(serverState), {
    getState: () => ({ getApi: id => serverState.apis[id] }),
  });
  const component = load(file, {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'react-router-dom': { useNavigate: () => () => {} },
    '../store/servers': { useServers },
    '../store/settings': { useSettings: selector => selector({ showItemCountInTitle: true, sortFoldersSeparately: false }) },
    '../utils/listPresentation': { orderMediaItems: items => items },
    '../components/PosterCard': { __esModule: true, default: 'Poster' },
    '../components/LiquidGlass': { __esModule: true, default: 'Glass' },
    '../components/Feedback': { EmptyState: 'Empty', ErrorState: 'Error', Spinner: 'Spinner' },
    '../components/icons': { IconSearch: 'Icon', IconClose: 'Icon', IconHistory: 'Icon' },
  }).default;
  return {
    render() { cursor = 0; const tree = component(); effects.splice(0).forEach(effect => effect()); return tree; },
    unmount() { hooks.forEach(hook => hook?.cleanup?.()); unmounted = true; },
    get writesAfterUnmount() { return writesAfterUnmount; },
  };
}

function setSearch(page, term) {
  find(page.render(), node => node.type === 'input')[0].props.onChange({ target: { value: term } });
  page.render();
  runTimers();
}

(async () => {
  const searches = [];
  const searchApi = { search(term) { const request = deferred(); searches.push({ term, ...request }); return request.promise; } };
  const serverState = { activeServerId: 'first', apis: { first: searchApi, second: { ...searchApi } } };
  const search = renderHarness('src/pages/Search.tsx', serverState);
  search.render();
  setSearch(search, 'retry');
  searches.at(-1).reject(new Error('fixture failure'));
  await flush();
  let tree = search.render();
  const error = find(tree, node => node.type === 'Error')[0];
  assert(error && typeof error.props.onRetry === 'function', 'Search failure must offer retry');
  assert.equal(find(tree, node => node.type === 'Empty').length, 0, 'Failure must not appear as an empty search result');
  error.props.onRetry();
  search.render(); runTimers();
  assert.equal(searches.at(-1).term, 'retry');
  searches.at(-1).resolve({ Items: [mediaItem('retried')] });
  await flush();
  assert.deepEqual(find(search.render(), node => node.type === 'Poster').map(node => node.props.item.Id), ['retried']);

  setSearch(search, 'clear');
  const cleared = searches.at(-1);
  find(search.render(), node => node.type === 'button' && node.props['aria-label'] === '清除搜索')[0].props.onClick();
  search.render();
  cleared.resolve({ Items: [mediaItem('stale-clear')] });
  await flush();
  tree = search.render();
  assert.equal(find(tree, node => node.type === 'Poster').length, 0, 'Clearing search must ignore an already-running response');
  assert.equal(find(tree, node => node.type === 'Empty')[0].props.title, '搜索你的媒体库');

  setSearch(search, 'servers');
  const firstServerSearch = searches.at(-1);
  serverState.activeServerId = 'second'; search.render(); runTimers();
  const secondServerSearch = searches.at(-1);
  firstServerSearch.resolve({ Items: [mediaItem('stale-server')] });
  secondServerSearch.resolve({ Items: [mediaItem('current-server')] });
  await flush();
  assert.deepEqual(find(search.render(), node => node.type === 'Poster').map(node => node.props.item.Id), ['current-server']);
  setSearch(search, 'unmount');
  search.unmount(); searches.at(-1).resolve({ Items: [mediaItem('stale-unmount')] });
  await flush();
  assert.equal(search.writesAfterUnmount, 0, 'Unmounted search must not update state');
  console.log('PASS: search failure/retry, clear action, server changes and unmount ignore stale responses');

  const historyRequests = [];
  const historyApi = { getPlayedItems() { const request = deferred(); historyRequests.push(request); return request.promise; } };
  const historyState = { activeServerId: 'first', apis: { first: historyApi, second: { ...historyApi } } };
  const history = renderHarness('src/pages/History.tsx', historyState);
  history.render(); historyRequests.at(-1).reject(new Error('fixture failure')); await flush();
  find(history.render(), node => node.type === 'Error')[0].props.onRetry();
  history.render(); historyRequests.at(-1).resolve({ Items: [mediaItem('history-retried')] }); await flush();
  assert.deepEqual(find(history.render(), node => node.type === 'Poster').map(node => node.props.item.Id), ['history-retried']);
  historyState.activeServerId = 'second'; history.render();
  const staleHistory = historyRequests.at(-1);
  historyState.activeServerId = 'first'; history.render();
  staleHistory.resolve({ Items: [mediaItem('history-stale')] });
  historyRequests.at(-1).resolve({ Items: [mediaItem('history-current')] }); await flush();
  assert.deepEqual(find(history.render(), node => node.type === 'Poster').map(node => node.props.item.Id), ['history-current']);
  historyState.activeServerId = 'second'; history.render(); history.unmount();
  historyRequests.at(-1).resolve({ Items: [mediaItem('history-unmounted')] }); await flush();
  assert.equal(history.writesAfterUnmount, 0, 'Unmounted history must not update state');
  console.log('PASS: history retries, server changes and unmount ignore stale responses');

  // React StrictMode runs effect setup/cleanup/setup on the first mount.
  global.HTMLElement = class HTMLElement {
    focus() { document.activeElement = this; }
  };
  const trigger = new HTMLElement(), firstInput = new HTMLElement();
  global.document = { activeElement: trigger };
  const dialogEffects = [];
  const Dialog = load('src/components/AddServerDialog.tsx', {
    react: {
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
      useRef: () => ({ current: { querySelector: () => firstInput } }),
      useId: () => 'dialog-fixture',
      useEffect: effect => { dialogEffects.push(effect); },
    },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '../store/servers': { useServers: selector => selector({ addServer() {}, updateServer() {} }) },
    '../api/mediaServer': { ApiError: class ApiError extends Error {}, serverProtocolName: value => value },
    '../api/detectServer': { ServerDetectionError: class ServerDetectionError extends Error {} },
    './icons': { IconClose: 'Icon', IconJellyfin: 'Icon', IconEmby: 'Icon' },
    './LiquidGlass': { __esModule: true, default: 'Glass' },
  }).default;
  Dialog({ onClose() {} });
  firstInput.focus(); // React's autoFocus during the commit.
  const cleanup = dialogEffects[0]();
  assert.equal(document.activeElement, firstInput);
  cleanup();
  assert.equal(document.activeElement, trigger, 'Closing the dialog restores its trigger focus');
  const strictCleanup = dialogEffects[0]();
  assert.equal(document.activeElement, firstInput, 'StrictMode second setup must focus the dialog again');
  strictCleanup();
  assert.equal(document.activeElement, trigger);
  console.log('PASS: dialog focus enters after StrictMode effect replay and restores on close');
})().catch(error => { console.error(error); process.exitCode = 1; });
