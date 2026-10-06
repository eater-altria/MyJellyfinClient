const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');
let stored = '{}';
const storage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
const code = esbuild.transformSync(fs.readFileSync('src/player/playbackPreferences.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const bundle = { exports: {} };
new Function('module', 'exports', 'localStorage', code)(bundle, bundle.exports, storage);
const { getPlaybackPreferences, rememberTrack, saveSubtitleSearchQueries, getAdjacentMedia } = bundle.exports;
const enabled = { rememberAudioTrack: true, rememberSubtitle: true, subtitleSearchHistory: true };

(async () => {
  rememberTrack('server-a', 'film-a:source-a', 'audio', { id: 4, lang: 'jpn', title: 'Japanese', codec: 'aac' });
  assert.equal(getPlaybackPreferences('server-a', 'film-a:source-a', enabled).rememberedAudio.id, 4);
  assert.deepEqual(getPlaybackPreferences('server-a', 'film-b:source-b', enabled).rememberedAudio, { lang: 'jpn', title: 'Japanese', codec: 'aac' }, 'IDs cannot carry into unrelated videos');
  assert.equal(getPlaybackPreferences('server-b', 'film-a:source-a', enabled).rememberedAudio, undefined, 'Servers must not share track selections');
  rememberTrack('server-a', 'film-a:source-a', 'sub', { id: 'no' });
  assert.equal(getPlaybackPreferences('server-a', 'film-b:source-b', enabled).rememberedSubtitle.id, 'no', 'Disabling subtitles is a remembered selection');
  saveSubtitleSearchQueries('server-a', [' 中文 ', '中文', '', '英文']);
  assert.deepEqual(getPlaybackPreferences('server-a', 'film-a:source-a', enabled).subtitleSearchQueries, ['中文', '英文']);
  assert.deepEqual(getPlaybackPreferences('server-a', 'film-a:source-a', { rememberAudioTrack: false, rememberSubtitle: false, subtitleSearchHistory: false }), { rememberedAudio: undefined, rememberedSubtitle: undefined, subtitleSearchQueries: [] });
  for (const broken of ['null', '[1]', 'not-json']) {
    stored = broken;
    assert.equal(getPlaybackPreferences('server-a', 'key', enabled).rememberedAudio, undefined);
  }
  const episodes = [{ Id: 'e3', ParentIndexNumber: 2, IndexNumber: 1 }, { Id: 'e1', ParentIndexNumber: 1, IndexNumber: 1 }, { Id: 'e2', ParentIndexNumber: 1, IndexNumber: 2 }];
  assert.equal((await getAdjacentMedia({ getEpisodes: async () => ({ Items: episodes }) }, { Id: 'e2', Type: 'Episode', SeriesId: 'series' }, 'next')).Id, 'e3', 'Series navigation must cross season boundaries in season/episode order');
  assert.equal(await getAdjacentMedia({ getEpisodes: async () => ({ Items: episodes }) }, { Id: 'missing', Type: 'Episode', SeriesId: 'series' }, 'next'), undefined);
  const films = Array.from({ length: 405 }, (_, index) => ({ Id: `film-${index}` }));
  const api = { queryItems: async params => ({ Items: films.slice(params.StartIndex, params.StartIndex + params.Limit), TotalRecordCount: films.length }) };
  assert.equal((await getAdjacentMedia(api, { Id: 'film-199', ParentId: 'folder' }, 'next')).Id, 'film-200', 'Folder navigation must continue across pages');
  assert.equal((await getAdjacentMedia(api, { Id: 'film-400', ParentId: 'folder' }, 'prev')).Id, 'film-399');
  assert.equal(await getAdjacentMedia(api, { Id: 'film-404', ParentId: 'folder' }, 'next'), undefined);
  console.log('PASS: Track preferences and disabled controls, subtitle history persistence, corruption recovery, series and paginated folder navigation');
})().catch(error => { console.error(error); process.exitCode = 1; });
