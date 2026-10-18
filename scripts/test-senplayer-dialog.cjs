/** Real React dialog and trusted Chromium input; isolated profile and synthetic connections. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const esbuild = require('esbuild');
const browser = [process.env.MJC_TEST_CHROMIUM, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find(file => file && fs.existsSync(file));
assert(browser, 'Set MJC_TEST_CHROMIUM to a trusted Chromium executable');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mjc-senplayer-dialog-'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, socket;

(async () => {
  const config = (await import(pathToFileURL(path.resolve('tailwind.config.js')).href)).default;
  const css = (await require('postcss')([require('tailwindcss')(config), require('autoprefixer')])
    .process(fs.readFileSync('src/index.css', 'utf8'), {from: path.resolve('src/index.css')})).css;
  const bundle = esbuild.buildSync({stdin: {resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import AddServerDialog from './src/components/AddServerDialog';
    import {useServers} from './src/store/servers';
    import {getServerConnector} from './src/api/mediaServer';
    const root=createRoot(document.getElementById('root'));
    const emby=getServerConnector('emby');
    const resolveAddress=emby.loginAddress;
    const fixedIdentity=emby.fixedClientIdentity;
    let generation=0,closed=0,pending,calls=[];
    const saved={id:'fixture-server',name:'Fixture server',address:'https://fixture.invalid/proxy/emby',
      userName:'fixture-user',protocol:'emby',connectionMode:'senplayer',clientName:'Existing custom name',deviceId:'fixture-stable-device'};
    const checkbox=text=>[...document.querySelectorAll('label')].find(label=>label.textContent.trim()===text)?.querySelector('input[type=checkbox]');
    const control=key=>key==='compat'?checkbox('SenPlayer 兼容连接')
      :key==='register'?checkbox('重新登记此服务器的登录设备')
      :key==='submit'?document.querySelector('button[type=submit]')
      :key==='emby'?document.querySelector('input[type=radio][value=emby]')
      :document.querySelector('input[id$="-'+key+'"]');
    useServers.setState({addServer:(...args)=>{calls.push({kind:'add',args});return new Promise(resolve=>{pending=resolve;});},
      updateServer:(...args)=>{calls.push({kind:'update',args});return new Promise(resolve=>{pending=resolve;});}});
    window.fixture={
      open(edit=false,capability=true,mode){
        emby.loginAddress=capability?resolveAddress:undefined;
        emby.fixedClientIdentity=capability?fixedIdentity:undefined;
        calls=[];closed=0;pending=undefined;
        flushSync(()=>root.render(<React.StrictMode><AddServerDialog key={++generation} server={edit?{...saved,connectionMode:mode}:undefined} onClose={()=>{closed++;}}/></React.StrictMode>));
      },
      point(key){const node=control(key);if(!node)throw Error('Missing control '+key);node.scrollIntoView({block:'center'});const r=node.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};},
      focus(key){const node=control(key);node.scrollIntoView({block:'center'});node.focus();if(node.select)node.select();},
      async resolve(){pending?.();await new Promise(resolve=>setTimeout(resolve,0));},
      snapshot(){
        const dialog=document.querySelector('[role=dialog]'),rect=dialog.getBoundingClientRect(),scroller=dialog.querySelector('.overflow-y-auto');
        const compat=control('compat'),register=control('register'),submit=control('submit');
        return {calls,closed,compat:compat?{checked:compat.checked,disabled:compat.disabled,labels:[...compat.labels].map(label=>label.textContent.trim())}:null,
          register:register?{checked:register.checked,disabled:register.disabled}:null,
          clientVisible:!!control('client'),submitDisabled:submit.disabled,
          radiosDisabled:[...document.querySelectorAll('input[type=radio]')].every(node=>node.matches(':disabled')),
          closeDisabled:document.querySelector('button[aria-label=关闭]').disabled,
          fits:rect.left>=0&&rect.top>=0&&rect.right<=innerWidth+1&&rect.bottom<=innerHeight+1,
          horizontalOverflow:document.documentElement.scrollWidth>innerWidth||scroller.scrollWidth>scroller.clientWidth+1,
          scrollTop:scroller.scrollTop,scrollMax:scroller.scrollHeight-scroller.clientHeight,
          status:document.querySelector('[role=status]').textContent};
      },
      unmount(){flushSync(()=>root.unmount());}
    };
    window.fixture.open();window.fixtureReady=true;
  `}, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: {'process.env.NODE_ENV': '"development"'}}).outputFiles[0].text;
  const page = path.join(directory, 'fixture.html');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`);
  child = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-port=0', '--window-size=1280,900', `--user-data-dir=${path.join(directory, 'profile')}`, 'about:blank'], {windowsHide: true, stdio: 'ignore'});
  let port;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {port = Number(fs.readFileSync(path.join(directory, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0]); break;}
    catch {await wait(50);}
  }
  assert(port, 'Chromium debugging endpoint did not start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {socket.addEventListener('open', resolve, {once: true}); socket.addEventListener('error', reject, {once: true});});
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const reply = JSON.parse(event.data);
    if (!reply.id) return;
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id); clearTimeout(entry.timer);
    reply.error ? entry.reject(Error(reply.error.message)) : entry.resolve(reply.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {pending.delete(id); reject(Error('Timed out: ' + method));}, 15000);
    pending.set(id, {resolve, reject, timer}); socket.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  const fixture = expression => evaluate('window.fixture.' + expression);
  const snapshot = () => fixture('snapshot()');
  const click = async key => {
    const point = await fixture(`point(${JSON.stringify(key)})`);
    await send('Input.dispatchMouseEvent', {type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1});
    await send('Input.dispatchMouseEvent', {type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1});
    await wait(30);
  };
  const fill = async (key, text) => {await fixture(`focus(${JSON.stringify(key)})`); await send('Input.insertText', {text});};
  await send('Page.enable'); await send('Page.navigate', {url: pathToFileURL(page).href});
  for (let i = 0; i < 100 && !await evaluate('!!window.fixtureReady'); i++) await wait(50);
  assert(await evaluate('!!window.fixtureReady'), 'Fixture did not render');
  for (const [width, height, scale] of [[1280, 900, 1], [420, 600, 1], [420, 600, 1.25], [420, 600, 1.5], [360, 520, 1]]) {
    await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: scale, mobile: false});
    for (const protocol of ['jellyfin', 'emby']) {
      await fixture('open()');
      if (protocol === 'emby') await click('emby');
      let state = await snapshot();
      assert.equal(state.compat, null, 'Default SenPlayer transport has no optional compatibility checkbox');
      assert.match(state.status, /使用 SenPlayer 连接方式/);
      assert.equal(state.register, null, 'New connections do not replace device identity');
      await fill('address', 'https://fixture.invalid/proxy'); await fill('username', 'fixture-user'); await fill('password', 'fixture-password');
      await click('submit');
      state = await snapshot();
      assert.equal(state.calls.length, 1);
      assert.equal(state.calls[0].kind, 'add');
      assert.deepEqual(state.calls[0].args.slice(0, 4), ['https://fixture.invalid/proxy', 'fixture-user', 'fixture-password', '']);
      assert.deepEqual(state.calls[0].args.slice(5), [protocol], 'UI uses the default transport without mode flags');
      assert(state.radiosDisabled && state.submitDisabled && state.closeDisabled, 'Protocol and submit controls disable while connecting');
      await click('submit'); assert.equal((await snapshot()).calls.length, 1, 'Disabled submit prevents duplicate login');
      await fixture('resolve()'); assert.equal((await snapshot()).closed, 1);
    }
    for (const mode of [undefined, 'standard', 'senplayer']) {
      await fixture(`open(true,true,${JSON.stringify(mode) ?? 'undefined'})`);
      let state = await snapshot();
      assert.equal(state.compat, null, 'Retired persisted flags cannot expose a mode checkbox');
      assert.match(state.status, /使用 SenPlayer 连接方式/);
      const ax = await send('Accessibility.getFullAXTree');
      assert(ax.nodes.some(node => node.role?.value === 'checkbox' && node.name?.value === '重新登记此服务器的登录设备'), 'Device registration retains an accessible native checkbox');
      await click('register');
      assert.equal((await snapshot()).clientVisible, false, 'Default registration always uses the fixed client name');
      if (width === 420 && scale === 1 && mode === 'standard' && process.env.MJC_TEST_ARTIFACT_DIR) {
        const capture = await send('Page.captureScreenshot', {format: 'png'});
        fs.mkdirSync(process.env.MJC_TEST_ARTIFACT_DIR, {recursive: true});
        fs.writeFileSync(path.join(process.env.MJC_TEST_ARTIFACT_DIR, 'senplayer-dialog-narrow.png'), Buffer.from(capture.data, 'base64'));
      }
      await fill('password', 'edit-password'); await click('submit');
      state = await snapshot();
      assert.equal(state.calls[0].kind, 'update');
      assert.equal(state.calls[0].args[0], 'fixture-server');
      assert.equal(state.calls[0].args[1].connectionMode, undefined);
      assert.deepEqual(state.calls[0].args[1].registerNewDevice, {clientName: 'SenPlayer'});
      assert.equal(state.calls[0].args[1].password, 'edit-password');
      assert(state.register.disabled);
      assert(state.fits && !state.horizontalOverflow, `Dialog fits ${width}×${height} at ${scale} scale`);
      if (height <= 600) assert(state.scrollMax > 0 && state.scrollTop > 0, 'Short dialog scrolls to reach the native submit button');
      await fixture('resolve()');
    }
    await fixture('open(true,false)');
    assert.equal((await snapshot()).compat, null);
    assert.doesNotMatch((await snapshot()).status, /SenPlayer/, 'Independent connectors retain their own connection contract');
    await click('register');
    assert.equal((await snapshot()).clientVisible, true, 'Other connectors can still support editable registration identities');
    await click('submit');
    assert.deepEqual((await snapshot()).calls[0].args[1].registerNewDevice, {clientName: 'Existing custom name'});
    await fixture('resolve()');
  }
  await fixture('unmount()');
  console.log('PASS: Default SenPlayer dialog, ignored legacy flags, independent connector capability, accessibility, add/update arguments, fixed registration identity, loading and responsive scrolling at 100/125/150%');
  await send('Browser.close');
})().catch(error => {console.error(error); process.exitCode = 1;}).finally(async () => {
  socket?.close(); if (child && child.exitCode === null) {child.kill(); await wait(300);}
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('mjc-senplayer-dialog-'));
  fs.rmSync(resolved, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
});
