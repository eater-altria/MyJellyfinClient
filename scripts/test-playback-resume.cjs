/** Real retained detail/player routes; synthetic media events and Tauri IPC only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

const browser = [process.env.MJC_TEST_CHROMIUM,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(file => file && fs.existsSync(file));
assert(browser, 'Set MJC_TEST_CHROMIUM for the playback resume regression');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mjc-playback-resume-'));
try {
  const bundle = esbuild.buildSync({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { MemoryRouter } from 'react-router-dom';
    import PageHost from './src/components/BrowsePageHost';
    import { useServers } from './src/store/servers';
    import { useSettings } from './src/store/settings';
    import { PLAYER_EXIT_EVENT } from './src/player/exitPlayback';
    import { publishPlaybackPosition } from './src/player/playbackProgress';
    const result = document.getElementById('result');
    const check = (ok, message) => { if (!ok) throw Error(message); };
    const wait = () => new Promise(resolve => setTimeout(resolve, 70));
    const slot = () => document.querySelector('[data-page-path]:not([hidden])');
    const button = () => [...slot().querySelectorAll('button')].find(b => b.textContent.includes('播放'));
    const close = async () => { window.dispatchEvent(new Event(PLAYER_EXIT_EVENT, {cancelable:true})); await wait(); };
    const native = window.fixtureNative;
    // Exercise actual React media handlers without downloading or decoding media.
    Object.defineProperties(HTMLMediaElement.prototype, {
      currentTime: { configurable:true, get(){return this.fixtureTime ?? 0;}, set(value){this.fixtureTime=value;} },
      duration: { configurable:true, get(){return 600;} },
      src: { configurable:true, get(){return '';}, set(){} },
      pause: { configurable:true, value(){} },
      load: { configurable:true, value(){this.fixtureTime=0;} },
    });
    (async () => { try {
      for (const protocol of ['jellyfin', 'emby']) {
        const stops=[], pending=[], starts=[];
        let reads=0, similarReads=0, failStop=false;
        const api={protocol,userId:'fixture-user',token:'fixture-only',baseUrl:'https://fixture.invalid',
          clientIdentity:()=>({name:'Fixture',version:'1',deviceName:'Fixture'}),
          getItem:async(id)=>{reads++;return {Id:id,Name:'Resume movie',Type:'Movie',RunTimeTicks:600e7,
            UserData:{PlaybackPositionTicks:120e7,PlayedPercentage:20,IsFavorite:true},
            MediaSources:[{Id:'source',Container:'mp4',SupportsDirectPlay:true}]};},
          getSimilar:async()=>{similarReads++;return {Items:[]};},
          getPlaybackInfo:async()=>({MediaSources:[{Id:'source',Container:'mp4',SupportsDirectPlay:true}]}),
          directStreamUrl:()=>'',externalSubtitleUrls:()=>[],logoUrl:()=>null,backdropUrl:()=>null,
          posterUrl:()=>null,thumbUrl:()=>null,
          reportPlaybackStart:async data=>{starts.push(data);},reportPlaybackProgress:async()=>{},
          reportPlaybackStopped:data=>{stops.push(data);return failStop?Promise.reject(Error('fixture offline')):new Promise(resolve=>pending.push(resolve));},
        };
        useServers.setState({servers:[{id:'fixture',name:'Fixture',userId:'fixture-user',protocol}],apis:{fixture:api},activeServerId:'fixture'});
        useSettings.setState({showPreviewImage:false,resumeFromLastPosition:true,autoFullscreenOnPlay:false,danmakuEnabled:false});
        const root=createRoot(document.getElementById('root'));
        flushSync(()=>root.render(<MemoryRouter initialEntries={['/server/fixture/movie/movie']}><PageHost/></MemoryRouter>));
        await wait();
        const detail=slot();
        check(button().textContent.includes('02:00'),'Initial detail must show the server resume position');
        const start=async expected=>{
          flushSync(()=>button().click());await wait();
          check(slot().dataset.pagePath==='/player/fixture/movie','Play must enter the actual retained player route');
          if(native){
            check(window.fixtureStarts.at(-1).start_seconds===expected,'Native start must inherit latest detail position: '+expected);
          }else{
            const video=slot().querySelector('video');video.dispatchEvent(new Event('loadedmetadata'));await wait();
            check(video.currentTime===expected,'Browser metadata handler must resume at latest detail position: '+expected);
          }
        };
        const position=async seconds=>{
          if(native){window.fixtureEmit('mpv://ready');window.fixtureEmit('mpv://position',{position:seconds,duration:600,paused:false,active:true});}
          else{const video=slot().querySelector('video');video.currentTime=seconds;video.dispatchEvent(new Event('play'));video.dispatchEvent(new Event('timeupdate'));}
          await wait();
        };
        await start(120);await position(185);
        const readsBeforeClose=reads;
        await close();
        check(slot()===detail,'Close must retain the original detail DOM');
        check(reads===readsBeforeClose&&similarReads===1,'Returning must not reload metadata or similar items');
        check(button().textContent.includes('03:05'),'Closing must refresh the detail resume label before the server stop resolves');
        check(stops.length===1&&stops[0].PositionTicks===185e7,'Stop must report the same final position exactly once');
        check(detail.querySelector('[aria-label="取消收藏"]'),'Progress updates must preserve favorite state');
        await start(185);await position(90);await close();
        check(button().textContent.includes('01:30'),'Seeking backwards must replace the old position too');
        pending.splice(0).reverse().forEach(resolve=>resolve());await wait();
        check(button().textContent.includes('01:30'),'Late stop completions must not roll back a newer position');
        await start(90);
        // Close before ready/play: an initial zero must preserve the saved position.
        if(native)window.fixtureEmit('mpv://position',{position:0,duration:0,paused:false,active:true});
        await close();
        check(button().textContent.includes('01:30'),'Cancelled loading must not replace the retained resume position');
        failStop=true;
        await start(90);await position(95);await close();
        check(button().textContent.includes('01:35'),'A failed server report must not lose the current in-app resume position');
        publishPlaybackPosition(api,'another-movie',30,600);await wait();
        check(button().textContent.includes('01:35'),'Another media item must not overwrite this detail');
        flushSync(()=>useServers.setState({apis:{fixture:{...api,userId:'other-user'}}}));await wait();
        publishPlaybackPosition(api,'movie',500,600);await wait();
        check(button().textContent.includes('02:00'),'Old account progress must not update a new API owner');
        pending.splice(0).forEach(resolve=>resolve());
        flushSync(()=>root.unmount());await wait();
      }
      result.dataset.status='pass';result.textContent='PASS: '+(native?'native IPC':'browser media')+' Jellyfin/Emby detail return, immediate resume, backward seek, late/failed stop, startup cancellation and account isolation';
    }catch(error){result.dataset.status='fail';result.textContent=String(error.stack||error);}})();
  ` }, bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'} }).outputFiles[0].text;
  const bridge = `window.fixtureStarts=[];const callbacks=new Map(),events=new Map();let serial=0;
    window.fixtureEmit=(event,payload)=>{for(const [id,value] of events)if(value.event===event)callbacks.get(value.handler)?.({event,id,payload});};
    if(window.fixtureNative){window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(_event,id){events.delete(id);}};
      window.__TAURI_INTERNALS__={transformCallback(fn){callbacks.set(++serial,fn);return serial;},unregisterCallback(id){callbacks.delete(id);},
        invoke:async(command,args)=>{if(command==='plugin:event|listen'){events.set(++serial,args);return serial;}
          if(command==='plugin:event|unlisten'){events.delete(args.eventId);return;}
          if(command==='start_playback')window.fixtureStarts.push(args.opts);
          if(command==='get_playback_log_path')return 'fixture-log';return {};}};}`;
  for (const native of [true,false]) {
    const file=path.join(directory, native?'native.html':'browser.html');
    fs.writeFileSync(file,'<!doctype html><meta charset="utf-8"><div id="root"></div><pre id="result" data-status="pending"></pre><script>window.fixtureNative='+native+';'+bridge+'</script><script>'+bundle.replace(/<\/script/gi,'<\\/script')+'</script>');
    const execution=spawnSync(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking',
      '--user-data-dir='+path.join(directory,native?'native-profile':'browser-profile'),'--dump-dom','--virtual-time-budget=8000',pathToFileURL(file).href],
    {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:8*1024*1024});
    if(execution.error)throw execution.error;
    assert.equal(execution.status,0,execution.stderr);
    const report=execution.stdout.match(/<pre id="result" data-status="([^"]+)"[^>]*>([\s\S]*?)<\/pre>/);
    assert.equal(report?.[1],'pass',report?.[2]??execution.stderr);
    console.log(report[2]);
  }
}finally{
  const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('mjc-playback-resume-'));fs.rmSync(resolved,{recursive:true,force:true});
}
