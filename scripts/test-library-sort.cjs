/** Persist real library preferences and exercise sorting/menu/page effects in Chromium. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

const storage = new Map();
global.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key),
};
global.window = { localStorage: global.localStorage };
const source = esbuild.buildSync({
  stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    export * from './src/store/libraryPreferences';
    export * from './src/utils/librarySort';
  ` }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
}).outputFiles[0].text;
const loadStore = () => {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(require, module, module.exports);
  return module.exports;
};
const { useLibraryPreferences, librarySortScope, DEFAULT_LIBRARY_SORT } = loadStore();
const scope = librarySortScope('server', 'user', 'movies');
assert.deepEqual(useLibraryPreferences.getState().sorts, {}, 'Existing installations start with the original name/ascending default');
useLibraryPreferences.getState().setSort(scope, { key: 'date', order: 'Ascending' });
const reopened = loadStore();
assert.deepEqual(reopened.useLibraryPreferences.getState().sorts[scope], { key: 'date', order: 'Ascending' }, 'A newly created store must restore both field and direction');
for (const other of [librarySortScope('other', 'user', 'movies'), librarySortScope('server', 'other', 'movies'), librarySortScope('server', 'user', 'shows')]) {
  assert.equal(reopened.useLibraryPreferences.getState().sorts[other], undefined, 'Server, account and library preferences must be isolated');
}
assert.notEqual(librarySortScope('a:b', 'c', 'd'), librarySortScope('a', 'b:c', 'd'), 'Scope IDs containing punctuation must not collide');
const saved = JSON.parse(storage.get('mjc:library-preferences'));
assert.deepEqual(Object.keys(saved.state), ['sorts'], 'Persist data only, never actions or API state');
storage.set('mjc:library-preferences', JSON.stringify({ state: { sorts: {
  invalid: { key: 'unsupported', order: 'broken' }, partial: { key: 'date' }, valid: { key: 'runtime', order: 'Descending' },
}, setSort: 'broken' }, version: 0 }));
useLibraryPreferences.persist.rehydrate();
assert.deepEqual(useLibraryPreferences.getState().sorts.invalid, DEFAULT_LIBRARY_SORT);
assert.deepEqual(useLibraryPreferences.getState().sorts.partial, { key: 'date', order: 'Ascending' });
assert.deepEqual(useLibraryPreferences.getState().sorts.valid, { key: 'runtime', order: 'Descending' });
assert.equal(typeof useLibraryPreferences.getState().setSort, 'function', 'Corrupt saved actions must not replace store methods');
for (const sorts of [null, [], 'broken']) {
  storage.set('mjc:library-preferences', JSON.stringify({ state: { sorts }, version: 0 }));
  useLibraryPreferences.persist.rehydrate();
  assert.deepEqual(useLibraryPreferences.getState().sorts, {});
}
console.log('PASS: fresh-store persistence, server/account/library isolation, scope collisions and corrupt preference recovery');

(async () => {
  const browser = [process.env.MJC_TEST_CHROMIUM,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(candidate => candidate && fs.existsSync(candidate));
  assert(browser, 'Set MJC_TEST_CHROMIUM for the library sorting regression');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mjc-library-sort-'));
  try {
    const config = (await import(pathToFileURL(path.resolve('tailwind.config.js')).href)).default;
    const css = (await require('postcss')([require('tailwindcss')(config), require('autoprefixer')])
      .process(fs.readFileSync('src/index.css', 'utf8'), { from: path.resolve('src/index.css') })).css;
    const bundle = esbuild.buildSync({
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
        import Library from './src/pages/Library';
        import { useServers } from './src/store/servers';
        import { useSettings } from './src/store/settings';
        import { useLibraryPreferences } from './src/store/libraryPreferences';
        import { librarySortScope, LIBRARY_SORT_OPTIONS } from './src/utils/librarySort';
        const result = document.getElementById('result');
        const check = (ok, message) => { if (!ok) throw new Error(message); };
        const wait = (ms=35) => new Promise(resolve => setTimeout(resolve, ms));
        const queries = [];
        let delayed = null;
        const items = Array.from({length:250}, (_, i) => ({Id:'movie-'+i, Name:'Movie '+String(i).padStart(3,'0'), Type:'Movie',
          DateCreated:new Date(Date.UTC(2020,0,1+i)).toISOString()}));
        const apiFor = userId => ({userId,
          getItem:async id => ({Id:id,Name:'排序测试媒体库',Type:'CollectionFolder',CollectionType:'mixed'}),
          posterUrl:()=>null,
          queryItems(params, signal) {
            const query={...params,signal};queries.push(query);
            if (params.StartIndex && delayed) return delayed.promise;
            const sorted = params.SortOrder.endsWith('Ascending') ? items : [...items].reverse();
            return Promise.resolve({Items:sorted.slice(params.StartIndex,params.StartIndex+params.Limit),TotalRecordCount:250});
          },
        });
        const api = apiFor('user-a');
        useServers.setState({servers:[],apis:{fixture:api,other:apiFor('user-a')}});
        useSettings.setState({showPreviewImage:false,showItemCountInTitle:true,sortFoldersSeparately:false});
        const reopening = new URLSearchParams(location.search).has('reopen');
        if (!reopening) useLibraryPreferences.setState({sorts:{}});
        let navigate;
        function Navigation(){navigate=useNavigate();return null;}
        const root = createRoot(document.getElementById('root'));
        const host = document.getElementById('root');
        const path = (server='fixture',library='movies') => '/server/'+server+'/library/'+library;
        const go = async destination => {flushSync(()=>navigate(destination));await wait();};
        const trigger = () => host.querySelector('button[aria-haspopup="dialog"]');
        const menu = () => document.querySelector('[role="dialog"]');
        const click = node => {check(node,'Missing control');flushSync(()=>node.click());};
        const open = async () => {if(!menu())click(trigger());await wait();};
        const choose = async (group,value) => {
          await open();
          click(menu().querySelector('input[name$="-'+group+'"][value="'+value+'"]'));
          await wait();
        };
        const close = () => {document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));};
        const first = () => host.querySelector('button[title^="Movie "]')?.title;
        const more = () => [...host.querySelectorAll('button')].find(button=>button.textContent.startsWith('加载更多'));
        const lastQuery = () => queries[queries.length-1];
        const current = () => useLibraryPreferences.getState().sorts[librarySortScope('fixture','user-a','movies')];
        const boundsCheck = () => {
          const bounds=menu().getBoundingClientRect();
          check(bounds.left>=0&&bounds.right<=innerWidth&&bounds.top>=0&&bounds.bottom<=innerHeight,'Sort menu must stay inside the viewport');
          check(document.documentElement.scrollWidth<=innerWidth,'Library toolbar must not cause horizontal page overflow');
          const page=host.firstElementChild;
          check(page.scrollWidth<=page.clientWidth+1,'Toolbar must wrap inside the library page');
          const inner=menu().querySelector('.overflow-y-auto');
          inner.scrollTop=inner.scrollHeight;
          const direction=menu().querySelector('input[value="Descending"]').getBoundingClientRect();
          check(direction.top>=bounds.top&&direction.bottom<=bounds.bottom,'Direction controls must remain reachable in a short menu');
          inner.scrollTop=0;
        };
        (async()=>{try{
          flushSync(()=>root.render(<MemoryRouter initialEntries={[path()]}><Navigation/><Routes>
            <Route path="/server/:serverId/library/:libraryId" element={<Library/>}/>
            <Route path="/away" element={<button>Other page</button>}/>
          </Routes></MemoryRouter>));
          await wait(100);
          if(reopening){
            check(lastQuery().SortBy==='DateCreated'&&lastQuery().SortOrder==='Ascending','Restart must honor saved sort in the very first request');
            check(trigger().textContent.includes('添加日期'),'Restart must restore the visible field');
            check(first()==='Movie 000','Restart must restore earliest-first results');
          }else{
            check(lastQuery().SortBy==='SortName'&&lastQuery().SortOrder==='Ascending','Unsaved libraries keep the original sort');
            check(first()==='Movie 000','Ascending results must show the earliest fixture first');
            await open();boundsCheck();
            check(menu().querySelectorAll('input[name$="-field"]').length===9,'Menu exposes the supported common sort fields');
            check(document.activeElement===menu().querySelector('input:checked'),'Opening must focus the selected sort');
            await choose('field','date');
            check(lastQuery().SortBy==='DateCreated'&&lastQuery().SortOrder==='Ascending','Date ascending must be an independent choice');
            check(menu().textContent.includes('最早添加优先'),'Date direction must explain earliest versus latest');
            await choose('direction','Descending');
            check(lastQuery().SortOrder==='Descending'&&first()==='Movie 249','Date descending must show the latest fixture first');
            close();await wait();
            check(!menu()&&document.activeElement===trigger(),'Escape must dismiss and return focus');
            await go('/away');await go(path());
            check(lastQuery().SortBy==='DateCreated'&&lastQuery().SortOrder==='Descending','Leaving and returning must restore both sort values');
            await go(path('fixture','shows'));
            check(lastQuery().SortBy==='SortName'&&lastQuery().SortOrder==='Ascending','Another library must keep its own preference');
            await go(path('other'));
            check(lastQuery().SortBy==='SortName'&&lastQuery().SortOrder==='Ascending','Another server must keep its own preference');
            await go(path());
            check(lastQuery().SortBy==='DateCreated'&&lastQuery().SortOrder==='Descending','Switching routes in the same mounted page must recover the right preference');
            flushSync(()=>useServers.setState({apis:{fixture:apiFor('user-b'),other:apiFor('user-a')}}));await wait();
            check(lastQuery().SortBy==='SortName'&&lastQuery().SortOrder==='Ascending','Switching accounts must not reuse another account sort');
            flushSync(()=>useServers.setState({apis:{fixture:api,other:apiFor('user-a')}}));await wait();
            check(lastQuery().SortBy==='DateCreated'&&lastQuery().SortOrder==='Descending','Returning to an account must restore its sort');
            for(const option of LIBRARY_SORT_OPTIONS){
              await choose('field',option.key);
              check(lastQuery().SortBy===option.sortBy&&lastQuery().SortOrder==='Descending','Field '+option.key+' must keep the independently selected direction');
            }
            await choose('field','date');await choose('direction','Ascending');
            close();await wait();
            click(more());await wait();
            check(lastQuery().StartIndex===120&&lastQuery().SortBy==='DateCreated'&&lastQuery().SortOrder==='Ascending','Second page must retain the full library order');
            let resolveLate;
            delayed={promise:new Promise(resolve=>{resolveLate=resolve;})};
            const count=queries.length;
            const oldMore=more();flushSync(()=>{oldMore.click();oldMore.click();});await wait();
            check(queries.length===count+1,'Concurrent load-more clicks must only request one page');
            const oldPage=lastQuery();
            check(oldPage.StartIndex===240,'Final page uses the actual loaded offset');
            await choose('direction','Descending');
            check(oldPage.signal.aborted,'Changing direction must cancel the old page');
            resolveLate({Items:[{Id:'stale',Name:'Stale fixture',Type:'Movie'}],TotalRecordCount:251});await wait();
            check(!host.querySelector('button[title="Stale fixture"]'),'Late old-page results must never enter the new order');
            check(first()==='Movie 249'&&host.querySelectorAll('button[title^="Movie "]').length===120,'A sort change must restart from page one');
            delayed=null;
            flushSync(()=>useSettings.setState({sortFoldersSeparately:true}));await wait();
            check(lastQuery().SortBy==='IsFolder,DateCreated'&&lastQuery().SortOrder==='Descending,Descending','Folder grouping must preserve the chosen media direction');
            await choose('direction','Ascending');
            check(lastQuery().SortOrder==='Descending,Ascending','Ascending media must not reverse folders-first grouping');
            close();await wait();
            const previous=lastQuery();
            await go('/away');
            check(previous.signal.aborted,'Leaving the page must cancel its request');
            flushSync(()=>useSettings.setState({sortFoldersSeparately:false}));
            await go(path());
            check(current().key==='date'&&current().order==='Ascending','Final preference must remain saved');
            await open();
            document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));await wait();
            check(!menu(),'Clicking outside must dismiss the menu');
            await open();
            const target=host.querySelector('[aria-label="返回"]');target.focus();await wait();
            check(!menu()&&document.activeElement===target,'Tabbing focus outside must dismiss without stealing focus');
          }
          await open();boundsCheck();
          const inner=menu().querySelector('.overflow-y-auto');inner.scrollTop=inner.scrollHeight;
          await wait(100);
          result.dataset.status='pass';result.textContent='PASS: real library sorting, direction, pagination/cancellation, navigation/account scopes, menu focus/viewport and saved restart';
        }catch(error){result.dataset.status='fail';result.textContent=String(error.stack||error);}})();
      ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    }).outputFiles[0].text;
    const page = path.join(directory, 'fixture.html');
    fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>${css}
      #root{margin:42px 0 0 220px;width:calc(100% - 232px);height:calc(100% - 54px)}
      @media(max-width:620px){#root{margin-left:80px;width:calc(100% - 92px)}}
      </style><div id="root"></div><pre id="result" style="display:none" data-status="pending"></pre>
      <script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`);
    const screenshots = process.argv.includes('--screenshots') ? path.resolve('.tmp/library-sort-check') : null;
    if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
    for (const [width, height, dpi] of [[1280,800,1],[540,600,1],[1280,800,1.25],[540,600,1.25],[1280,800,1.5],[540,600,1.5]]) {
      const run = reopen => {
        const execution = spawnSync(browser, [
          '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
          `--user-data-dir=${path.join(directory, 'profile-'+width+'-'+dpi)}`, `--window-size=${width},${height}`,
          `--force-device-scale-factor=${dpi}`, '--dump-dom', '--virtual-time-budget=10000',
          ...(screenshots && !reopen ? [`--screenshot=${path.join(screenshots, width+'-'+dpi+'.png')}`] : []),
          pathToFileURL(page).href + (reopen ? '?reopen=1' : ''),
        ], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
        if (execution.error) throw execution.error;
        assert.equal(execution.status, 0, execution.stderr);
        const output = execution.stdout.match(/<pre id="result"[^>]*data-status="([^"]+)"[^>]*>([\s\S]*?)<\/pre>/);
        assert.equal(output?.[1], 'pass', output?.[2] ?? execution.stderr);
        console.log(output[2], `(${width}x${height}, ${dpi*100}%${reopen ? ', restarted browser' : ''})`);
      };
      run(false);
      if (width === 1280 && dpi === 1) run(true);
    }
  } finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('mjc-library-sort-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
