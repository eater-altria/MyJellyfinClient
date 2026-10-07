/** Observe actual browser login requests with the desktop's shared compatibility UA. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const esbuild = require('esbuild');
const identity = require('../src/utils/defaultClientIdentity.json');
const browser = [process.env.MJC_TEST_CHROMIUM, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
assert(browser, 'Set MJC_TEST_CHROMIUM to a trusted Chromium browser');
const userAgent = `${identity.name}/${identity.version} (Windows NT 10.0.12345; x64)`;
const calls = [];
let child;
const server = http.createServer(async (request, response) => {
  if (request.url === '/') {
    response.writeHead(200, {'Content-Type': 'text/html'});
    response.end(page); return;
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
  const result = document.getElementById('result');
  (async () => {
    const address = location.origin + '/emby';
    await new MediaServerApi(address, undefined, undefined, 'emby').authenticate('tester', 'fixture-password');
    await new MediaServerApi(address, undefined, undefined, 'emby', () => ({name: 'Manual Fixture App', version: '9.9.9', deviceName: 'Fixture Desktop'}))
      .authenticate('tester', 'fixture-password');
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
    assert.equal(call.method, 'POST'); assert.deepEqual(call.body, {Username: 'tester', Pw: 'fixture-password'});
    assert.equal(call.headers.authorization, call.headers['x-emby-authorization']);
    assert.equal(call.headers['x-emby-token'], undefined, 'First login must not borrow an existing token');
  }
  assert.equal(field(calls[0].headers.authorization, 'Client'), identity.name);
  assert.equal(field(calls[0].headers.authorization, 'Version'), identity.version);
  assert.equal(field(calls[0].headers.authorization, 'Device'), identity.deviceName);
  assert.equal(field(calls[1].headers.authorization, 'Client'), 'Manual Fixture App');
  assert.equal(field(calls[1].headers.authorization, 'Version'), '9.9.9');
  assert.equal(field(calls[1].headers.authorization, 'Device'), 'Fixture Desktop');
  assert.equal(field(calls[0].headers.authorization, 'DeviceId'), field(calls[1].headers.authorization, 'DeviceId'));
  console.log('PASS: real Chromium login HTTP UA, shared first-login defaults, manual identity overrides and stable device ID');
})().catch(error => {console.error(error); process.exitCode = 1;}).finally(() => {
  child?.kill(); server.closeAllConnections(); server.close();
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert(path.basename(resolved).startsWith('mjc-client-agent-'));
  fs.rmSync(resolved, {recursive: true, force: true});
});
