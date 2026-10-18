/** Real Settings + WebCrypto + CORS WebDAV in isolated Chromium, no real accounts. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const esbuild = require('esbuild');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const browser = [process.env.MJC_TEST_CHROMIUM, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find(file => file && fs.existsSync(file));
assert(browser, 'Set MJC_TEST_CHROMIUM to a trusted Chromium executable');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mjc-server-sync-'));
let child, socket, html = '', cloud = null, revision = 0, exposeEtag = true, holdGet = false;
let heldResponse;
const calls = [];
const webdav = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-Match, If-None-Match, X-Emby-Authorization, X-Emby-Token');
  if (exposeEtag) res.setHeader('Access-Control-Expose-Headers', 'ETag');
  if (req.method === 'OPTIONS') {res.writeHead(204); res.end(); return;}
  let body = ''; for await (const chunk of req) body += chunk;
  calls.push({url: req.url, method: req.method, headers: req.headers, body});
  if (req.url.startsWith('/dav/')) {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('fixture-user:fixture-dav-password').toString('base64')) {
      res.writeHead(401); res.end(); return;
    }
    if (req.method === 'GET') {
      if (holdGet) {heldResponse = res; return;}
      res.writeHead(cloud === null ? 404 : 200, cloud === null ? {} : {ETag: `"${revision}"`}); res.end(cloud ?? ''); return;
    }
    if ((req.headers['if-none-match'] === '*' && cloud !== null) || (req.headers['if-match'] && req.headers['if-match'] !== `"${revision}"`)) {
      res.writeHead(412); res.end(); return;
    }
    assert(req.headers['if-match'] || req.headers['if-none-match'] === '*');
    cloud = body; revision++; res.writeHead(201); res.end(); return;
  }
  const protocol = req.url.startsWith('/proxy/emby') ? 'emby' : 'jellyfin';
  const auth = req.headers['x-emby-authorization'];
  assert(auth?.includes(`Token="fixture-token-${protocol}"`));
  assert(auth.includes(`DeviceId="source-device-${protocol}"`));
  assert(!req.headers.authorization || req.headers.authorization === auth);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(req.url.includes('PlaybackInfo') ? {MediaSources: [{Id: 'source', MediaStreams: []}], PlaySessionId: 'fixture-session'}
    : {Items: [{Id: 'library'}], TotalRecordCount: 1}));
});
const page = http.createServer((_req, res) => {res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);});
const listen = server => new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});

(async () => {
  await listen(webdav); await listen(page);
  const davOrigin = `http://127.0.0.1:${webdav.address().port}`;
  const origin = `http://127.0.0.1:${page.address().port}`;
  const config = (await import(pathToFileURL(path.resolve('tailwind.config.js')).href)).default;
  const css = (await require('postcss')([require('tailwindcss')(config), require('autoprefixer')])
    .process(fs.readFileSync('src/index.css', 'utf8'), {from: path.resolve('src/index.css')})).css;
  const bundle = (await esbuild.build({stdin: {resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import Settings from './src/pages/Settings';
    import {BrowseActivity} from './src/hooks/useBrowseActivity';
    import {useServers} from './src/store/servers';
    const mediaOrigin = ${JSON.stringify(davOrigin)};
    const originals = ['emby','jellyfin'].map(protocol => ({id: protocol, protocol, name: '合成测试服务器 '.repeat(5) + protocol,
      address: mediaOrigin + '/proxy/' + protocol, userId: 'fixture-user', userName: 'Fixture user', token: 'fixture-token-' + protocol,
      ...(protocol === 'emby' ? {deviceId: 'source-device-emby'} : {})}));
    let root, visible, generation=0;
    function Shell(){const [active,setActive]=useState(true);visible=setActive;return <BrowseActivity.Provider value={active}><Settings/></BrowseActivity.Provider>;}
    function mount(){root=createRoot(document.getElementById('root'));flushSync(()=>root.render(<React.StrictMode><Shell key={++generation}/></React.StrictMode>));}
    function control(key){return document.querySelector('[aria-label="'+key+'"]') ?? [...document.querySelectorAll('button')].find(node=>node.textContent===key);}
    window.fixture={
      device(source=false){if(root)flushSync(()=>root.unmount());localStorage.clear();localStorage.setItem('mjc:deviceId',source?'source-device-jellyfin':'receiving-global-device');
        useServers.setState({servers:source?originals:[],apis:{},activeServerId:source?'emby':null,reachability:{}});mount();},
      point(key){const node=control(key);if(!node)throw Error('Missing control '+key);node.scrollIntoView({block:'center'});const r=node.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};},
      focus(key){const node=control(key);node.scrollIntoView({block:'center'});node.focus();node.select();},
      state(){return {text:document.querySelector('section[aria-labelledby=server-sync-title]').textContent,
        pending:!!document.querySelector('[aria-label=同步确认]'),busy:document.querySelector('section[aria-labelledby=server-sync-title] [role=status]').getAttribute('aria-busy')==='true',
        count:useServers.getState().servers.length, globalId:localStorage.getItem('mjc:deviceId'),
        ids:useServers.getState().servers.map(row=>row.deviceId), persisted:localStorage.getItem('mjc:webdav'),
        password:control('WebDAV 密码')?.value,phrase:control('配置加密口令')?.value,
        overflow:document.documentElement.scrollWidth>innerWidth,
        inputsFit:[...document.querySelectorAll('section[aria-labelledby=server-sync-title] input')].every(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;})};},
      hide(){flushSync(()=>visible(false));}, show(){flushSync(()=>visible(true));},
      tab(id){flushSync(()=>document.getElementById('settings-tab-'+id).click());},
      changeLocal(){useServers.setState(state=>({servers:[...state.servers]}));},
      async play(){for(const row of useServers.getState().servers){const api=useServers.getState().getApi(row.id);await api.getUserViews();const info=await api.getPlaybackInfo('movie','native');if(info.PlaySessionId!=='fixture-session')throw Error('Playback negotiation failed');}return true;},
      async restart(){const saved=localStorage.getItem('mjc:servers');useServers.setState({servers:[],apis:{}});localStorage.setItem('mjc:servers',saved);await useServers.persist.rehydrate();return this.play();},
    };
    window.fixture.device(true);window.fixtureReady=true;
  `}, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: {'process.env.NODE_ENV': '"development"'}})).outputFiles[0].text;
  html = `<!doctype html><meta charset="utf-8"><style>${css}html,body,#root{height:100%;}</style><div id="root"></div><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`;
  child = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-port=0', '--window-size=1280,900', `--user-data-dir=${path.join(directory, 'profile')}`, 'about:blank'], {windowsHide: true, stdio: 'ignore'});
  let port;
  for (let attempt = 0; attempt < 300; attempt++) {
    try {port = Number(fs.readFileSync(path.join(directory, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0]); break;} catch {await wait(50);}
  }
  assert(port, 'Chromium debugging endpoint did not start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {socket.addEventListener('open', resolve, {once: true}); socket.addEventListener('error', reject, {once: true});});
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', event => {
    const reply = JSON.parse(event.data); if (!reply.id) return;
    const entry = pending.get(reply.id); if (!entry) return;
    pending.delete(reply.id); clearTimeout(entry.timer);
    reply.error ? entry.reject(Error(reply.error.message)) : entry.resolve(reply.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => {pending.delete(id); reject(Error('Timed out: ' + method));}, 20000);
    pending.set(id, {resolve, reject, timer}); socket.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  const fixture = expression => evaluate('window.fixture.' + expression);
  const state = () => fixture('state()');
  const click = async key => {
    const point = await fixture(`point(${JSON.stringify(key)})`);
    await send('Input.dispatchMouseEvent', {type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1});
    await send('Input.dispatchMouseEvent', {type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1});
    await wait(30);
  };
  const fill = async (key, text) => {await fixture(`focus(${JSON.stringify(key)})`); await send('Input.insertText', {text});};
  const fillCredentials = async (phrase = 'fixture shared encryption phrase') => {
    await fill('WebDAV 目录地址', davOrigin + '/dav'); await fill('WebDAV 账号', 'fixture-user');
    await fill('WebDAV 密码', 'fixture-dav-password'); await fill('配置加密口令', phrase);
  };
  const settled = async () => {
    for (let attempt = 0; attempt < 300; attempt++) {if (!(await state()).busy) return state(); await wait(30);}
    throw Error('Sync did not settle');
  };
  await send('Page.enable'); await send('Page.navigate', {url: origin});
  for (let attempt = 0; attempt < 100 && !await evaluate('!!window.fixtureReady'); attempt++) await wait(50);
  assert(await evaluate('!!window.fixtureReady'));
  assert.equal(calls.length, 0, 'Opening Settings must not contact WebDAV or media servers');
  await fillCredentials(); await click('上传本机配置');
  const prepared = await settled(); assert(prepared.pending);
  assert.equal(cloud, null, 'Preparing an upload must not write until confirmed');
  assert(!prepared.persisted.includes('fixture-dav-password') && !prepared.persisted.includes('encryption'));
  await click('确认加密上传'); assert((await settled()).text.includes('已加密上传'));
  assert(cloud && !cloud.includes('fixture-token') && !cloud.includes('source-device') && !cloud.includes('/proxy/'));

  await fixture('device(false)'); await fillCredentials('incorrect encryption phrase'); await click('下载云端配置');
  const wrong = await settled(); assert(wrong.text.includes('无法解密') && wrong.count === 0 && !wrong.pending);
  await fill('配置加密口令', 'fixture shared encryption phrase'); await click('下载云端配置');
  const preview = await settled(); assert(preview.pending && preview.count === 0 && preview.text.includes('新增 2 个'));
  await click('确认合并并恢复登录');
  const restored = await state(); assert.equal(restored.count, 2); assert.equal(restored.globalId, 'receiving-global-device');
  assert.deepEqual(restored.ids, ['source-device-emby', 'source-device-jellyfin']);
  assert(await fixture('play()')); assert(await fixture('restart()'));
  assert(!calls.some(call => call.url.includes('AuthenticateByName')), 'Downloaded sessions must work without media passwords or another login');

  await click('上传本机配置'); assert((await settled()).pending); revision++;
  const copy = cloud; await click('确认加密上传'); assert((await settled()).text.includes('云端配置已改变')); assert.equal(cloud, copy);
  exposeEtag = false; await click('上传本机配置'); assert((await settled()).text.includes('ETag')); exposeEtag = true;
  await click('下载云端配置'); assert((await settled()).pending); await fixture('changeLocal()');
  await click('确认合并并恢复登录'); assert((await state()).text.includes('本地服务器配置已改变'));

  holdGet = true; await click('下载云端配置'); assert((await state()).busy);
  await fixture('hide()'); assert.equal((await state()).password, ''); assert.equal((await state()).phrase, '');
  heldResponse?.end(cloud); holdGet = false; await fixture('show()'); await wait(150);
  assert(!(await state()).pending, 'Hidden page must reject late downloads');
  await fillCredentials(); await click('下载云端配置'); assert((await settled()).pending);
  await click('取消'); assert(!(await state()).pending);
  await fixture('tab("list")'); await fixture('tab("general")');
  assert.equal((await state()).password, ''); assert.equal((await state()).phrase, '');
  for (const [width, scale] of [[1100, 1], [480, 1], [480, 1.25], [360, 1.5]]) {
    await send('Emulation.setDeviceMetricsOverride', {width, height: 800, deviceScaleFactor: scale, mobile: false});
    await fillCredentials(); await click('下载云端配置'); assert((await settled()).pending);
    const layout = await state(); assert(!layout.overflow && layout.inputsFit, `Sync UI must fit ${width}px / ${scale}x`);
    if (process.env.MJC_TEST_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.MJC_TEST_ARTIFACT_DIR, {recursive: true});
      await fixture('point("确认合并并恢复登录")');
      const shot = await send('Page.captureScreenshot', {format: 'png'});
      fs.writeFileSync(path.join(process.env.MJC_TEST_ARTIFACT_DIR, `server-sync-${width}-${scale}.png`), Buffer.from(shot.data, 'base64'));
    }
    await click('取消');
  }
  console.log('PASS: real Settings/React/WebCrypto/CORS WebDAV, upload confirmation, fresh-device download and direct playback negotiation/restart, wrong phrase, ETag conflicts/exposure, local races, cancellation, secret lifetime and narrow/DPI layouts');
})().catch(error => {console.error(error); process.exitCode = 1;}).finally(async () => {
  heldResponse?.end(); socket?.close();
  if (child && child.exitCode === null) {const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await Promise.race([exited, wait(3000)]);}
  for (const server of [page, webdav]) {server.closeAllConnections(); server.close();}
  const resolved = path.resolve(directory); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('mjc-server-sync-')); fs.rmSync(resolved, {recursive: true, force: true});
});
