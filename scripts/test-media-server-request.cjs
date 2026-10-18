/** Desktop IPC contract and browser fallback; synthetic accounts only. */
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const storage = new Map();
global.localStorage = {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key)};
global.window = {localStorage, __TAURI_INTERNALS__: {}};
const calls = [];
let handler;
global.fixtureInvoke = (command, args) => { calls.push({command, args}); return handler(command, args); };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function load(desktop) {
  global.window = {localStorage, ...(desktop ? {__TAURI_INTERNALS__: {}} : {})};
  const bundle = await esbuild.build({stdin: {resolveDir: process.cwd(), contents: `
    export {mediaServerRequest} from './src/platform/mediaServerRequest';
    export {useServers} from './src/store/servers';
  `}, bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [{name: 'fixture-ipc', setup(build) {
    build.onResolve({filter: /^@tauri-apps\/api\/core$/}, () => ({path: 'core', namespace: 'fixture'}));
    build.onLoad({filter: /.*/, namespace: 'fixture'}, () => ({contents: 'export class Channel {} export const invoke = (...args) => globalThis.fixtureInvoke(...args);'}));
  }}]});
  const mod = {exports: {}};
  new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

(async () => {
  const {mediaServerRequest, useServers} = await load(true);
  global.fetch = () => { throw Error('Desktop must not send or replay through WebView fetch'); };
  handler = async (command, args) => {
    assert.equal(command, 'start_media_server_request');
    const {request, onResponse} = args;
    assert(request.headers['x-emby-authorization'].startsWith('MediaBrowser '));
    assert(request.headers['x-emby-authorization'].includes('Client="SenPlayer"'));
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers['user-agent'], 'SenPlayer/6.2.2');
    let body;
    if (request.url.endsWith('/System/Info/Public')) {
      assert(!request.publicDiscovery);
      assert(request.headers['x-emby-authorization'].includes('Token="fixture-token"'));
      body = {Id: 'fixture-server', Version: '4.9.5.0'};
    } else if (request.url.endsWith('/Users/AuthenticateByName')) {
      assert.deepEqual(JSON.parse(request.body), {Username: 'tester', Pw: 'fixture-password', Password: 'fixture-password'});
      assert(!request.publicDiscovery);
      body = {User: {Id: 'fixture-user', Name: 'tester'}, AccessToken: 'fixture-token'};
    } else {
      assert(request.headers['x-emby-authorization'].includes('Token="fixture-token"'));
      body = {Items: [{Id: 'library'}], TotalRecordCount: 1};
    }
    onResponse.onmessage({Ok: {url: request.url, status: 200, headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}});
  };
  const saved = await useServers.getState().addServer('https://fixture.invalid', 'tester', 'fixture-password', undefined, undefined, 'emby');
  assert.equal(saved.address, 'https://fixture.invalid/emby');
  assert.equal(saved.libraryCount, 1);
  assert.equal(calls.filter(call => call.args.request?.method === 'POST').length, 1);
  useServers.setState({apis: {}});
  await useServers.getState().getApi(saved.id).getUserViews();

  let acknowledge, responseChannel;
  handler = (command, args) => {
    if (command === 'cancel_media_server_request') return Promise.resolve();
    responseChannel = args.onResponse;
    return new Promise(resolve => { acknowledge = resolve; });
  };
  const controller = new AbortController();
  const pending = mediaServerRequest('https://fixture.invalid/slow', {signal: controller.signal});
  const rejected = assert.rejects(pending, {name: 'AbortError'});
  controller.abort();
  await rejected;
  const beforeAck = calls.length;
  acknowledge(); await tick();
  assert.equal(calls.length, beforeAck + 1);
  assert.equal(calls.at(-1).command, 'cancel_media_server_request');
  assert.equal(calls.at(-1).args.requestId, calls.at(-2).args.requestId);
  responseChannel.onmessage({Ok: {status: 200, headers: {}, url: 'https://fixture.invalid/slow', body: '{}'}});
  const beforeAborted = calls.length;
  await assert.rejects(mediaServerRequest('https://fixture.invalid', {signal: controller.signal}), {name: 'AbortError'});
  assert.equal(calls.length, beforeAborted);

  for (const status of [200, 204, 401, 500]) {
    handler = async (_, {request, onResponse}) => onResponse.onmessage({Ok: {url: request.url + '/redirect', status, headers: {}, body: status === 204 ? '' : 'fixture-body'}});
    const response = await mediaServerRequest('https://fixture.invalid');
    assert.equal(response.status, status);
    assert.equal(response.url, 'https://fixture.invalid/redirect');
    assert.equal(response.redirected, true);
    assert.equal(await response.text(), status === 204 ? '' : 'fixture-body');
  }
  const beforeFailure = calls.length;
  handler = async (_, {onResponse}) => onResponse.onmessage({Err: '服务器请求超时'});
  await assert.rejects(mediaServerRequest('https://fixture.invalid/login', {method: 'POST', body: '{}'}), /超时/);
  assert.equal(calls.length, beforeFailure + 1, 'Never retry a failed login');

  const browser = await load(false);
  const browserResponse = new Response('{}');
  global.fetch = async (url, options) => { assert.equal(url, 'https://fixture.invalid'); assert(!('publicDiscovery' in options)); return browserResponse; };
  assert.equal(await browser.mediaServerRequest('https://fixture.invalid', {publicDiscovery: true}), browserResponse);
  console.log('PASS: native SenPlayer login/metadata/library/store rebuild, IPC cancellation race, late response isolation, HTTP status and browser fetch fallback');
})().catch(error => { console.error(error); process.exitCode = 1; });
