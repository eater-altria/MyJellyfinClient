/** Render the real list components with changing settings, plus protocol-independent data fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(file, imports = {}) {
  const code = esbuild.transformSync(fs.readFileSync(file, 'utf8'), { loader: file.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', jsx: 'automatic' }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((name) => imports[name] ?? require(name), module, module.exports);
  return module.exports;
}

const identity = load('src/utils/clientIdentity.ts', { './defaultClientIdentity.json': require('../src/utils/defaultClientIdentity.json') });
const media = load('src/api/mediaServer.ts', { '../utils/clientIdentity': identity });
const presentation = load('src/utils/listPresentation.ts', { '../api/mediaServer': media });
const defaults = {
  showItemCountInTitle: true, showFolderTime: true, sortFoldersSeparately: true,
  thumbnailFill: true, showPreviewImage: true, previewTimePercent: 10, preferEmbeddedCover: true,
  showPlayProgress: true, showMediaDuration: true, showFileSize: true, showNewBadge: true,
  showHdrBadge: true, showFrameRate: true, showResolution: true, simplifyResolution: true,
};
let settings = { ...defaults };
const store = { useSettings: (selector) => selector ? selector(settings) : settings };
const api = new media.MediaServerApi('https://fixture.example/emby', 'fixture-token', 'user', 'emby');
const icons = load('src/components/icons.tsx');
const PosterCard = load('src/components/PosterCard.tsx', {
  '../api/mediaServer': media, '../store/settings': store, '../utils/listPresentation': presentation, './icons': icons,
}).default;
const glass = load('src/utils/liquidGlass.ts');
const LiquidGlass = load('src/components/LiquidGlass.tsx', { '../utils/liquidGlass': glass });
const GlassButton = load('src/components/GlassButton.tsx', { './LiquidGlass': LiquidGlass });
const ListNavigation = load('src/components/ListNavigation.tsx', { './GlassButton': GlassButton, './icons': icons });
const SectionRow = load('src/components/SectionRow.tsx', {
  '../store/settings': store, './LiquidGlass': LiquidGlass, './ListNavigation': ListNavigation,
}).default;
const EpisodeRow = load('src/components/EpisodeRow.tsx', {
  './PosterCard': { __esModule: true, default: PosterCard }, 'react-router-dom': { useNavigate: () => () => {} },
}).default;
const item = {
  Id: 'movie', Name: 'Fixture', Type: 'Movie', DateCreated: new Date(Date.now() - 1000).toISOString(),
  ImageTags: { Primary: 'poster', Thumb: 'thumb' }, RunTimeTicks: 120 * 10_000_000,
  UserData: { PlayedPercentage: 25, PlaybackPositionTicks: 30 * 10_000_000 },
  MediaSources: [{ Id: 'source', Size: 2 * 1024 ** 3, MediaStreams: [
    { Type: 'Video', Width: 3840, Height: 1600, RealFrameRate: 23.976, VideoRangeType: 'HDR10' },
  ] }],
  Chapters: [
    { StartPositionTicks: 0, ImageTag: 'chapter-zero' },
    { StartPositionTicks: 30 * 10_000_000 }, // No image: don't request this index.
    { StartPositionTicks: 60 * 10_000_000, ImageTag: 'chapter-middle' },
    { StartPositionTicks: 110 * 10_000_000, ImageTag: 'chapter-last' },
  ],
};
const renderCard = (value = item) => renderToStaticMarkup(React.createElement(PosterCard, { api, item: value, landscape: true }));

const enabled = renderCard();
for (const text of ['object-cover', 'width:25%', '2分钟', '2.0GB', '23.976 fps', '4K', 'HDR10', '>New<', '剩余 01:30']) assert(enabled.includes(text), `Missing enabled metadata: ${text}`);
assert(enabled.includes('/Images/Thumb'), 'Cover preference uses server artwork');
assert(renderCard({ ...item, UserData: { PlaybackPositionTicks: 30 * 10_000_000 } }).includes('width:25%'), 'Servers that omit PlayedPercentage still display position-derived progress');
for (const [field, visibleText] of [
  ['showPlayProgress', 'width:25%'], ['showMediaDuration', '2分钟'], ['showFileSize', '2.0GB'],
  ['showNewBadge', '>New<'], ['showHdrBadge', 'HDR10'], ['showFrameRate', '23.976 fps'], ['showResolution', '4K'],
]) {
  settings = { ...defaults, [field]: false };
  assert(!renderCard().includes(visibleText), `${field} must hide its actual card content`);
}
settings = { ...defaults, showMediaDuration: false };
assert(!renderCard().includes('剩余'), 'Duration hides remaining time too');
settings = { ...defaults, showPlayProgress: false };
assert(!renderCard().includes('剩余'), 'Progress preference also hides position-derived remaining time');
settings = { ...defaults, thumbnailFill: false };
assert(renderCard().includes('object-contain')); assert(!renderCard().includes('object-cover'));
settings = { ...defaults, simplifyResolution: false };
assert(renderCard().includes('3840 × 1600')); assert(!renderCard().includes('>4K<'));
settings = { ...defaults, showPreviewImage: false };
assert(!renderCard().includes('<img'), 'Disabling media previews must stop image requests');
console.log('PASS: actual poster content respects preview, fit, progress, duration, size, New, HDR, frame rate and resolution toggles');

settings = { ...defaults, preferEmbeddedCover: false, previewTimePercent: 50 };
assert(renderCard().includes('/Images/Chapter/2?'), 'Preview percent selects the closest advertised chapter, retaining the original index');
settings.previewTimePercent = 100;
assert(renderCard().includes('/Images/Chapter/3?'));
settings.previewTimePercent = -10;
assert(renderCard().includes('/Images/Chapter/0?'));
settings.previewTimePercent = 50;
const preview = presentation.mediaPreviewUrls(api, item, settings, true);
assert(preview.fallback.includes('/Images/Thumb'), 'Chapter load errors have a server-artwork fallback');
assert(presentation.mediaPreviewUrls(api, { ...item, Chapters: [] }, settings, true).primary.includes('/Images/Thumb'));
assert(presentation.mediaPreviewUrls(api, { ...item, RunTimeTicks: undefined }, settings, true).primary.includes('/Images/Thumb'));
settings.preferEmbeddedCover = true;
assert(!renderCard().includes('/Images/Chapter'), 'Cover preference overrides percent only when artwork is actually available');
for (const protocol of ['jellyfin', 'emby']) {
  const protocolApi = new media.MediaServerApi(`https://fixture.example/${protocol}`, 'fixture-token', 'user', protocol);
  const result = presentation.mediaPreviewUrls(protocolApi, item, { ...defaults, preferEmbeddedCover: false, previewTimePercent: 50 });
  const image = new URL(result.primary);
  assert.equal(image.pathname, `/${protocol}/Items/movie/Images/Chapter/2`, `${protocol} uses an unambiguous image path index`);
  assert.equal(image.searchParams.get('api_key'), 'fixture-token');
  assert.equal(image.searchParams.get('tag'), 'chapter-middle');
}
console.log('PASS: server-cover priority, chapter timestamp selection, missing images/runtime and fallback behavior');

const folder = { ...item, Type: 'Series', IsFolder: true, DateCreated: '2026-01-02T12:00:00Z' };
settings = { ...defaults };
assert(renderCard(folder).includes('2026-01-02'));
settings.showFolderTime = false;
assert(!renderCard(folder).includes('2026-01-02'));
assert.equal(presentation.mediaFolderDate(item), '', 'Movie dates are not folder dates');
assert.equal(presentation.mediaFolderDate({ ...folder, DateCreated: 'invalid' }), '');
const title = () => renderToStaticMarkup(React.createElement(SectionRow, { title: 'Movies', count: 20 }, 'contents'));
const renderedText = (markup) => markup.replace(/<[^>]*>/g, '');
assert(renderedText(title()).includes('Movies（20）'));
const missingCount = renderToStaticMarkup(React.createElement(SectionRow, { title: 'Movies' }, 'contents'));
assert(!missingCount.includes('undefined')); assert(!missingCount.includes('Movies（'));
assert(renderedText(renderToStaticMarkup(React.createElement(SectionRow, { title: 'Movies', count: 0 }, 'contents'))).includes('Movies（0）'));
settings.showItemCountInTitle = false;
assert(!title().includes('（20）'));
const original = [{ Id: 'm1', Type: 'Movie' }, { Id: 's1', Type: 'Series' }, { Id: 'm2', Type: 'Movie' }, { Id: 's2', IsFolder: true }];
assert.strictEqual(presentation.orderMediaItems(original, false), original);
assert.deepEqual(presentation.orderMediaItems(original, true).map((entry) => entry.Id), ['s1', 's2', 'm1', 'm2']);
assert.deepEqual(presentation.mediaSortParams('DateCreated', 'Descending', true), { SortBy: 'IsFolder,DateCreated', SortOrder: 'Descending,Descending' });
assert.deepEqual(presentation.mediaSortParams('SortName', 'Ascending', false), { SortBy: 'SortName', SortOrder: 'Ascending' });
console.log('PASS: real section heading/folder date toggles and stable independent folder ordering including descending sorts');

settings = { ...defaults, showPlayProgress: false, showPreviewImage: false, showHdrBadge: false, showMediaDuration: false };
const episode = renderToStaticMarkup(React.createElement(EpisodeRow, { api, episodes: [{ ...item, Type: 'Episode', IndexNumber: 3, Overview: 'Episode details' }], serverId: 'server' }));
assert(episode.includes('E3 · Fixture')); assert(episode.includes('Episode details'));
assert(!episode.includes('<img')); assert(!episode.includes('width:25%')); assert(!episode.includes('HDR10')); assert(!episode.includes('2分钟'));
assert.equal(presentation.mediaResolution(1920, 800), '1080p');
assert.equal(presentation.mediaResolution(undefined, 800), '');
assert.equal(presentation.mediaHdrLabel({ VideoRangeType: 'SDR' }), '');
assert.equal(presentation.mediaHdrLabel({ VideoRangeType: 'DOVIWithHDR10' }), 'Dolby Vision');
assert.equal(presentation.mediaHdrLabel({ VideoRangeType: 'HDR10Plus' }), 'HDR10+');
assert(!presentation.isNewMedia({ ...item, DateCreated: undefined }));
assert(!presentation.isNewMedia({ ...item, UserData: { Played: true } }));
assert(!presentation.isNewMedia({ ...item, DateCreated: 'invalid' }));
assert(!presentation.isNewMedia({ ...item, DateCreated: '2030-01-01' }, Date.parse('2026-10-06')));
console.log('PASS: episode row shares settings and preserves details; letterboxed resolution, SDR/Dolby Vision and New-date edge cases');

/** Exercise the real library effects and pagination while a sorting preference changes. */
async function checkLibraryQueries() {
  let cursor = 0;
  const hooks = [];
  const effects = [];
  const changed = (previous, deps) => !previous || deps.some((value, index) => !Object.is(value, previous[index]));
  const react = {
    useState: (initial) => {
      const index = cursor++;
      hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, (next) => { hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next; }];
    },
    useRef: (initial) => {
      const index = cursor++;
      hooks[index] ??= { current: initial };
      return hooks[index];
    },
    useMemo: (factory, deps) => {
      const index = cursor++;
      if (changed(hooks[index]?.deps, deps)) hooks[index] = { value: factory(), deps };
      return hooks[index].value;
    },
    useEffect: (effect, deps) => {
      const index = cursor++;
      if (changed(hooks[index]?.deps, deps)) effects.push(() => {
        hooks[index]?.cleanup?.();
        hooks[index] = { deps, cleanup: effect() };
      });
    },
  };
  react.useCallback = (callback, deps) => react.useMemo(() => callback, deps);
  const queries = [];
  let resolveOldPage;
  const oldPage = new Promise((resolve) => { resolveOldPage = resolve; });
  const firstPage = Array.from({ length: 120 }, (_, index) => ({ Id: `initial-${index}`, Name: `Movie ${index}`, Type: 'Movie' }));
  const libraryApi = {
    getItem: async () => ({ Id: 'library', Name: 'Library', Type: 'CollectionFolder', CollectionType: 'mixed' }),
    queryItems: (params) => {
      queries.push(params);
      if (params.StartIndex) return oldPage;
      return Promise.resolve({ Items: settings.sortFoldersSeparately ? firstPage : [{ Id: 'new-sort', Name: 'New sort', Type: 'Movie' }], TotalRecordCount: settings.sortFoldersSeparately ? 240 : 1 });
    },
  };
  const Library = load('src/pages/Library.tsx', {
    '../api/mediaServer': media,
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'react-router-dom': { useParams: () => ({ serverId: 'server', libraryId: 'library' }), useNavigate: () => () => {} },
    '../store/servers': { useServers: { getState: () => ({ getApi: () => libraryApi }) } },
    '../store/settings': store, '../utils/listPresentation': presentation,
    '../components/PosterCard': { __esModule: true, default: 'Poster' },
    '../components/LiquidGlass': { __esModule: true, default: 'Glass' },
    '../components/Feedback': { EmptyState: 'Empty', ErrorState: 'Error', Spinner: 'Spinner' },
    '../components/icons': icons,
  }).default;
  const render = () => {
    cursor = 0;
    const tree = Library();
    for (const effect of effects.splice(0)) effect();
    return tree;
  };
  const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
  const find = (tree, predicate) => {
    if (!tree || typeof tree !== 'object') return [];
    if (Array.isArray(tree)) return tree.flatMap((entry) => find(entry, predicate));
    return [...(predicate(tree) ? [tree] : []), ...find(tree.props?.children, predicate)];
  };
  settings = { ...defaults };
  render(); await flush();
  render(); await flush();
  const first = render();
  assert.equal(queries[0].SortBy, 'IsFolder,SortName');
  assert.equal(queries[0].SortOrder, 'Descending,Ascending');
  assert.equal(find(first, (node) => node.type === 'Poster').length, 120);
  const more = find(first, (node) => node.type === 'button' && typeof node.props?.children === 'string' && node.props.children.startsWith('加载更多'))[0];
  assert(more, 'Loaded library exposes pagination');
  more.props.onClick();
  assert.equal(queries[1].StartIndex, 120);
  settings = { ...defaults, sortFoldersSeparately: false };
  render(); await flush(); render();
  assert.equal(queries[2].SortBy, 'SortName', 'Changing the preference triggers the actual ungrouped server query');
  assert.equal(queries[2].StartIndex, 0);
  resolveOldPage({ Items: [{ Id: 'stale-page', Name: 'Old page', Type: 'Movie' }], TotalRecordCount: 240 });
  await flush();
  assert.deepEqual(find(render(), (node) => node.type === 'Poster').map((node) => node.props.item.Id), ['new-sort'], 'A late page from the old sort cannot pollute the new order');
  console.log('PASS: actual library queries reload for folder sorting and discard late pagination from the previous order');
}
checkLibraryQueries().catch((error) => { console.error(error); process.exitCode = 1; });
