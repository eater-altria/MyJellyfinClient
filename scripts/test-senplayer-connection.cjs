/** SenPlayer 6.2.2 connection contract, using synthetic accounts and local HTTP only. */
const assert = require('node:assert/strict');
const http = require('node:http');
const esbuild = require('esbuild');

const storage = new Map();
global.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key),
};
const calls = [];
const fixtures = new Map();
const password = 'fixture password "中文"';
const token = 'fixture-token-with-original-case';
const field = (header, name) => {
  const value = header?.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  return value === undefined ? undefined : decodeURIComponent(value);
};

async function load(desktop = false) {
  global.window = {localStorage, ...(desktop ? {__TAURI_INTERNALS__: {}} : {})};
  const bundle = await esbuild.build({stdin: {resolveDir: process.cwd(), contents: `
    export {useServers} from './src/store/servers';
    export {createServerApi, getServerConnector} from './src/api/mediaServer';
    export {useSettings} from './src/store/settings';
  `}, bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{name: 'fixture-ipc', setup(build) {
    build.onResolve({filter: /^@tauri-apps\/api\/core$/}, () => ({path: 'core', namespace: 'fixture'}));
    build.onLoad({filter: /.*/, namespace: 'fixture'}, () => ({contents:
      'export class Channel {} export const invoke = (...args) => globalThis.senPlayerFixtureInvoke(...args);'}));
  }}]});
  const mod = {exports: {}};
  new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function checkHeaders(headers, protocol, deviceId, authenticated, authorizationOnly = false) {
  const authorization = authorizationOnly ? headers.authorization : headers['x-emby-authorization'];
  assert(authorization?.startsWith('MediaBrowser '));
  assert.equal(headers.authorization, authorizationOnly || protocol === 'jellyfin' ? authorization : undefined);
  assert.equal(headers['x-emby-authorization'], authorizationOnly ? undefined : authorization);
  assert.equal(field(authorization, 'Client'), 'SenPlayer');
  assert.equal(field(authorization, 'Version'), '6.2.2');
  assert.equal(field(authorization, 'Device'), 'Fixture desktop 中文');
  assert.equal(field(authorization, 'DeviceId'), deviceId);
  assert.equal(field(authorization, 'UserId'), authenticated ? 'fixture-user' : undefined);
  assert.equal(field(authorization, 'Token'), authenticated ? token : undefined);
  assert.equal(headers['x-emby-token'], authenticated && !authorizationOnly ? token : undefined);
  assert.equal(headers.accept, '*/*');
  if (authenticated) assert(authorization.startsWith('MediaBrowser UserId="fixture-user", '));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.invalid');
  let text = '';
  for await (const chunk of req) text += chunk;
  calls.push({path: url.pathname, method: req.method, headers: req.headers, body: text ? JSON.parse(text) : undefined});
  const reply = (body, status = 200) => {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(body));
  };
  const prefix = [...fixtures.keys()].sort((a, b) => b.length - a.length).find(path => url.pathname.startsWith(`${path}/`));
  if (!prefix) return reply({}, 404);
  const fixture = fixtures.get(prefix);
  const path = url.pathname.slice(prefix.length);
  if (path === '/Users/AuthenticateByName') {
    if (fixture.redirect) {
      res.writeHead(307, {Location: `${prefix}/redirect-target`});
      res.end();
      return;
    }
    if (calls.at(-1).body.Pw === 'wrong-password') return reply({message: 'fixture login rejected'}, 401);
    return reply(fixture.auth ?? {User: {Id: 'fixture-user', Name: 'tester'}, AccessToken: token, ServerId: 'fixture-server'});
  }
  if (path === '/System/Info/Public') {
    return reply({Id: 'fixture-server', Version: '4.9.0', ServerName: 'Fixture server'}, fixture.blockPublic ? 403 : 200);
  }
  if (path === '/Users/fixture-user/Views') return reply({Items: [{Id: 'library', RecursiveItemCount: 3}], TotalRecordCount: 1});
  return reply({}, 404);
});

