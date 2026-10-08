/** Exercise real series controls, scoped episode grids and responsive layout in Chromium. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

(async () => {
  const browser = [process.env.MJC_TEST_CHROMIUM,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(candidate => candidate && fs.existsSync(candidate));
  assert(browser, 'Set MJC_TEST_CHROMIUM for the series navigation regression');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mjc-series-navigation-'));
  try {
    const config = (await import(pathToFileURL(path.resolve('tailwind.config.js')).href)).default;
    const css = (await require('postcss')([require('tailwindcss')(config), require('autoprefixer')])
      .process(fs.readFileSync('src/index.css', 'utf8'), { from: path.resolve('src/index.css') })).css;
    const bundle = esbuild.buildSync({
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
        import SeriesDetail from './src/pages/SeriesDetail';
        import DetailCollection from './src/pages/DetailCollection';
        import AppBackdrop from './src/components/AppBackdrop';
        import { useAppBackdrop } from './src/store/appBackdrop';
        import { useServers } from './src/store/servers';
        import { useSettings } from './src/store/settings';
        const episodes = count => Array.from({length:count}, (_, index) => ({
          Id:'episode-'+count+'-'+index, Name:'Episode '+index, IndexNumber:index+1, Type:'Episode',
          SeriesName:'Fixture Series', Overview:'Synthetic episode description', RunTimeTicks:14400000000,
          CommunityRating:8.2,
        }));
        const data = {one:episodes(24), two:episodes(7)};
        const artwork='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="a" x2="1" y2="1"><stop stop-color="#a2dcc3"/><stop offset=".5" stop-color="#a7a1bd"/><stop offset="1" stop-color="#daff97"/></linearGradient></defs><path fill="url(#a)" d="M0 0h1200v800H0z"/></svg>');
        let seasons = [{Id:'one',Name:'Season One',IndexNumber:1,ChildCount:24},
          {Id:'two',Name:'Season Two',IndexNumber:2,ChildCount:7}];
        let mode = 'normal', pending, calls = [];
        const api = {
          getItem:async id => ({Id:id, Name:id==='series'?'Fixture Series':seasons.find(season=>season.Id===id)?.Name,
            Type:id==='series'?'Series':'Season', People:id==='series'?[{Id:'actor',Name:'Fixture Actor',Type:'Actor'}]:[]}),
          getSimilar:async()=>({Items:[{Id:'similar',Name:'Similar fixture',Type:'Movie'}]}), getSeasons:async()=>({Items:seasons}),
          getEpisodes:async(series,season,signal)=>{
            calls.push({series,season,signal});
            if(mode==='error')throw new Error('Synthetic episode failure');
            if(mode==='empty')return {Items:[],TotalRecordCount:0};
            if(mode==='pending')return new Promise(resolve=>{pending=resolve;});
            return {Items:data[season]||[],TotalRecordCount:(data[season]||[]).length};
          },
          backdropUrl:item=>item.Id==='series'?artwork:null, posterUrl:()=>null, thumbUrl:()=>null, logoUrl:()=>null,personImageUrl:()=>null,
        };
        useServers.setState({apis:{fixture:api}});
        useSettings.setState({showItemCountInTitle:true,showFolderTime:false,showPreviewImage:true});
        const host=document.getElementById('root'), result=document.getElementById('result');
        const root=createRoot(host);
        const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        const check=(ok,message)=>{if(!ok)throw new Error(message);};
        const control=label=>host.querySelector('[aria-label="'+label+'"]');
        let location, instance=0;
        function Location(){location=useLocation();return null;}
        const render=(season='one',full=false)=>flushSync(()=>root.render(
          <MemoryRouter key={instance++} initialEntries={[full?'/server/fixture/series/series/season/'+season+'/episodes':'/server/fixture/series/series?seasonId='+season]}>
            <Location/><AppBackdrop/><div data-page className="relative h-full"><Routes>
              <Route path="/server/:serverId/series/:itemId" element={<SeriesDetail/>}/>
              <Route path="/server/:serverId/series/:itemId/season/:seasonId/episodes" element={<DetailCollection kind="episodes"/>}/>
              <Route path="/server/:serverId/item/:itemId/cast" element={<DetailCollection kind="cast"/>}/>
              <Route path="/server/:serverId/item/:itemId/similar" element={<DetailCollection kind="similar"/>}/>
              <Route path="/server/:serverId/episode/:itemId" element={<p>Episode detail fixture</p>}/>
            </Routes></div>
          </MemoryRouter>));
        const click=button=>flushSync(()=>button.click());
        const selectSeason=index=>{
          const button=[...host.querySelectorAll('button[aria-pressed]')].find(button=>button.textContent.startsWith('第 '+index+' 季'));
          check(button,'Season selector must be available');click(button);
        };
        const checkControls=()=>{
          const buttons=['查看全部剧集','剧集向左滚动','剧集向右滚动'].map(control);
          const page=host.getBoundingClientRect();
          check(buttons.every(button=>button&&getComputedStyle(button).display!=='none'),'All episode controls must be visible at this width');
          buttons.forEach(button=>{
            const rect=button.getBoundingClientRect();
            check(rect.left>=page.left&&rect.right<=page.right,'Episode controls must stay inside the content area');
            check(button.querySelector('.glass-button-material'),'Episode navigation must reuse optical glass');
          });
          const left=buttons[1].getBoundingClientRect(), right=buttons[2].getBoundingClientRect();
          check(left.width===32&&left.height===32&&right.width===32&&right.height===32,'Arrow hit areas must remain 32 CSS pixels');
        };
        (async()=>{try{
          render();await wait(80);checkControls();
          let scroller=control('剧集列表');
          check(scroller.querySelectorAll('.media-card').length===24,'Entire season must remain available');
          check(scroller.scrollWidth>scroller.clientWidth,'Episode row must overflow horizontally');
          const scrolls=[], nativeScrollBy=scroller.scrollBy.bind(scroller);
          scroller.scrollBy=options=>{scrolls.push(options);nativeScrollBy({...options,behavior:'instant'});};
          click(control('剧集向右滚动'));
          check(scroller.scrollLeft>0&&scrolls[0].left===scroller.clientWidth*.8&&scrolls[0].behavior==='smooth','Right arrow must scroll the episode row by most of its visible width');
          click(control('剧集向左滚动'));
          check(scroller.scrollLeft===0&&scrolls[1].left===-scroller.clientWidth*.8,'Left arrow must scroll back');
          click(control('剧集向右滚动'));selectSeason(2);await wait(80);
          scroller=control('剧集列表');
          check(scroller.scrollLeft===0&&scroller.querySelectorAll('.media-card').length===7,'Changing seasons must reset scrolling and replace the cards');
          check(location.search==='?seasonId=two','Selected season must survive in the URL');
          check(control('演职人员列表').scrollLeft===0,'Episode arrows must not move the cast row');
          const previousOwner=useAppBackdrop.getState().source.owner;
          mode='pending';click(control('查看全部剧集'));await wait(50);
          check(useAppBackdrop.getState().source?.url===artwork&&useAppBackdrop.getState().source.route===location.pathname,'Loading the full grid must immediately inherit the exact series artwork');
          check(useAppBackdrop.getState().source.owner!==previousOwner,'Grid must take independent ownership before parent cleanup');
          check(host.querySelector('.app-scene img')?.getAttribute('src')===artwork,'Inherited artwork must render in the application background');
          pending({Items:data.two,TotalRecordCount:7});mode='normal';await wait(50);
          check(location.pathname==='/server/fixture/series/series/season/two/episodes','View all must scope the route to the selected server, series and season');
          const grid=control('剧集列表');
          check(grid.querySelectorAll('.media-card').length===7&&getComputedStyle(grid).flexWrap==='wrap','View all must render every selected-season episode in a wrapping grid');
          check(calls.at(-1).series==='series'&&calls.at(-1).season==='two','Grid request must use the selected season');
          check(host.querySelector('h1').textContent.includes('（7）'),'Grid must show the real count when enabled');
          const page=host.querySelector('[data-page] > div'), cards=grid.querySelectorAll('.media-card');
          page.scrollTop=page.scrollHeight;
          check(cards[6].getBoundingClientRect().bottom<=page.getBoundingClientRect().bottom+1,'Last grid episode must be reachable');
          click(control('返回'));await wait(80);
          check(location.search==='?seasonId=two'&&control('剧集列表').querySelectorAll('.media-card').length===7,'Returning must restore the selected season');
          click(control('查看全部剧集'));await wait(80);
          click(control('剧集列表').querySelector('.media-card'));await wait(30);
          check(location.pathname==='/server/fixture/episode/episode-7-0','Grid cards must open episode details');
          check(useAppBackdrop.getState().source===null&&!host.querySelector('.app-scene'),'Leaving the collection must clear its artwork');

          mode='pending';render();await wait(50);checkControls();
          check(control('剧集向右滚动').disabled,'Loading episodes must disable scrolling');
          const stale=pending, staleCall=calls.at(-1);mode='normal';selectSeason(2);await wait(50);
          check(staleCall.signal.aborted,'Changing seasons must abort the old episode request');
          stale({Items:data.one,TotalRecordCount:24});await wait(30);
          check(control('剧集列表').querySelectorAll('.media-card').length===7,'Late responses from the old season must not replace the current cards');

          mode='error';render();await wait(50);
          check(host.querySelector('[role=alert]'),'Failed episodes must expose an error and retry');
          mode='normal';click(host.querySelector('[role=alert] button'));await wait(50);
          check(control('剧集列表').querySelectorAll('.media-card').length===24,'Episode retry must recover the season');
          mode='error';click(control('查看全部剧集'));await wait(50);
          check(host.querySelector('[role=alert]'),'Full grid failure must expose retry');
          mode='normal';click(host.querySelector('[role=alert] button'));await wait(50);
          check(control('剧集列表').querySelectorAll('.media-card').length===24,'Full grid retry must recover every episode');
          check(useAppBackdrop.getState().source?.url===artwork,'Full grid errors and retries must retain inherited artwork');
          mode='empty';render();await wait(50);
          check(host.textContent.includes('本季暂无剧集')&&control('剧集向右滚动').disabled,'Empty episodes must retain disabled navigation');
          click(control('查看全部剧集'));await wait(50);
          check(host.textContent.includes('本季暂无剧集')&&!control('剧集列表'),'An empty full grid must show the season-specific empty state');

          mode='normal';seasons=Array.from({length:7},(_,index)=>({Id:index===0?'one':index===1?'two':'extra-'+index,Name:'Season '+index,IndexNumber:index+1}));
          render('two');await wait(50);checkControls();
          const select=control('选择季');
          check(select&&select.value==='two','Large season lists must retain the dropdown selection');
          click(control('查看全部剧集'));await wait(50);
          check(calls.at(-1).season==='two','Dropdown view all must use the current season');
          click(control('返回'));await wait(50);
          check(control('选择季').value==='two','Returning must restore a dropdown season');
          useAppBackdrop.setState({source:null});render('two',true);await wait(80);
          check(useAppBackdrop.getState().source?.url===artwork&&host.querySelector('.app-scene img'),'Direct grid links must recover series artwork without a parent page');
          flushSync(()=>useSettings.setState({showPreviewImage:false}));await wait(30);
          check(useAppBackdrop.getState().source===null&&!host.querySelector('.app-scene'),'Disabling previews must clear collection artwork');
          flushSync(()=>useSettings.setState({showPreviewImage:true}));await wait(30);
          check(useAppBackdrop.getState().source?.url===artwork,'Reenabling previews must restore collection artwork');
          seasons=seasons.slice(0,2);render();await wait(80);checkControls();
          for(const title of ['演职人员','类似作品']){
            click(control('查看全部'+title));await wait(50);
            check(useAppBackdrop.getState().source?.url===artwork&&useAppBackdrop.getState().source.route===location.pathname,'Other detail collections must retain parent artwork: '+title);
            click(control('返回'));await wait(50);
          }
          seasons=[{Id:'one',Name:'This is a long synthetic season name for narrow layout checks',ChildCount:24}];
          render();await wait(50);checkControls();
          const selector=host.querySelector('section button[aria-pressed]');
          const bounds=selector.getBoundingClientRect(),content=host.getBoundingClientRect();
          check(bounds.left>=content.left&&bounds.right<=content.right,'Long season names must stay inside the content area');
          seasons=[{Id:'one',Name:'Season One',IndexNumber:1,ChildCount:24}];
          render();await wait(50);click(control('查看全部剧集'));await wait(50);
          check(useAppBackdrop.getState().source?.url===artwork,'Final grid must retain the exact series background');
          result.dataset.status='pass';result.textContent='PASS: episode arrows, scoped grid, details and return, abort/stale responses, loading/empty/retry, dropdown, collection artwork, previews, long names and responsive geometry';
        }catch(error){result.dataset.status='fail';result.textContent=String(error.stack||error);}})();
      ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    }).outputFiles[0].text;
    const page = path.join(directory, 'fixture.html');
    fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>${css}
      #root{position:relative;isolation:isolate;margin:42px 0 0 220px;width:calc(100% - 232px);height:calc(100% - 54px)}
      @media(max-width:620px){#root{margin-left:80px;width:calc(100% - 92px)}}
      </style><div id="root"></div><pre id="result" style="display:none" data-status="pending"></pre>
      <script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`);
    for (const [width, height, scale] of [[1280,800,1], [540,600,1], [1280,800,1.25], [1280,800,1.5]]) {
      const screenshot = process.env.MJC_TEST_ARTIFACT_DIR
        ? [`--screenshot=${path.resolve(process.env.MJC_TEST_ARTIFACT_DIR, `series-${width}-${scale}.png`)}`] : [];
      const execution = spawnSync(browser, [
        '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        `--user-data-dir=${path.join(directory, 'profile')}`, `--window-size=${width},${height}`,
        `--force-device-scale-factor=${scale}`, ...screenshot,
        '--dump-dom', '--virtual-time-budget=5000', pathToFileURL(page).href,
      ], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      if (execution.error) throw execution.error;
      assert.equal(execution.status, 0, execution.stderr);
      const output = execution.stdout.match(/<pre id="result"[^>]*data-status="([^"]+)"[^>]*>([\s\S]*?)<\/pre>/);
      assert.equal(output?.[1], 'pass', output?.[2] ?? execution.stderr);
      console.log(output[2], `(${width}x${height}, ${scale * 100}%)`);
    }
  } finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('mjc-series-navigation-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
