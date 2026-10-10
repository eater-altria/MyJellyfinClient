/** Real retained pages, scroll positions, automatic paging and server filters. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

(async () => {
  const source = esbuild.buildSync({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents:
    "export { MediaServerApi, normalizeLibraryFilters } from './src/api/mediaServer'; export * from './src/utils/libraryFilters';" },
    bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const fixtureModule = { exports: {} };
  new Function('module', 'exports', source)(fixtureModule, fixtureModule.exports);
  const { MediaServerApi, normalizeLibraryFilters, libraryFilterParams, readLibraryFilters, writeLibraryFilters } = fixtureModule.exports;
  assert.deepEqual(normalizeLibraryFilters({ Genres: ['动画', { Name: '剧情' }, '动画', 0], Tags: ['标签 A', '标签 A'], Years: [2024, 2025, 2025, 0, '2023'] }),
    { genres: ['动画', '剧情'], tags: ['标签 A'], years: [2025, 2024] });
  assert.throws(() => normalizeLibraryFilters({ Message: 'fixture failure' }), /无效/);
  const filters = { genres: ['动画', '剧情'], tags: ['标签 & +?'], years: [2025, 2024], favoritesOnly: true };
  assert.deepEqual(libraryFilterParams(filters), { Genres: '动画|剧情', Tags: '标签 & +?', Years: '2025,2024', Filters: 'IsFavorite' });
  assert.deepEqual(readLibraryFilters(writeLibraryFilters(new URLSearchParams('type=series'), filters)), filters);
  const originalFetch = global.fetch;
  global.localStorage = { getItem: () => 'fixture-device', setItem() {} };
  try {
    for (const protocol of ['jellyfin', 'emby']) {
      const api = new MediaServerApi('https://fixture.test/proxy', 'fixture-only-token', 'fixture-user', protocol);
      const controller = new AbortController();
      global.fetch = async (input, init) => {
        const url = new URL(input);
        assert(protocol === 'jellyfin' ? url.pathname === '/proxy/Items/Filters' : ['/proxy/Genres','/proxy/Tags','/proxy/Years'].includes(url.pathname));
        assert.equal(url.searchParams.get('UserId'), 'fixture-user'); assert.equal(url.searchParams.get('ParentId'), 'library & +?');
        assert.equal(url.searchParams.get('IncludeItemTypes'), 'Movie,Series'); assert.equal(init.signal, controller.signal);
        assert.equal(init.headers.Authorization, init.headers['X-Emby-Authorization']);
        assert(init.headers.Authorization.startsWith(protocol === 'emby' ? 'Emby ' : 'MediaBrowser '));
        const body = protocol === 'jellyfin' ? { Genres: ['动画'], Tags: ['标签 A'], Years: [2025] }
          : { Items: [{Name:url.pathname.endsWith('/Genres')?'动画':url.pathname.endsWith('/Tags')?'标签 A':'2025'}],TotalRecordCount:1 };
        return new Response(JSON.stringify(body));
      };
      assert.deepEqual(await api.getLibraryFilters('library & +?', 'Movie,Series', controller.signal), { genres: ['动画'], tags: ['标签 A'], years: [2025] });
    }
    const emby = new MediaServerApi('https://fixture.test/proxy/emby', 'fixture-only-token', 'fixture-user', 'emby');
    const manyTags = Array.from({length:230}, (_, index) => ({Name:'Tag '+String(index).padStart(3,'0')}));
    const requests=[];
    global.fetch=async(input,init)=>{
      const url=new URL(input),start=Number(url.searchParams.get('StartIndex')??0);requests.push(url);
      assert.equal(url.searchParams.get('ParentId'),'shows');assert.equal(url.searchParams.get('UserId'),'fixture-user');
      assert.equal(url.searchParams.get('IncludeItemTypes'),'Series');assert(init.headers.Authorization.startsWith('Emby '));
      assert.equal(url.searchParams.get('EnableImages'),'false');
      const data=url.pathname.endsWith('/Genres')?[{Name:'动画'},{Name:'剧情'}]:url.pathname.endsWith('/Years')?[{Name:'2025'},{Name:'2024'}]:manyTags;
      return new Response(JSON.stringify({Items:data.slice(start,start+100),TotalRecordCount:data.length}));
    };
    const paged=await emby.getLibraryFilters('shows','Series',new AbortController().signal);
    assert.equal(paged.tags.length,230);assert.deepEqual(paged.years,[2025,2024]);
    assert.deepEqual(requests.filter(url=>url.pathname.endsWith('/Tags')).map(url=>Number(url.searchParams.get('StartIndex'))),[0,100,200]);
    assert(requests.every(url=>url.pathname.startsWith('/proxy/emby/')),'Named services must preserve the reverse proxy prefix');
    global.fetch=async input=>new Response(JSON.stringify(new URL(input).pathname.endsWith('/Genres')?[{Name:'动画'}]:new URL(input).pathname.endsWith('/Years')?[{Name:'2025'}]:[{Name:'标签 A'}]));
    assert.deepEqual(await emby.getLibraryFilters('shows','Series'),{genres:['动画'],tags:['标签 A'],years:[2025]});
    const fallback=[];
    global.fetch=async input=>{const url=new URL(input);fallback.push(url.pathname);return url.pathname.endsWith('/Items/Filters')
      ?new Response(JSON.stringify({Genres:['动画'],Tags:['旧标签'],Years:[2024]})):new Response('',{status:404});};
    assert.deepEqual(await emby.getLibraryFilters('shows','Series'),{genres:['动画'],tags:['旧标签'],years:[2024]});
    assert.equal(fallback.filter(path=>path.endsWith('/Items/Filters')).length,1,'Unsupported named endpoints may fall back once to legacy filters');
    for(const status of [401,403,500]){
      const called=[];global.fetch=async input=>{called.push(new URL(input).pathname);return new Response('',{status});};
      await assert.rejects(emby.getLibraryFilters('shows','Series'),error=>error.status===status);
      assert(!called.some(path=>path.endsWith('/Items/Filters')),'Authentication/server failures must not be masked by endpoint guessing');
    }
    const mixed=[];global.fetch=async input=>{const path=new URL(input).pathname;mixed.push(path);return new Response('',{status:path.endsWith('/Genres')?404:path.endsWith('/Tags')?403:500});};
    await assert.rejects(emby.getLibraryFilters('shows','Series'),error=>error.status===403);
    assert(!mixed.some(path=>path.endsWith('/Items/Filters')),'A fast unsupported endpoint must not mask another endpoint authorization error');
    const abort=new AbortController();let pending=0;
    global.fetch=(_input,init)=>new Promise((_resolve,reject)=>{pending++;init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});
    const cancelled=emby.getLibraryFilters('shows','Series',abort.signal);assert.equal(pending,3);abort.abort();
    await assert.rejects(cancelled,{name:'AbortError'});
  } finally { global.fetch = originalFetch; delete global.localStorage; }
  console.log('PASS: Jellyfin/Emby scoped filter endpoint, auth/prefix/signal, server option validation, combinations and URL round-trip');
  const browser = [process.env.MJC_TEST_CHROMIUM, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
  assert(browser, 'Set MJC_TEST_CHROMIUM');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mjc-issue2-'));
  try {
    const config = (await import(pathToFileURL(path.resolve('tailwind.config.js')).href)).default;
    const css = (await require('postcss')([require('tailwindcss')(config), require('autoprefixer')])
      .process(fs.readFileSync('src/index.css', 'utf8'), { from: path.resolve('src/index.css') })).css;
    const bundle = esbuild.buildSync({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { MemoryRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
      import PageHost from './src/components/BrowsePageHost';
      import NativePlayer from './src/pages/NativePlayer';
      import { BrowseActivity } from './src/hooks/useBrowseActivity';
      import { PLAYER_EXIT_EVENT } from './src/player/exitPlayback';
      import { useServers } from './src/store/servers';
      import { useSettings } from './src/store/settings';
      import { updateBrowseUserData } from './src/utils/browseHistory';
      const result = document.getElementById('result');
      const check = (ok, message) => { if (!ok) throw Error(message); };
      const wait = (ms=70) => new Promise(resolve => setTimeout(resolve, ms));
      let navigate, searches=0, views=0, delayed=null, failMore=false, failFacets=false;
      const queries=[];
      const nativeSignals=[];
      const movies=Array.from({length:310}, (_,i)=>({Id:'movie-'+i, Name:'Movie '+String(i).padStart(3,'0'),Type:'Movie',
        ProductionYear:i%2?2024:2025,Genres:[i%2?'剧情':'动画'],Tags:[i%2?'标签 A':'标签 B'],UserData:{IsFavorite:i%3===0}}));
      const api={userId:'user-a',protocol:'jellyfin',token:'fixture-only',baseUrl:'https://fixture.test',clientIdentity:()=>({name:'Fixture',version:'1.0',deviceName:'Fixture PC'}),
        posterUrl:()=>null,backdropUrl:()=>null,logoUrl:()=>null,personImageUrl:()=>null,
        getItem:async(id,signal)=>{if(id==='movie-1'&&signal)nativeSignals.push(signal);return id==='movies'||id==='other'?{Id:id,Name:'反馈测试媒体库',Type:'CollectionFolder',CollectionType:'movies'}
          : movies.find(item=>item.Id===id)??{Id:id,Name:id,Type:'Series'};},
        getPlaybackInfo:async()=>({MediaSources:[{Id:'fixture-source',Container:'mp4',SupportsDirectPlay:true}]}),
        directStreamUrl:()=> 'https://fixture.test/synthetic-media',externalSubtitleUrls:()=>[],
        reportPlaybackStart:async()=>{},reportPlaybackProgress:async()=>{},reportPlaybackStopped:async()=>{},
        getSimilar:async()=>({Items:[],TotalRecordCount:0}), getSeasons:async()=>({Items:[],TotalRecordCount:0}),
        getEpisodes:async()=>({Items:[],TotalRecordCount:0}), getPlayedItems:async()=>({Items:movies.slice(0,60),TotalRecordCount:60}),
        search:async()=>{searches++;return {Items:movies.slice(0,80),TotalRecordCount:80};},
        getUserViews:async()=>{views++;return {Items:Array.from({length:6},(_,i)=>({Id:'view-'+i,Name:'分类 '+i,CollectionType:'movies'}))};},
        getLibraryItems:async(view,start,limit,signal)=>({Items:movies.slice(start,start+limit),TotalRecordCount:310}),
        getResumeItems:async()=>({Items:[],TotalRecordCount:0}),getNextUp:async()=>({Items:[],TotalRecordCount:0}),
        getLibraryFilters:async(parent,type,signal)=>{if(failFacets)throw Error('fixture');return {genres:['动画','剧情'],tags:['标签 A','标签 B'],years:[2025,2024]};},
        queryItems(params,signal){
          queries.push({...params,signal});
          if(params.StartIndex && delayed)return delayed.promise;
          if(params.StartIndex && failMore)return Promise.reject(Error('fixture'));
          let list=movies.filter(item=>(!params.Genres||params.Genres.split('|').some(x=>item.Genres.includes(x)))
            &&(!params.Tags||params.Tags.split('|').some(x=>item.Tags.includes(x)))&&(!params.Years||params.Years.split(',').includes(String(item.ProductionYear)))
            &&(!params.Filters||item.UserData.IsFavorite));
          return Promise.resolve({Items:list.slice(params.StartIndex,params.StartIndex+params.Limit),TotalRecordCount:list.length});
        },
      };
      useServers.setState({servers:[{id:'fixture',name:'Fixture',address:'https://fixture.test',userName:'fixture-user',userId:'user-a',token:'fixture-only',protocol:'jellyfin'}],apis:{fixture:api},activeServerId:'fixture'});
      let refreshes=0;
      let edits=0,additions=0;
      useServers.setState({refreshServer:async()=>{refreshes++;useServers.setState(state=>({apis:{...state.apis}}));},
        updateServer:async(id,patch)=>{edits++;useServers.setState(state=>({servers:state.servers.map(server=>server.id===id?{...server,name:patch.name}:server)}));},
        addServer:async(address,user,password,name)=>{additions++;useServers.setState(state=>({servers:[...state.servers,{id:'added',name,address,userName:user,protocol:'jellyfin'}]}));},
      });
      useSettings.setState({showPreviewImage:false,showItemCountInTitle:true,sortFoldersSeparately:false});
      function Navigation(){navigate=useNavigate();return null;}
      const root=createRoot(document.getElementById('root'));
      const slot=()=>document.querySelector('[data-page-path]:not([hidden])');
      const page=()=>slot()?.firstElementChild;
      const click=node=>{check(node,'Missing action');flushSync(()=>node.click());};
      const textButton=(text,within=slot())=>[...within.querySelectorAll('button')].find(node=>node.textContent===text||node.textContent.startsWith(text));
      const go=async(path)=>{flushSync(()=>navigate(path));await wait();};
      const scroll=async(element,top,left=0)=>{element.scrollTop=top;element.scrollLeft=left;element.dispatchEvent(new Event('scroll',{bubbles:true}));await wait();};
      const back=async()=>{flushSync(()=>navigate(-1));await wait();};
      (async()=>{try{
        flushSync(()=>root.render(<React.StrictMode><MemoryRouter initialEntries={['/server/fixture/library/movies']}><Navigation/><PageHost/></MemoryRouter></React.StrictMode>));
        await wait(130);
        const library=page(); check(library.scrollHeight>library.clientHeight+1200,'Fixture must actually scroll');
        await scroll(library,1300); const top=library.scrollTop, firstQueries=queries.length;
        click(library.querySelector('button[title="Movie 040"]'));await wait();await back();
        check(page()===library,'Back must reuse the same library DOM instance');
        check(Math.abs(page().scrollTop-top)<2,'Library Back lost position: '+page().scrollTop+' vs '+top);
        check(queries.length===firstQueries,'Library Back must preserve the loaded page without querying page one');
        const oldCount=library.querySelectorAll('button[title^="Movie "]').length;
        await scroll(library,library.scrollHeight-library.clientHeight);await wait(130);
        check(library.querySelectorAll('button[title^="Movie "]').length>oldCount,'Near-bottom scrolling must load another server page automatically');
        const loaded=library.querySelectorAll('button[title^="Movie "]').length, laterTop=library.scrollTop;
        click(library.querySelector('button[title="Movie 150"]'));await wait();await back();
        check(page()===library&&library.querySelectorAll('button[title^="Movie "]').length===loaded,'Back must keep all automatically loaded pages');
        check(Math.abs(library.scrollTop-laterTop)<2,'Back after pagination must keep scroll offset');
        failMore=true;await scroll(library,library.scrollHeight-library.clientHeight);await wait();
        check(library.querySelector('[role="alert"]')?.textContent.includes('加载更多失败'),'Automatic page errors must expose retry');
        const failedRequests=queries.length;await wait(160);check(queries.length===failedRequests,'Automatic errors must not cause a retry loop');
        failMore=false;click(textButton('重试加载更多'));await wait();
        check(!library.querySelector('[role="alert"]')&&library.querySelectorAll('button[title^="Movie "]').length===310,'Manual retry must load the remaining page');
        await go('/settings');const settingsPage=page();click(document.getElementById('settings-tab-list'));await wait();
        await scroll(settingsPage,180);const settingsTop=settingsPage.scrollTop;
        await go('/files');await back();
        check(page()===settingsPage&&document.getElementById('settings-tab-list').getAttribute('aria-selected')==='true','Settings tab/DOM must survive navigation');
        check(Math.abs(settingsPage.scrollTop-settingsTop)<2,'Settings scroll must survive navigation');
        await go('/search?serverId=fixture&q=Movie');await wait(500);const searchPage=page();await scroll(searchPage,900);const searchTop=searchPage.scrollTop;
        click(searchPage.querySelector('button[title="Movie 030"]'));await wait();await back();
        check(page()===searchPage&&searches===1&&Math.abs(searchPage.scrollTop-searchTop)<2,'Search query/results/position must survive detail Back');
        await go('/server/fixture');const homePage=page();await scroll(homePage,450);const homeTop=homePage.scrollTop;
        const row=homePage.querySelector('[aria-label="最新分类 2列表"]');await scroll(row,0,800);const rowLeft=row.scrollLeft;
        click(row.querySelector('button[title="Movie 005"]'));await wait();await back();
        check(page()===homePage&&views<=2&&Math.abs(homePage.scrollTop-homeTop)<2,'Home Back must preserve page/position and not refetch views');
        check(Math.abs(row.scrollLeft-rowLeft)<2,'Home horizontal row must preserve position');
        await go('/server/fixture/library/movies');await scroll(page(),0);
        click(textButton('类型与风格'));await wait();click(textButton('动画'));await wait();
        check(queries.at(-1).Genres==='动画','Genre browsing must apply a server filter');
        click(textButton('标签'));await wait();click(textButton('标签 B'));await wait();
        check(queries.at(-1).Genres==='动画'&&queries.at(-1).Tags==='标签 B','Tag browsing must combine server filters');
        click(textButton('筛选'));await wait();const dialog=document.querySelector('[aria-label="筛选媒体"]');
        check(dialog,'Filter dialog missing');
        const year=[...dialog.querySelectorAll('label')].find(label=>label.textContent==='2025').querySelector('input');click(year);
        click(textButton('应用筛选',dialog));await wait();
        check(queries.at(-1).Years==='2025'&&queries.at(-1).Genres==='动画','Year filters must be sent to the server');
        click(textButton('收藏'));await wait();check(queries.at(-1).Filters==='IsFavorite','Favorites must be queried for the current server/account/library');
        const favoriteId='movie-0';const favoritesPage=page();const beforeFavoriteQueries=queries.length;
        await go('/files');movies[0].UserData.IsFavorite=false;updateBrowseUserData(api,favoriteId,{IsFavorite:false});await wait();await back();
        check(page()===favoritesPage&&!page().querySelector('button[title="Movie 000"]')&&queries.length===beforeFavoriteQueries,'Unfavorite must update the retained favorites list without discarding pages');
        click(textButton('筛选'));await wait();const d=document.querySelector('[aria-label="筛选媒体"]');
        d.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await wait();
        check(!document.querySelector('[aria-label="筛选媒体"]'),'Escape must close the filter dialog');
        check(document.documentElement.scrollWidth<=innerWidth,'Filter/navigation layout must not overflow at this DPI');
        await go('/server/fixture/library/other');await scroll(page(),0);
        failFacets=true;click(textButton('类型与风格'));await wait();
        check(slot().textContent.includes('筛选选项加载失败'),'Failed facet queries must not masquerade as empty options');
        failFacets=false;click(textButton('重试'));await wait();check(textButton('动画'),'Facet errors must be retryable');
        click(textButton('全部媒体'));await wait();
        let releaseLate;delayed={promise:new Promise(resolve=>releaseLate=resolve)};await scroll(page(),page().scrollHeight-page().clientHeight);await wait();
        const pending=queries.at(-1);check(pending.StartIndex>0,'A real paginated request must be in flight');
        await go('/files');check(pending.signal.aborted,'Leaving the retained page must abort pending pagination');
        releaseLate({Items:[{Id:'stale-page',Name:'Stale page',Type:'Movie'}],TotalRecordCount:311});delayed=null;await wait();await back();
        check(!page().querySelector('button[title="Stale page"]'),'Late cancelled pages must never enter the retained grid');
        const accountApi={...api,userId:'user-b'};flushSync(()=>useServers.setState({apis:{fixture:accountApi}}));await wait();
        check(!document.contains(library)&&!document.contains(searchPage),'Account/API replacement must evict old-account page data');
        await go('/servers');const serverPage=page();const startingRefreshes=refreshes;
        const add=textButton('添加');add.scrollIntoView({block:'center'});await wait();
        const buttonRect=add.getBoundingClientRect();const hit=document.elementFromPoint(buttonRect.left+buttonRect.width/2,buttonRect.top+buttonRect.height/2);
        check(add.contains(hit),'Adding a server must not be blocked by a retained page overlay');
        click(add);await wait();check(document.querySelector('[role="dialog"]')?.textContent.includes('添加服务器'),'Server add dialog must open');
        flushSync(()=>useServers.setState(state=>({apis:{...state.apis,fixture:{...state.apis.fixture}}})));await wait();
        check(page()===serverPage&&document.querySelector('[role="dialog"]'),'API replacement must not reset open server management forms');
        check(refreshes===startingRefreshes,'An API update must not recursively remount and refresh the server page');
        click(document.querySelector('[role="dialog"] button[aria-label="关闭"]'));await wait();
        const edit=slot().querySelector('[aria-label="编辑服务器 Fixture"]');click(edit);await wait();
        check(document.querySelector('[role="dialog"]')?.textContent.includes('编辑服务器'),'Server edit dialog must open');
        const nameInput=document.querySelector('[role="dialog"] input');check(nameInput&&nameInput.value==='Fixture','Edit must restore the saved connection fields');
        const setInput=(input,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};
        setInput(nameInput,'Renamed Fixture');await wait();click(textButton('保存',document.querySelector('[role="dialog"]')));await wait();
        check(edits===1&&!document.querySelector('[role="dialog"]')&&slot().textContent.includes('Renamed Fixture'),'Editing and saving must reach the actual server form handler');
        click(textButton('添加'));await wait();const addDialog=document.querySelector('[role="dialog"]');
        const inputFor=label=>addDialog.querySelector('#'+CSS.escape([...addDialog.querySelectorAll('label')].find(node=>node.textContent===label).htmlFor));
        setInput(inputFor('服务器名称'),'Added Fixture');setInput(inputFor('服务器地址'),'https://added.fixture.test');setInput(inputFor('用户名'),'fixture-user');setInput(inputFor('密码'),'fixture-password');await wait();
        click(textButton('连接',addDialog));await wait();
        check(additions===1&&!document.querySelector('[role="dialog"]')&&slot().textContent.includes('Added Fixture'),'Adding a connection must submit the form and update the server page');
        let setPlayerActive,nativePath;
        function NativeLocation(){nativePath=useLocation().pathname;return null;}
        function NativeFixture(){const [active,setActive]=useState(true);setPlayerActive=setActive;return <MemoryRouter initialEntries={['/player/fixture/movie-1']}><NativeLocation/><BrowseActivity.Provider value={active}><Routes><Route path="/player/:serverId/:itemId" element={<NativePlayer/>}/></Routes></BrowseActivity.Provider></MemoryRouter>;}
        const nativeContainer=document.createElement('div');document.body.append(nativeContainer);const nativeRoot=createRoot(nativeContainer);
        flushSync(()=>nativeRoot.render(<NativeFixture/>));await wait(160);
        check(window.__fixtureCommands.filter(cmd=>cmd==='start_playback').length===1,'Active native page must start one playback session');
        const nativeElement=nativeContainer.firstElementChild;
        flushSync(()=>setPlayerActive(false));await wait();
        check(nativeContainer.firstElementChild===nativeElement,'Inactive player must retain its page DOM');
        check(window.__fixtureCommands.filter(cmd=>cmd==='stop_playback').length===1&&nativeSignals.every(signal=>signal.aborted),'Hiding the retained native page must stop playback and cancel its requests');
        window.dispatchEvent(new Event(PLAYER_EXIT_EVENT,{cancelable:true}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));await wait();
        check(nativePath==='/player/fixture/movie-1','Inactive player must release exit/keyboard listeners');
        flushSync(()=>setPlayerActive(true));await wait(160);
        check(window.__fixtureCommands.filter(cmd=>cmd==='start_playback').length===2,'Returning explicitly to the retained player must start a fresh session');
        flushSync(()=>nativeRoot.unmount());await wait();nativeContainer.remove();
        result.dataset.status='pass';result.textContent='PASS: retained DOM/all loaded pages, library/home/search/settings vertical and horizontal Back positions, automatic paging, genre/tag/year/favorites server queries, dialog Escape and account isolation';
      }catch(error){result.dataset.status='fail';result.textContent=String(error.stack||error);}})();
    ` }, bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'} }).outputFiles[0].text;
    const file=path.join(directory,'fixture.html');
    const nativeBridge = `window.__fixtureCommands=[];let callbackId=0;window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};window.__TAURI_INTERNALS__={
      transformCallback(){return ++callbackId;},unregisterCallback(){},invoke:async(command,args)=>{window.__fixtureCommands.push(command);
        if(command==='plugin:event|listen')return ++callbackId;if(command==='plugin:app|version')return '0.4.4';if(command==='get_playback_log_path')return 'fixture-log';return {};}};`;
    fs.writeFileSync(file,'<!doctype html><meta charset="utf-8"><style>'+css+'#root{height:calc(100vh - 20px);margin:10px}</style><div id="root"></div><pre id="result" data-status="pending" style="display:none"></pre><script>'+nativeBridge+'</script><script>'+bundle.replace(/<\/script/gi,'<\\/script')+'</script>');
    for(const [width,scale] of [[1100,1],[480,1],[1100,1.25],[480,1.5]]){
      const execution=spawnSync(browser,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking',
        '--user-data-dir='+path.join(directory,'profile-'+width+'-'+scale),'--window-size='+width+',850','--force-device-scale-factor='+scale,
        '--dump-dom','--virtual-time-budget=8000',pathToFileURL(file).href],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:8*1024*1024});
      if(execution.error)throw execution.error;
      assert.equal(execution.status,0,execution.stderr);
      const report=execution.stdout.match(/<pre id="result" data-status="([^"]+)"[^>]*>([\s\S]*?)<\/pre>/);
      assert.equal(report?.[1],'pass',report?.[2]??execution.stderr);
      console.log(report[2]+' ('+width+'px, '+scale+'x)');
    }
  }finally{const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert(path.basename(resolved).startsWith('mjc-issue2-'));fs.rmSync(resolved,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