(async () => {
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const origin = `http://127.0.0.1:${server.address().port}`;
  const {useServers, useSettings, getServerConnector} = await load();
  for (const protocol of ['emby', 'jellyfin']) {
    useSettings.getState().setClientIdentity(protocol, 'name', 'Unrelated custom name');
    useSettings.getState().setClientIdentity(protocol, 'version', '99.0');
    useSettings.getState().setClientIdentity(protocol, 'deviceName', 'Fixture desktop 中文');
  }
  const savedServers = [];
  for (const protocol of ['emby', 'jellyfin']) {
    const entry = `/proxy-${protocol}`;
    const prefix = entry + (protocol === 'emby' ? '/emby' : '');
    fixtures.set(prefix, {});
    const start = calls.length;
    const saved = await useServers.getState().addServer(origin + entry, 'tester', password, undefined, undefined, protocol);
    savedServers.push(saved);
    assert.equal(saved.address, origin + prefix);
    assert.equal(saved.connectionMode, undefined, 'New connections require no compatibility flag');
    assert.equal(saved.token, token);
    assert.equal(saved.remoteServerId, 'fixture-server');
    assert.equal(saved.libraryCount, 1);
    assert.equal(saved.itemCount, 3);
    const requests = calls.slice(start);
    assert.deepEqual(requests.map(call => [call.method, call.path]), [
      ['POST', prefix + '/Users/AuthenticateByName'], ['GET', prefix + '/System/Info/Public'], ['GET', prefix + '/Users/fixture-user/Views'],
    ], 'Manual protocol selection logs in before any public request by default');
    assert.deepEqual(requests[0].body, {Username: 'tester', Pw: password, Password: password});
    for (const [index, request] of requests.entries()) checkHeaders(request.headers, protocol, storage.get('mjc:deviceId'), index > 0);
    const cached = useServers.getState().getApi(saved.id);
    assert.equal(cached, useServers.getState().getApi(saved.id));
    useServers.setState({apis: {}});
    const rebuilt = useServers.getState().getApi(saved.id);
    assert.notEqual(rebuilt, cached);
    await rebuilt.getUserViews();
    checkHeaders(calls.at(-1).headers, protocol, storage.get('mjc:deviceId'), true);

    fixtures.get(prefix).blockPublic = true;
    const blocked = await useServers.getState().addServer(origin + prefix, 'tester', password, 'Blocked public', undefined, protocol);
    assert.equal(blocked.token, token, 'A blocked public endpoint must not discard successful authentication');
    assert.equal(blocked.address, origin + prefix, 'Already-resolved API prefixes must be idempotent');
    assert.equal(blocked.version, undefined);
    assert.equal(blocked.remoteServerId, 'fixture-server');
  }
  assert.equal(getServerConnector('emby').loginAddress(origin + '/proxy/mediabrowser/'), origin + '/proxy/mediabrowser');
  assert.equal(getServerConnector('emby').loginAddress(origin + '/proxy/emby/web/index.html'), origin + '/proxy/emby');

  const legacyServers = [];
  for (const protocol of ['emby', 'jellyfin']) {
    for (const mode of [undefined, 'standard', 'senplayer']) {
      const prefix = `/legacy-${protocol}-${mode ?? 'absent'}`;
      fixtures.set(prefix, {});
      const saved = {id: prefix, name: 'Legacy root fixture', address: origin + prefix, protocol,
        token, userId: 'fixture-user', userName: 'tester', deviceId: `device-${protocol}-${mode ?? 'absent'}`,
        clientName: 'Retained custom name', ...(mode ? {connectionMode: mode} : {})};
      legacyServers.push(saved);
      useServers.setState(state => ({servers: [...state.servers, saved], apis: {}}));
      const before = calls.length;
      await useServers.getState().getApi(saved.id).getUserViews();
      assert.deepEqual(calls.slice(before).map(call => call.path), [prefix + '/Users/fixture-user/Views'],
        'Existing root routes must never gain an unverified /emby suffix');
      checkHeaders(calls.at(-1).headers, protocol, saved.deviceId, true);
      assert.deepEqual(useServers.getState().servers.find(row => row.id === saved.id), saved,
        'Reading old connections must preserve stored token, ID, address and legacy flags');
      const reauthStart = calls.length;
      await useServers.getState().updateServer(saved.id, {name: saved.name, address: saved.address,
        username: 'tester', protocol, password});
      assert.equal(calls[reauthStart].path, prefix + '/Users/AuthenticateByName',
        'Reauthentication at an unchanged verified root must preserve its route');
      checkHeaders(calls[reauthStart].headers, protocol, saved.deviceId, false);
    }
  }

  const corsConnection = {id: 'legacy-cors', name: 'Legacy CORS fixture', address: origin + '/legacy-cors-root',
    protocol: 'emby', token, userId: 'fixture-user', userName: 'tester', deviceId: 'fixture-cors-device',
    authorizationOnly: true, connectionMode: 'standard'};
  fixtures.set('/legacy-cors-root', {});
  legacyServers.push(corsConnection);
  useServers.setState(state => ({servers: [...state.servers, corsConnection], apis: {}}));
  await useServers.getState().getApi(corsConnection.id).getUserViews();
  checkHeaders(calls.at(-1).headers, 'emby', corsConnection.deviceId, true, true);
  const corsReauthStart = calls.length;
  await useServers.getState().updateServer(corsConnection.id, {name: corsConnection.name, address: corsConnection.address,
    username: 'tester', protocol: 'emby', password});
  assert.equal(calls[corsReauthStart].path, '/legacy-cors-root/Users/AuthenticateByName');
  checkHeaders(calls[corsReauthStart].headers, 'emby', corsConnection.deviceId, false, true);
  assert.equal(useServers.getState().servers.find(row => row.id === corsConnection.id).authorizationOnly, true);

  const beforeFailures = JSON.parse(storage.get('mjc:servers'));
  const badAuth = [
    {User: {Id: 17}, AccessToken: token}, {User: {Id: {}}, AccessToken: token},
    {User: {Id: '   '}, AccessToken: token}, {User: {Id: 'fixture-user'}, AccessToken: true},
    {User: {Id: 'fixture-user'}, AccessToken: {}}, {User: {Id: 'fixture-user'}, AccessToken: ''},
  ];
  for (const [index, auth] of badAuth.entries()) {
    const prefix = `/invalid-${index}/emby`;
    fixtures.set(prefix, {auth});
    const start = calls.length;
    await assert.rejects(useServers.getState().addServer(origin + prefix, 'tester', password, undefined, undefined, 'emby'), /登录响应无效/);
    assert.deepEqual(calls.slice(start).map(call => call.method), ['POST'], 'Malformed login must not trigger retries or metadata queries');
    assert.deepEqual(JSON.parse(storage.get('mjc:servers')), beforeFailures);
  }
  for (const protocol of ['emby', 'jellyfin']) {
    const saved = savedServers.find(row => row.protocol === protocol);
    const start = calls.length;
    await assert.rejects(useServers.getState().addServer(saved.address, 'tester', 'wrong-password', undefined, undefined, protocol), /401/);
    assert.deepEqual(calls.slice(start).map(call => call.method), ['POST']);
    assert.deepEqual(JSON.parse(storage.get('mjc:servers')), beforeFailures);
  }
  fixtures.set('/redirect/emby', {redirect: true});
  const redirectStart = calls.length;
  await assert.rejects(useServers.getState().addServer(origin + '/redirect', 'tester', password, undefined, undefined, 'emby'));
  assert.deepEqual(calls.slice(redirectStart).map(call => call.path), ['/redirect/emby/Users/AuthenticateByName'], 'Never forward login credentials through redirects');

  const edit = {...savedServers[0], id: 'fixture-edit', connectionMode: 'standard', deviceId: 'fixture-per-connection-device', clientName: 'Existing override'};
  useServers.setState(state => ({servers: [...state.servers, edit]}));
  const oldApi = useServers.getState().getApi(edit.id);
  const editOptions = {name: edit.name, address: edit.address, username: 'tester', protocol: 'emby', connectionMode: 'senplayer'};
  await assert.rejects(useServers.getState().updateServer(edit.id, {...editOptions, password: 'wrong-password'}), /401/);
  assert.deepEqual(useServers.getState().servers.find(row => row.id === edit.id), edit);
  assert.equal(useServers.getState().getApi(edit.id), oldApi, 'Failed authentication retains the original API');
  const editStart = calls.length;
  await useServers.getState().updateServer(edit.id, editOptions);
  const edited = useServers.getState().servers.find(row => row.id === edit.id);
  assert.equal(calls.length, editStart, 'Retired mode flags must not trigger login or change credentials');
  const reauthStart = calls.length;
  await useServers.getState().updateServer(edit.id, {...editOptions, password});
  assert.equal(calls[reauthStart].method, 'POST', 'Explicit password changes still authenticate');
  assert.equal(edited.deviceId, edit.deviceId);
  assert.equal(edited.clientName, edit.clientName, 'Compatibility must not erase the saved standard-mode override');
  checkHeaders(calls[reauthStart].headers, 'emby', edit.deviceId, false);
  await useServers.getState().getApi(edit.id).getUserViews();
  checkHeaders(calls.at(-1).headers, 'emby', edit.deviceId, true);

  const globalDeviceBeforeRegistration = storage.get('mjc:deviceId');
  await useServers.getState().updateServer(edit.id, {...editOptions, password,
    registerNewDevice: {clientName: 'SenPlayer'}});
  const registered = useServers.getState().servers.find(row => row.id === edit.id);
  assert.notEqual(registered.deviceId, edit.deviceId);
  assert.equal(registered.clientName, edit.clientName, 'Compatible registration must preserve the saved standard-mode client override');
  assert.equal(storage.get('mjc:deviceId'), globalDeviceBeforeRegistration);
  await useServers.getState().getApi(edit.id).getUserViews();
  checkHeaders(calls.at(-1).headers, 'emby', registered.deviceId, true);

  const rehydrated = await load();
  for (const saved of [...savedServers, registered, ...legacyServers]) {
    const restored = rehydrated.useServers.getState().servers.find(row => row.id === saved.id);
    for (const key of ['address', 'token', 'deviceId', 'clientName', 'connectionMode', 'authorizationOnly']) assert.equal(restored[key], saved[key]);
    await rehydrated.useServers.getState().getApi(saved.id).getUserViews();
    checkHeaders(calls.at(-1).headers, saved.protocol, saved.deviceId ?? storage.get('mjc:deviceId'), true, !!saved.authorizationOnly);
  }
  console.log('PASS: SenPlayer direct login order, protocol headers/body, prefixes, blocked metadata, strict auth, no retries/redirects, edit rollback, device stability and rehydration');

  const nativeCalls = [];
  global.senPlayerFixtureInvoke = async (command, {request, onResponse}) => {
    assert.equal(command, 'start_media_server_request');
    nativeCalls.push(request);
    const body = request.url.endsWith('/Users/AuthenticateByName')
      ? {User: {Id: 'fixture-user', Name: 'tester'}, AccessToken: token}
      : request.url.endsWith('/System/Info/Public') ? {Id: 'fixture-server', Version: '4.9.0'} : {Items: []};
    onResponse.onmessage({Ok: {status: 200, url: request.url, headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}});
  };
  const native = await load(true);
  const originalFetch = global.fetch;
  global.fetch = () => {throw new Error('Desktop connection must not use WebView fetch');};
  try {
    for (const protocol of ['emby', 'jellyfin']) {
      const start = nativeCalls.length;
      await native.useServers.getState().addServer(`https://${protocol}.fixture.invalid/proxy`, 'tester', password, undefined, undefined, protocol);
      const requests = nativeCalls.slice(start);
      assert.equal(requests[0].method, 'POST');
      assert.equal(requests[0].rejectRedirects, true);
      assert.deepEqual(JSON.parse(requests[0].body), {Username: 'tester', Pw: password, Password: password});
      for (const [index, request] of requests.entries()) {
        assert.equal(request.headers['user-agent'], 'SenPlayer/6.2.2');
        assert.equal(request.publicDiscovery, false, 'Post-login metadata is authenticated, not anonymous discovery');
        checkHeaders(request.headers, protocol, storage.get('mjc:deviceId'), index > 0);
      }
    }
  } finally {global.fetch = originalFetch;}
  console.log('PASS: default SenPlayer profile reaches native IPC with exact UA, protocol auth, JSON body and redirect rejection');
})().catch(error => {console.error(error); process.exitCode = 1;}).finally(() => {
  server.closeAllConnections();
  server.close();
});
