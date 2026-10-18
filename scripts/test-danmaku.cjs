/** Offline real React/Chromium regression. No user server or profile is read. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');
const sourceBundle = require('./source-bundle.cjs');
const storage = new Map();
global.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };

const { MediaServerApi } = sourceBundle('src/api/mediaServer.ts');
const { danmakuApiBase, searchDanmaku, danmakuMatchRequest, matchDanmaku } = sourceBundle('src/api/danmaku.ts');

async function main() {
  const requests = [];
  global.fetch = async (url, opts) => {
    requests.push({ url, opts });
    return new Response('<i/>', { status: 200 });
  };
  const api = new MediaServerApi('https://fixture.invalid/proxy/jellyfin', 'fixture-private-token', 'fixture-user');
  assert.equal(await api.getDanmakuXml('item/1'), '<i/>');
  assert.equal(requests[0].url, 'https://fixture.invalid/proxy/jellyfin/api/danmu/item%2F1/raw');
  assert(new Headers(requests[0].opts.headers).get('Authorization').includes('fixture-private-token'));
  assert.equal(requests[0].opts.redirect, 'error');
  global.fetch = async () => new Response('', { status: 404 });
  assert.equal(await api.getDanmakuXml('missing'), null);
  global.fetch = async () => new Response('', { status: 403 });
  await assert.rejects(api.getDanmakuXml('denied'), /403/);
  assert.equal(danmakuApiBase('https://fixture.invalid/token/api/v2/'), 'https://fixture.invalid/token/api/v2');
  for (const url of ['file:///secret', 'https://user:pass@fixture.invalid', 'https://fixture.invalid/?token=x']) {
    assert.throws(() => danmakuApiBase(url));
  }
  global.fetch = async (url, opts) => {
    requests.push({ url, opts });
    return new Response(JSON.stringify({ Animes: [{ AnimeTitle: 'Fixture', Episodes: [{ EpisodeId: 91, EpisodeTitle: '第 1 集' }] }] }));
  };
  assert.equal((await searchDanmaku('https://api.invalid/token', 'Fixture', new AbortController().signal))[0].id, '91');
  const custom = requests.at(-1);
  assert.equal(custom.opts.headers, undefined); assert.equal(custom.opts.credentials, 'omit');
  assert(!custom.url.includes('fixture-private-token'));
  const episode = { Id: 'fixture-episode', Name: 'Episode', Type: 'Episode', SeriesName: 'Fixture Series',
    ParentIndexNumber: 1, IndexNumber: 3, ProductionYear: 2011, RunTimeTicks: 1440_0000000,
    Path: 'private-path-that-must-not-be-sent' };
  assert.deepEqual(danmakuMatchRequest(episode), { fileName: 'Fixture Series (2011) S01E03', matchMode: 'fileNameOnly', videoDuration: 1440 });
  assert.equal(danmakuMatchRequest({ ...episode, IndexNumber: undefined }), null);
  assert.equal(danmakuMatchRequest({ ...episode, ParentIndexNumber: undefined }), null);
  assert.equal(danmakuMatchRequest({ ...episode, ParentIndexNumber: 0 }).fileName, 'Fixture Series (2011) S00E03');
  assert.equal(danmakuMatchRequest({ Id: 'film', Name: 'Fixture Film', Type: 'Movie', ProductionYear: 2024 }).fileName, 'Fixture Film (2024)');
  const matched = { episodeId: 101, animeTitle: 'Fixture Series First Season (2011)', episodeTitle: 'Episode 3' };
  global.fetch = async (url, opts) => { requests.push({ url, opts }); return new Response(JSON.stringify({ success: true, isMatched: true, matches: [matched] })); };
  assert.equal((await matchDanmaku('https://api.invalid/token', episode, new AbortController().signal)).id, '101');
  const auto = requests.at(-1);
  assert(auto.url.endsWith('/api/v2/match')); assert.equal(auto.opts.method, 'POST');
  assert.deepEqual(JSON.parse(auto.opts.body), danmakuMatchRequest(episode));
  assert.equal(auto.opts.credentials, 'omit'); assert.deepEqual(auto.opts.headers, { 'Content-Type': 'application/json' });
  assert(!auto.opts.body.includes(episode.Path));
  for (const status of [404, 405, 501]) {
    global.fetch = async () => new Response('', { status });
    assert.equal(await matchDanmaku('https://api.invalid', episode, new AbortController().signal), null);
  }
  global.fetch = async () => new Response('', { status: 401 });
  await assert.rejects(matchDanmaku('https://api.invalid', episode, new AbortController().signal), /401/);
  for (const matches of [[], [matched, { ...matched, episodeId: 102 }]]) {
    global.fetch = async () => new Response(JSON.stringify({ success: true, isMatched: true, matches }));
    assert.equal(await matchDanmaku('https://api.invalid', episode, new AbortController().signal), null);
  }
  global.fetch = async () => new Response(JSON.stringify({ success: true, isMatched: false, matches: [matched] }));
  assert.equal(await matchDanmaku('https://api.invalid', episode, new AbortController().signal), null);
  global.fetch = async () => new Response('{}');
  await assert.rejects(matchDanmaku('https://api.invalid', episode, new AbortController().signal), /格式无效/);
  console.log('PASS: plugin raw XML, proxy prefix, credential boundaries, missing/HTTP errors and compatible API paths');

  const browser = [process.env.MJC_TEST_CHROMIUM, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && fs.existsSync(p));
  assert(browser, 'Set MJC_TEST_CHROMIUM to a Chromium executable');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mjc-danmaku-'));
  try {
    const bundle = esbuild.buildSync({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import React, {useRef} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {MemoryRouter,Routes,Route} from 'react-router-dom';
      import {parseDanmaku, layoutDanmaku, danmakuAtTime} from './src/player/danmaku';
      import {DANMAKU_DEFAULTS, normalizeDanmakuSettings} from './src/player/danmakuSettings';
      import {useDanmaku} from './src/hooks/useDanmaku';
      import {useSettings} from './src/store/settings';
      import {useServers} from './src/store/servers';
      import DanmakuCanvas from './src/components/DanmakuCanvas';
      import Settings from './src/pages/Settings';
      import Player from './src/pages/Player';
      import NativePlayer from './src/pages/NativePlayer';
      import {BrowseActivity} from './src/hooks/useBrowseActivity';
      const result = document.getElementById('result');
      window.addEventListener('error',e=>{result.dataset.status='fail';result.textContent=e.message;});
      const check = (v, m) => {if(!v) throw new Error(m);};
      const wait = () => new Promise(r => setTimeout(r, 30));
      // Blob I/O runs outside Chromium virtual time; keep its completion deterministic.
      const fixtureFile = (text,name) => Object.assign(new File([text],name), {text:()=>Promise.resolve(text)});
      const xml = '<i><d p="0,1,25,16777215,0,0,x,1">滚动 &amp; 测试</d><d p="0,1,25,16777215">滚动 &amp; 测试</d><d p="1,4,25,255">底部</d><d p="1,5,25,16711680">顶部</d><d p="1,6,25,65280">反向</d><d p="-1,1,25,0">invalid</d><d p="2,7,25,0">advanced</d><d p="1,1,25,16777216">invalid</d><d p="1,1,25,0"><![CDATA[{\\\\pos(1,1)} <b>]]></d></i>';
      (async () => {
        result.textContent='parsing';
        const parsed = parseDanmaku(xml);
        check(parsed.length===5 && parsed[0].text==='滚动 & 测试', 'XML entities, CDATA, modes, validation and duplicate removal');
        for(const bad of ['<i><d>', '<html/>', '<!DOCTYPE i [<!ENTITY x SYSTEM "file:///secret">]><i/>', '{}']) {
          let threw=false;try{parseDanmaku(bad)}catch{threw=true}check(threw,'Malformed and unsafe XML/JSON must be rejected');
        }
        check(parseDanmaku('<i/>').length===0, 'Empty XML is valid');
        const json=parseDanmaku(JSON.stringify({comments:[{p:'1.5,1,16711680,hash',m:'JSON 红色'},{p:'2,5,255',text:'top'}]}));
        check(json[0].time===1.5 && json[0].color===16711680, 'JSON p uses color at index 2');
        const st={...DANMAKU_DEFAULTS,danmakuEnabled:true};
        const layout=layoutDanmaku(parsed,800,450,st,t=>t.length*24);
        check(danmakuAtTime(layout,3,8).length===layout.length,'Timeline starts at comment time');
        check(danmakuAtTime(layout,100,8).length===0 && danmakuAtTime(layout,0,8).length===1,'Forward/backward seeking restores correct range');
        const dense=layoutDanmaku(Array.from({length:1000},(_,i)=>({time:0,mode:1,color:0xffffff,text:'dense'+i})),320,240,st,t=>t.length*24);
        check(dense.length<=2,'Lane limits must skip colliding comments');
        for(const mode of [1,6]) {
          const spaced=layoutDanmaku([0,2,3].map(time=>({time,mode,color:0xffffff,text:'lane'})),320,134,st,()=>80);
          check(spaced.length===2 && spaced[1].time===3,'Slower rolling and reverse comments must retain enough lane spacing');
        }
        const settings=normalizeDanmakuSettings({danmakuEnabled:'broken',danmakuFontSize:999,danmakuOpacity:NaN,danmakuOffset:-900});
        check(!settings.danmakuEnabled && settings.danmakuFontSize===48 && settings.danmakuOpacity===.85 && settings.danmakuOffset===-600,'Persisted boundary normalization');

        const pending=[];
        result.textContent='hook';
        const fakeApi={ getDanmakuXml: (id, signal) => new Promise((resolve,reject)=>pending.push({id,signal,resolve,reject})) };
        useServers.setState({ getApi: () => fakeApi });
        useSettings.getState().reset();
        const root=createRoot(document.getElementById('root'));
        let controller;
        const one={Id:'one',Name:'Fixture Movie'},two={Id:'two',Name:'Other Movie'};
        function Hook({item,active=true}) {controller=useDanmaku('fixture',item,active);return <div>{controller.status}</div>;}
        flushSync(()=>root.render(<Hook item={one}/>));await wait();
        result.textContent='hook disabled';check(pending.length===0,'Disabled danmaku must not request');
        flushSync(()=>useSettings.getState().set('danmakuEnabled',true));await wait();
        result.textContent='hook enabled';check(pending.length===1,'Enabled danmaku requests once');
        flushSync(()=>root.render(<Hook item={two}/>));await wait();
        result.textContent='hook changed';check(pending[0].signal.aborted,'Media change cancels pending request');
        pending[0].resolve(xml);await wait();check(controller.comments.length===0,'Late old response must not enter new media');
        result.textContent='hook current';pending[1].resolve('<i><d p="2,1,25,16777215">new</d></i>');await wait();check(controller.comments[0].text==='new','Current response is published');
        result.textContent='hook hiding';flushSync(()=>root.render(<Hook item={two} active={false}/>));await wait();check(controller.comments.length===0,'Hidden player must clear rendering data');
        flushSync(()=>root.render(<Hook item={two}/>));await wait();
        pending.at(-1).reject(new Error('fixture failure'));await wait();check(controller.status==='fixture failure','Request failure remains visible');
        flushSync(()=>controller.retry());await wait();pending.at(-1).resolve('<i/>');await wait();
        check(controller.status.includes('没有可播放'),'Empty danmaku differs from load failure');
        result.textContent='hook importing';await controller.importXml(fixtureFile(xml,'fixture.xml'));await wait();check(controller.comments.length===5,'Local XML import enables and publishes comments');
        await controller.importXml(fixtureFile('<i><d>','broken.xml'));await wait();check(controller.comments.length===5 && controller.status.includes('格式无效'),'Invalid import keeps loaded data and reports error');
        let finishImport;const lateFile={size:10,text:()=>new Promise(r=>finishImport=r)};
        result.textContent='late import';
        const late=controller.importXml(lateFile);flushSync(()=>root.render(<Hook item={one}/>));await wait();finishImport(xml);await late;await wait();
        check(controller.comments.length===0,'Late file read cannot cross playback scope');
        let request;
        window.fetch=async(url,opts)=>{request={url,opts};return new Response(JSON.stringify(String(url).endsWith('/match')
          ? {success:true,isMatched:false,matches:[]} : {animes:[{animeTitle:'Fixture',episodes:[{episodeId:'91',episodeTitle:'第1集'}]}]}));};
        flushSync(()=>{useSettings.getState().set('danmakuSource','api');useSettings.getState().set('danmakuApiUrl','https://fixture.invalid/token');});await wait();
        check(controller.choices.length===1 && controller.comments.length===0 && request.opts.credentials==='omit','Custom search must wait for explicit episode selection without credentials');
        window.fetch=async(url,opts)=>{request={url,opts};return new Response(xml);};
        flushSync(()=>controller.select('91'));await wait();check(controller.comments.length===5 && request.url.includes('/comment/91?format=xml'),'Selected episode fetches and parses XML');
        flushSync(()=>useSettings.getState().set('danmakuApiUrl','https://other.invalid'));
        await wait();check(controller.selection==='','Changing services clears the old selected episode ID');
        const episode={Id:'episode-fixture',Name:'Episode title',Type:'Episode',SeriesName:'Fixture Series',ParentIndexNumber:1,IndexNumber:1,ProductionYear:2011};
        let matchRequests=0,commentRequests=0,lastBody;
        window.fetch=async(url,opts)=>{
          if(String(url).endsWith('/match')){matchRequests++;lastBody=JSON.parse(opts.body);return new Response(JSON.stringify({success:true,isMatched:true,
            matches:[{episodeId:'101',animeTitle:'Fixture Series First Season (2011)',episodeTitle:'Episode 1'}]}));}
          if(String(url).includes('/search/episodes'))return new Response(JSON.stringify({animes:[{animeTitle:'Fixture Series',episodes:[
            {episodeId:'101',episodeTitle:'Episode 1'},{episodeId:'102',episodeTitle:'Episode 2'}]}]}));
          commentRequests++;return new Response(xml);
        };
        flushSync(()=>root.render(<Hook item={episode}/>));await wait();await wait();
        check(lastBody.fileName==='Fixture Series (2011) S01E01','Actual hook sends year and season/episode instead of just title');
        check(controller.comments.length===5 && controller.selection==='101' && controller.status.includes('自动匹配成功'),'Recognized episode loads without manual selection');
        const beforeSearch=matchRequests;
        flushSync(()=>controller.search());await wait();
        check(matchRequests===beforeSearch && controller.choices.length===2 && controller.comments.length===0,'Explicit change-source searches alternatives without rematching');
        flushSync(()=>controller.select('102'));await wait();check(controller.selection==='102' && controller.comments.length===5,'Manual correction overrides the automatic match');
        flushSync(()=>controller.retry());await wait();await wait();check(controller.selection==='101' && matchRequests>beforeSearch,'Retry restores automatic identification');
        const delayedMatches=[];
        window.fetch=(url,opts)=>{
          if(String(url).endsWith('/match'))return new Promise(resolve=>delayedMatches.push({resolve,signal:opts.signal}));
          commentRequests++;return Promise.resolve(new Response(xml));
        };
        flushSync(()=>controller.retry());await wait();
        flushSync(()=>root.render(<Hook item={{...episode,Id:'episode-next',IndexNumber:2}}/>));await wait();
        check(delayedMatches[0].signal.aborted,'Media changes abort automatic matching');
        const beforeLate=commentRequests;delayedMatches[0].resolve(new Response(JSON.stringify({success:true,isMatched:true,matches:[{episodeId:'101',animeTitle:'Old',episodeTitle:'Episode 1'}]})));
        await wait();check(commentRequests===beforeLate && controller.comments.length===0,'Late match cannot start an old comment download');
        delayedMatches[1].resolve(new Response(JSON.stringify({success:true,isMatched:true,matches:[{episodeId:'102',animeTitle:'Fixture Series',episodeTitle:'Episode 2'}]})));
        await wait();check(controller.selection==='102' && controller.comments.length===5,'Current media matching completes normally');
        flushSync(()=>root.unmount());

        const canvasRoot=createRoot(document.getElementById('root'));
        result.textContent='canvas';
        const video=document.createElement('video');let time=3;
        Object.defineProperty(video,'currentTime',{get:()=>time});
        const videoRef={current:video};
        let frameCallback;
        const realRaf=window.requestAnimationFrame,realCancel=window.cancelAnimationFrame;
        window.requestAnimationFrame=fn=>{frameCallback=fn;return 1;};window.cancelAnimationFrame=()=>{};
        flushSync(()=>canvasRoot.render(<div style={{position:'relative',width:800,height:450}}><DanmakuCanvas video={videoRef} comments={parsed} settings={st} active/></div>));
        await wait();frameCallback();
        const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
        const pixels=()=>ctx.getImageData(0,0,canvas.width,canvas.height).data;
        const painted=()=>pixels().some((v,i)=>i%4===3 && v>0);
        check(painted(),'Canvas must draw actual pixels');
        const paused=pixels().slice();frameCallback();check(pixels().every((v,i)=>v===paused[i]),'Paused/stalled media clock freezes positions');
        const drawn=[];const fillText=ctx.fillText.bind(ctx);
        ctx.fillText=(text,x,y,...args)=>{drawn.push({text,x});fillText(text,x,y,...args);};
        time=4;frameCallback();check(pixels().some((v,i)=>v!==paused[i]),'Advance or speed change follows media time');
        const positionsAt4=drawn.slice();drawn.length=0;time=5;frameCallback();
        for(const mode of [1,6]) {
          const comment=parsed.find(c=>c.mode===mode),start=positionsAt4.find(d=>d.text===comment.text),end=drawn.find(d=>d.text===comment.text);
          const oldSpeed=(800+Math.ceil(ctx.measureText(comment.text).width)+8)/8;
          check(start && end && Math.abs(Math.abs(end.x-start.x)-oldSpeed*.7)<0.001,'Actual Canvas movement must be exactly 30% slower in both directions');
        }
        time=10;frameCallback();check(painted(),'Slower comments must remain visible past the former 8-second lifetime');
        time=12.5;frameCallback();check(!painted(),'Comments must leave after the extended lifetime');
        time=100;frameCallback();check(!painted(),'Seeking beyond timeline clears old comments');
        time=3;frameCallback();check(painted(),'Backward seeking restores comments');
        flushSync(()=>canvasRoot.unmount());window.requestAnimationFrame=realRaf;window.cancelAnimationFrame=realCancel;

        const uiRoot=createRoot(document.getElementById('root'));
        result.textContent='settings';
        flushSync(()=>uiRoot.render(<MemoryRouter><Settings/></MemoryRouter>));
        flushSync(()=>document.getElementById('settings-tab-danmaku').click());
        check(document.querySelector('[aria-label="启用弹幕"]') && !document.body.textContent.includes('弹幕功能将在后续版本提供'),'Real settings placeholder is replaced');
        const durationSelect=document.querySelector('[aria-label="单条显示时长"]');
        check(durationSelect?.selectedOptions[0]?.textContent==='11.43 秒','Display settings must show the effective slowed duration for the saved default');
        useSettings.getState().set('danmakuEnabled',true);useSettings.persist.rehydrate();check(useSettings.getState().danmakuEnabled,'Toggle survives hydration');
        flushSync(()=>uiRoot.render(<MemoryRouter><Player/></MemoryRouter>));await wait();
        const on=document.querySelector('[aria-label="关闭弹幕"]');check(on?.getAttribute('aria-pressed')==='true','Actual player exposes enabled toggle');
        const onIcon=on.innerHTML;flushSync(()=>on.click());
        const off=document.querySelector('[aria-label="开启弹幕"]');check(off && off.innerHTML!==onIcon && !useSettings.getState().danmakuEnabled,'Player toggle persists and changes icon');
        const rect=off.getBoundingClientRect();check(rect.width>0 && rect.right<=window.innerWidth,'Toggle fits the viewport');
        flushSync(()=>uiRoot.unmount());
        result.textContent='native bridge';
        const callbacks=new Map(),listeners=new Map(),listenerNames=new Map(),commands=[];let serial=0;
        window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
        window.__TAURI_INTERNALS__={transformCallback:fn=>{const id=++serial;callbacks.set(id,fn);return id;},unregisterCallback:id=>callbacks.delete(id),
          invoke:async(name,args)=>{commands.push({name,args});
            if(name==='plugin:event|listen'){const id=++serial;listeners.set(args.event,callbacks.get(args.handler));listenerNames.set(id,args.event);return id;}
            if(name==='plugin:event|unlisten'){listeners.delete(listenerNames.get(args.eventId));return {};}
            if(name==='get_playback_log_path')return 'fixture-log';return {};}};
        const nativeItem={...one,MediaSources:[{Id:'source',Container:'mp4',SupportsDirectPlay:true}]};
        useServers.setState({getApi:()=>({protocol:'jellyfin',baseUrl:'https://fixture.invalid',clientIdentity:()=>({name:'Fixture',version:'1',deviceName:'Test'}),
          getItem:async()=>nativeItem,getDanmakuXml:async()=>xml,directStreamUrl:()=> 'https://fixture.invalid/video',externalSubtitleUrls:()=>[],
          reportPlaybackStart:async()=>{},reportPlaybackStopped:async()=>{},reportPlaybackProgress:async()=>{}})});
        flushSync(()=>{useSettings.getState().set('danmakuSource','server');useSettings.getState().set('danmakuEnabled',true);});
        const nativeRoot=createRoot(document.getElementById('root'));
        const nativeView=active=><MemoryRouter initialEntries={['/player/fixture/one']}><BrowseActivity.Provider value={active}><Routes><Route path='/player/:serverId/:itemId' element={<NativePlayer/>}/></Routes></BrowseActivity.Provider></MemoryRouter>;
        flushSync(()=>nativeRoot.render(nativeView(true)));await wait();await wait();await wait();
        const started=commands.find(c=>c.name==='start_playback');check(started,'Actual native component starts a playback session');
        const diagnosticId=started.args.opts.diagnostic_id;
        check(!('danmakuApiUrl' in started.args.opts.settings),'Custom API paths/tokens must not enter mpv startup settings');
        check(commands.some(c=>c.name==='player_danmaku' && c.args.comments.length===5 && c.args.diagnosticId===diagnosticId),'Parsed data reaches native IPC under the correct session');
        check(commands.filter(c=>c.name==='player_danmaku').every(c=>!('danmakuApiUrl' in c.args.settings)),'Display IPC must exclude API paths/tokens');
        listeners.get('mpv://danmaku-action')({payload:{diagnosticId:'old',action:'toggle'}});await wait();check(useSettings.getState().danmakuEnabled,'Old native session cannot toggle current state');
        listeners.get('mpv://danmaku-action')({payload:{diagnosticId,action:'toggle'}});await wait();
        check(!useSettings.getState().danmakuEnabled && commands.filter(c=>c.name==='player_danmaku').at(-1).args.settings.danmakuEnabled===false,'Native control event persists the toggle and clears native data');
        flushSync(()=>nativeRoot.render(nativeView(false)));await wait();
        check(commands.some(c=>c.name==='stop_playback') && !listeners.has('mpv://danmaku-action'),'Hidden native player stops playback and releases danmaku listener');
        flushSync(()=>nativeRoot.unmount());delete window.__TAURI_INTERNALS__;
        result.dataset.status='pass';result.textContent='PASS: XML/JSON, auto matching/manual correction/cancellation, safety/lanes/seek, Canvas pixels/pause/seek, settings/icons and native IPC/session/credential isolation';
      })().catch(e=>{result.dataset.status='fail';result.textContent=String(e.stack||e);});
    ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' } }).outputFiles[0].text;
    const css = require('postcss')([require('tailwindcss'), require('autoprefixer')]);
    const styles = (await css.process(fs.readFileSync('src/index.css', 'utf8'), { from: 'src/index.css' })).css;
    const page = path.join(directory, 'fixture.html');
    fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><style>' + styles + '</style><div id="root" style="height:600px"></div><pre id="result" data-status="pending"></pre><script>' + bundle.replace(/<\/script/gi, '<\\/script') + '</script>');
    for (const [width, scale] of [[1100, 1], [480, 1], [1100, 1.25], [480, 1.5]]) {
      const run = spawnSync(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        '--allow-file-access-from-files', '--user-data-dir=' + path.join(directory, `profile-${width}-${scale}`),
        '--window-size=' + width + ',900', '--force-device-scale-factor=' + scale, '--dump-dom', '--virtual-time-budget=6000', pathToFileURL(page).href],
        { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 7 * 1024 * 1024 });
      if (run.error) throw run.error;
      assert.equal(run.status, 0, run.stderr);
      const output = run.stdout.match(/<pre id="result" data-status="([^"]+)"[^>]*>([\s\S]*?)<\/pre>/);
      if (output?.[1] !== 'pass') {
        fs.mkdirSync('.tmp/danmaku-debug', { recursive: true });
        fs.writeFileSync('.tmp/danmaku-debug/result.html', run.stdout);
        fs.writeFileSync('.tmp/danmaku-debug/fixture.html', fs.readFileSync(page));
      }
      assert.equal(output?.[1], 'pass', output?.[2] ?? run.stderr);
      console.log(output[2] + ` (${width}px, ${scale}x)`);
    }
  } finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('mjc-danmaku-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
