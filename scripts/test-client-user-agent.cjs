/** Observe actual browser login requests with the desktop's shared compatibility UA. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const esbuild = require('esbuild');
const identity = require('../src/utils/defaultClientIdentity.json');
const browser = [process.env.MJC_TEST_CHROMIUM, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
assert(browser, 'Set MJC_TEST_CHROMIUM to a trusted Chromium browser');
const userAgent = `${identity.name}/${identity.version} (Windows NT 10.0.12345; x64)`;
const calls = [];
const restrictedCalls = [];
const preflights = [];
let child;
const server = http.createServer(async (request, response) => {
  if (request.url === '/') {
    response.writeHead(200, {'Content-Type': 'text/html'});
    response.end(page); return;
  }
  if (request.url.startsWith('/restricted')) {
    const origin = request.headers.origin;
    response.setHeader('Access-Control-Allow-Origin', origin || '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (request.method === 'OPTIONS') {
      preflights.push(request.headers['access-control-request-headers']);
      response.writeHead(204); response.end(); return;
    }
    restrictedCalls.push({path:request.url,headers:request.headers});
    if (request.headers['x-emby-authorization'] || request.headers['x-emby-token']) {
      response.writeHead(400); response.end(); return;
    }
    let body;
    if (request.method === 'POST') {
      let raw='';for await (const chunk of request) raw+=chunk;body=JSON.parse(raw);
    }
    response.writeHead(200, {'Content-Type':'application/json'});
    if (request.url.endsWith('/System/Info/Public')) response.end(JSON.stringify({Id:'restricted',Version:'4.9.3.0',ProductName:'Fixture Media Server'}));
    else if (request.url.endsWith('/Users/AuthenticateByName')) {
      assert.deepEqual(body,{Username:'tester',Pw:'fixture-password',Password:'fixture-password'});
      response.end(JSON.stringify({User:{Id:'fixture-user',Name:'tester'},AccessToken:'restricted-token',ServerId:'restricted'}));
    } else response.end(JSON.stringify({Items:[],TotalRecordCount:0}));
    return;
  }
  if (request.url === '/emby/Users/AuthenticateByName') {
    let body = ''; for await (const chunk of request) body += chunk;
    calls.push({headers: request.headers, method: request.method, body: JSON.parse(body)});
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify({User: {Id: 'fixture-user', Name: 'tester'}, AccessToken: 'fixture-token', ServerId: 'fixture-server'}));
    return;
  }
  response.writeHead(404); response.end();
});
const bundle = esbuild.buildSync({stdin: {resolveDir: process.cwd(), loader: 'ts', contents: `
  import {MediaServerApi} from './src/api/mediaServer';
  import {useServers} from './src/store/servers';
  const result = document.getElementById('result');
  (async () => {
    const address = location.origin + '/emby';
    await new MediaServerApi(address, undefined, undefined, 'emby').authenticate('tester', 'fixture-password');
    await new MediaServerApi(address, undefined, undefined, 'emby', () => ({name: 'Manual Fixture App', version: '9.9.9', deviceName: 'Fixture Desktop'}))
      .authenticate('tester', 'fixture-password');
    const crossOrigin = location.origin.replace('127.0.0.1','localhost') + '/restricted';
    let directFailed=false;
    try {await useServers.getState().addServer(crossOrigin,'tester','fixture-password','Direct fixture',undefined,'emby');}
    catch {directFailed=true;}
    if(!directFailed || useServers.getState().servers.length)throw Error('Direct login must fail without transport retries or persistence when CORS rejects it');
    const saved = await useServers.getState().addServer(crossOrigin,'tester','fixture-password','Restricted fixture');
    if (!saved.authorizationOnly || saved.protocol !== 'emby') throw Error('CORS compatibility must be saved');
    useServers.setState({apis:{}});
    await useServers.getState().getApi(saved.id).getUserViews();
    result.dataset.status = 'pass'; result.textContent = 'completed';
  })().catch(error => { result.dataset.status = 'fail'; result.textContent = error.name; });
`}, bundle: true, write: false, format: 'iife'}).outputFiles[0].text;
const page = `<!doctype html><html><body><pre id="result" data-status="pending"></pre><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mjc-client-agent-'));
const field = (header, key) => decodeURIComponent(header.match(new RegExp(`${key}="([^"]*)"`))[1]);
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const execution = await new Promise((resolve, reject) => {
    child = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      `--user-data-dir=${path.join(directory, 'profile')}`, `--user-agent=${userAgent}`, '--dump-dom', '--virtual-time-budget=3000', url], {windowsHide: true});
    let stdout = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Browser fixture timed out')); }, 30000);
    child.stdout.on('data', buffer => stdout += buffer); child.stderr.resume();
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('exit', code => {clearTimeout(timer); resolve({code, stdout});});
  });
  assert.equal(execution.code, 0);
  assert.match(execution.stdout, /id="result" data-status="pass"/);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.headers['user-agent'], userAgent, 'The HTTP receiver must see the configured engine UA');
    assert.equal(call.method, 'POST'); assert.deepEqual(call.body, {Username: 'tester', Pw: 'fixture-password', Password: 'fixture-password'});
    assert.equal(call.headers.authorization, undefined, 'Emby uses only X-Emby-Authorization');
    assert.equal(call.headers['x-emby-token'], undefined, 'First login must not borrow an existing token');
  }
  assert.equal(field(calls[0].headers['x-emby-authorization'], 'Client'), 'SenPlayer');
  assert.equal(field(calls[0].headers['x-emby-authorization'], 'Version'), '6.2.2');
  assert.equal(field(calls[0].headers['x-emby-authorization'], 'Device'), identity.deviceName);
  assert.equal(field(calls[1].headers['x-emby-authorization'], 'Client'), 'SenPlayer');
  assert.equal(field(calls[1].headers['x-emby-authorization'], 'Version'), '6.2.2');
  assert.equal(field(calls[1].headers['x-emby-authorization'], 'Device'), 'Fixture Desktop');
  assert.equal(field(calls[0].headers['x-emby-authorization'], 'DeviceId'), field(calls[1].headers['x-emby-authorization'], 'DeviceId'));
  assert(preflights.some(headers=>headers?.includes('x-emby-authorization')),'Real CORS must reject the original discovery header');
  const restrictedLogin=restrictedCalls.filter(call=>call.path.endsWith('/Users/AuthenticateByName'));
  assert.equal(restrictedLogin.length,1,'Login must not be replayed');
  assert(restrictedLogin[0].headers.authorization.startsWith('MediaBrowser '));
  assert(restrictedCalls.filter(call=>call.path.endsWith('/System/Info/Public')).every(call=>!call.headers.authorization.includes('Token=')&&!call.headers.authorization.includes('UserId=')),'Public fallback must contain no account credentials');
  assert(restrictedCalls.filter(call=>call.path.endsWith('/Views')).every(call=>call.headers.authorization.includes('Token="restricted-token"')));
  assert(restrictedCalls.every(call=>!call.headers['x-emby-authorization']&&!call.headers['x-emby-token']));
  console.log('PASS: browser-owned HTTP UA, fixed SenPlayer auth despite legacy overrides, editable device name and stable device ID');
  console.log('PASS: manual CORS failure never replays login; legacy discovery fallback, single login, token headers and API rebuild persist');
})().catch(error => {console.error(error); process.exitCode = 1;}).finally(() => {
  child?.kill(); server.closeAllConnections(); server.close();
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert(path.basename(resolved).startsWith('mjc-client-agent-'));
  fs.rmSync(resolved, {recursive: true, force: true});
});
