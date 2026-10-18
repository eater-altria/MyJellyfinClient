/** Two isolated stores, encrypted WebDAV and authenticated playback negotiation. Synthetic accounts only. */
const assert = require('node:assert/strict');
const http = require('node:http');
const esbuild = require('esbuild');

const storage = new Map();
global.localStorage = {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key)};
global.window = {localStorage};

async function load(desktop = false) {
  global.window = {localStorage, ...(desktop ? {__TAURI_INTERNALS__: {}} : {})};
  const bundle = await esbuild.build({stdin: {resolveDir: process.cwd(), contents: `
    export * from './src/sync/serverSync';
    export * from './src/platform/webdav';
    export {useServers} from './src/store/servers';
  `}, bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [{name: 'fixture-ipc', setup(build) {
    build.onResolve({filter: /^@tauri-apps\/api\/core$/}, () => ({path: 'core', namespace: 'fixture'}));
    build.onLoad({filter: /.*/, namespace: 'fixture'}, () => ({contents: 'export class Channel {} export const invoke = (...args) => globalThis.fixtureInvoke(...args);'}));
  }}]});
  const mod = {exports: {}};
  new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const calls = [];
let cloud = null, etag = '"one"', statusOverride = null, authorizationOnly = false;
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  calls.push({url: req.url, method: req.method, headers: req.headers, body});
  const json = value => {res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));};
  if (req.url.startsWith('/dav/')) {
    assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('fixture用户:fixture-dav-password').toString('base64'));
    assert(!req.headers.cookie && !req.headers['x-emby-token'] && !req.headers['x-emby-authorization']);
    if (statusOverride) {res.writeHead(statusOverride); res.end('secret server error must not appear in UI'); return;}
    if (req.method === 'GET') {
      res.writeHead(cloud === null ? 404 : 200, cloud === null ? {} : {ETag: etag}); res.end(cloud ?? ''); return;
    }
    if ((req.headers['if-none-match'] === '*' && cloud !== null) || (req.headers['if-match'] && req.headers['if-match'] !== etag)) {
      res.writeHead(412); res.end(); return;
    }
    assert(req.headers['if-none-match'] === '*' || req.headers['if-match']);
    cloud = body; etag = '"next"'; res.writeHead(201); res.end(); return;
  }
  const protocol = req.url.startsWith('/proxy/emby') ? 'emby' : 'jellyfin';
  const auth = authorizationOnly ? req.headers.authorization : req.headers['x-emby-authorization'];
  assert(auth?.includes(`Token="token-${protocol}"`));
  assert(auth.includes(`DeviceId="device-${protocol}"`));
  assert.equal(req.headers.authorization, authorizationOnly || protocol === 'jellyfin' ? auth : undefined);
  if (authorizationOnly) assert(!req.headers['x-emby-authorization'] && !req.headers['x-emby-token']);
  if (req.url.includes('/PlaybackInfo')) {
    assert.equal(req.method, 'POST'); json({MediaSources: [{Id: 'source', SupportsDirectPlay: true, MediaStreams: []}], PlaySessionId: 'session'});
  } else if (req.url.includes('/Views')) json({Items: [{Id: 'library'}], TotalRecordCount: 1});
  else if (req.url === '/Sessions/Playing') {res.writeHead(204); res.end();}
  else {res.writeHead(404); res.end();}
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const first = await load();
  const servers = ['emby', 'jellyfin'].map(protocol => ({id: protocol, protocol, name: `Fixture ${protocol}`, address: origin + (protocol === 'emby' ? '/proxy/emby' : '/proxy/jellyfin'),
    userId: 'fixture-user', userName: 'Fixture user', token: `token-${protocol}`, deviceId: protocol === 'emby' ? 'device-emby' : undefined,
    clientName: 'retained client name', lastError: 'private error must not sync', lastConnected: 'private timestamp', libraryCount: 300}));
  first.useServers.setState({servers, apis: {}, activeServerId: 'emby'});
  const snapshot = first.createServerSnapshot(servers, 'device-jellyfin');
  assert.equal(first.createServerSnapshot([{...servers[1], protocol: undefined}], 'device-jellyfin').servers[0].protocol, 'jellyfin');
  assert.equal(snapshot.servers[1].deviceId, 'device-jellyfin');
  assert.equal(servers[1].deviceId, undefined, 'Export must not migrate the source connection');
  assert(!JSON.stringify(snapshot).includes('private'));
  const phrase = 'fixture encryption 中文 password';
  const encrypted = await first.encryptServerSnapshot(snapshot, phrase);
  const encryptedAgain = await first.encryptServerSnapshot(snapshot, phrase);
  assert.notEqual(encrypted, encryptedAgain, 'Every encryption uses fresh salt and nonce');
  assert(!encrypted.includes('token-emby') && !encrypted.includes('Fixture user') && !encrypted.includes('/proxy/'));
  assert.deepEqual(await first.decryptServerSnapshot(encrypted, phrase), snapshot);
  await assert.rejects(first.decryptServerSnapshot(encrypted, 'wrong-passphrase'), /口令不正确/);
  const tampered = JSON.parse(encrypted); tampered.ciphertext = (tampered.ciphertext[0] === 'A' ? 'B' : 'A') + tampered.ciphertext.slice(1);
  await assert.rejects(first.decryptServerSnapshot(JSON.stringify(tampered), phrase), /损坏/);
  for (const patch of [{iterations: 2147483647}, {version: 2}, {algorithm: 'plaintext'}, {salt: 'invalid'}, {iv: ''}]) {
    await assert.rejects(first.decryptServerSnapshot(JSON.stringify({...JSON.parse(encrypted), ...patch}), phrase));
  }
  await assert.rejects(first.encryptServerSnapshot(snapshot, 'short'), /10/);
  for (const patch of [{protocol: 'unsupported'}, {token: ''}, {deviceId: 'bad/device'}, {address: 'javascript:alert(1)'}, {address: 'https://user:pass@fixture.invalid'}, {authorizationOnly: 'yes'}]) {
    assert.throws(() => first.validateSyncedServers([{...snapshot.servers[0], ...patch}]));
  }
  assert.throws(() => first.validateSyncedServers([snapshot.servers[0], snapshot.servers[0]]), /重复/);
  assert.throws(() => first.webDavFileUrl('http://fixture.invalid/dav'), /HTTPS/);
  assert.throws(() => first.webDavFileUrl('https://user:pass@fixture.invalid/dav'), /HTTPS/);
  assert.throws(() => first.webDavFileUrl('https://fixture.invalid/dav?secret=x'), /HTTPS/);
  assert.equal(first.webDavFileUrl('https://fixture.invalid/proxy/dav/中文'), 'https://fixture.invalid/proxy/dav/%E4%B8%AD%E6%96%87/' + first.WEBDAV_FILE);
  const addresses = require('./fixtures/webdav-addresses.json');
  for (const address of addresses.allowed) assert.equal(new URL(first.webDavFileUrl(address)).origin, new URL(address).origin);
  for (const address of addresses.denied) assert.throws(() => first.webDavFileUrl(address), /HTTPS/, address);
  for (const invalid of [undefined, 'W/"weak"', '*', 'unquoted']) assert.throws(() => first.requireStrongEtag(invalid), /ETag/);

  const credentials = {directory: origin + '/dav', username: 'fixture用户', password: 'fixture-dav-password'};
  const signal = () => new AbortController().signal;
  assert.equal((await first.webDavRequest(credentials, signal())).status, 404);
  await first.webDavRequest(credentials, signal(), {body: encrypted, etag: null});
  assert.equal(cloud, encrypted);
  const downloaded = await first.webDavRequest(credentials, signal());
  await assert.rejects(first.webDavRequest(credentials, signal(), {body: encryptedAgain, etag: '"stale"'}), /改变/);
  assert.equal(cloud, encrypted);
  await assert.rejects(first.webDavRequest(credentials, signal(), {body: encryptedAgain, etag: null}), /改变/);
  for (const [status, message] of [[401, /账号/], [403, /权限/], [409, /目录/], [423, /锁定/], [507, /空间/], [500, /500/]]) {
    statusOverride = status; const before = calls.length;
    await assert.rejects(first.webDavRequest(credentials, signal()), message);
    assert.equal(calls.length, before + 1, 'Failures must never replay a request');
  }
  statusOverride = null;

  // A clean installation has its own global device ID and no token or password. Restore the exact source session.
  storage.clear(); storage.set('mjc:deviceId', 'receiving-device-must-survive');
  const second = await load();
  const imported = await second.decryptServerSnapshot(downloaded.body, phrase);
  second.useServers.getState().importServers(imported.servers, second.useServers.getState().servers);
  assert.equal(storage.get('mjc:deviceId'), 'receiving-device-must-survive');
  assert.equal(second.useServers.getState().activeServerId, 'emby');
  for (const row of second.useServers.getState().servers) {
    const api = second.useServers.getState().getApi(row.id);
    assert.equal((await api.getUserViews()).Items[0].Id, 'library');
    assert.equal((await api.getPlaybackInfo('movie', 'native')).PlaySessionId, 'session');
    const stream = new URL(api.directStreamUrl('movie', 'source', 'session'));
    assert.equal(stream.searchParams.get('api_key'), `token-${row.protocol}`);
    assert.equal(stream.searchParams.get('DeviceId'), `device-${row.protocol}`);
    assert(stream.pathname.startsWith(row.protocol === 'emby' ? '/proxy/emby/' : '/proxy/jellyfin/'));
  }
  assert(!calls.some(call => call.url.includes('/AuthenticateByName')), 'Receiving device must not log in');
  const savedCopy = storage.get('mjc:servers');
  const restarted = await load();
  assert.equal(storage.get('mjc:servers'), savedCopy);
  await restarted.useServers.getState().getApi('emby').getUserViews();
  authorizationOnly = true;
  restarted.useServers.getState().importServers([{...snapshot.servers[0], authorizationOnly: true}], restarted.useServers.getState().servers);
  await restarted.useServers.getState().getApi('emby').getUserViews();
  authorizationOnly = false;

  const current = second.useServers.getState().servers;
  second.useServers.setState({servers: [...current]});
  assert.throws(() => second.useServers.getState().importServers(imported.servers, current), /已改变/);
  const before = second.useServers.getState();
  assert.throws(() => second.useServers.getState().importServers([{...imported.servers[0], token: ''}], before.servers));
  assert.equal(second.useServers.getState(), before, 'Invalid imports must not partially mutate the store');
  const otherAccount = {...snapshot.servers[0], id: 'other-account', userId: 'other-user'};
  assert.equal(second.planServerImport([otherAccount], imported.servers).retained, 1, 'Different accounts must remain separate');
  const localOnly = {...snapshot.servers[0], id: 'local-only', address: origin + '/local'};
  const independent = {...snapshot.servers[1], id: 'local-jellyfin', token: 'old-local-token'};
  const plan = second.planServerImport([localOnly, independent], imported.servers);
  assert.equal(plan.added, 1); assert.equal(plan.updated, 1); assert.equal(plan.retained, 1);
  assert.deepEqual(plan.servers.map(row => row.id), ['emby', 'local-jellyfin', 'local-only']);
  const migratedApi = second.useServers.getState().getApi('emby');
  second.useServers.getState().importServers([{...imported.servers[0], token: 'updated-token'}], second.useServers.getState().servers);
  assert.notEqual(second.useServers.getState().getApi('emby'), migratedApi, 'Changed sessions replace old API identities');

  const realFetch = global.fetch;
  try {
    global.fetch = async () => new Response(new Uint8Array(first.SYNC_MAX_BYTES + 1));
    await assert.rejects(first.webDavRequest(credentials, signal()), /过大/);
    global.fetch = async () => new Response(new Uint8Array([0xff]));
    await assert.rejects(first.webDavRequest(credentials, signal()), /UTF-8/);
    global.fetch = async () => {throw new TypeError('private URL and credentials must never surface');};
    await assert.rejects(first.webDavRequest(credentials, signal()), /无法连接 WebDAV/);
    const timer = global.setTimeout, clearTimer = global.clearTimeout;
    let expire;
    try {
      global.setTimeout = callback => {expire = callback; return 1;}; global.clearTimeout = () => {};
      global.fetch = (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true}));
      const timeout = first.webDavRequest(credentials, signal());
      const rejected = assert.rejects(timeout, /超时/); expire(); await rejected;
    } finally {global.setTimeout = timer; global.clearTimeout = clearTimer;}
  } finally {global.fetch = realFetch;}

  // Desktop bridge: cancel even when IPC acknowledgement arrives after abort; ignore late responses.
  const native = await load(true); const ipc = []; let acknowledge, channel;
  global.fixtureInvoke = (command, args) => {
    ipc.push({command, args});
    if (command === 'cancel_webdav_request') return Promise.resolve();
    channel = args.onResponse;
    return new Promise(resolve => {acknowledge = resolve;});
  };
  const controller = new AbortController();
  const pending = native.webDavRequest(credentials, controller.signal);
  const rejected = assert.rejects(pending, {name: 'AbortError'});
  controller.abort(); await rejected; acknowledge(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ipc.at(-1).command, 'cancel_webdav_request');
  channel.onmessage({Ok: {status: 200, body: encrypted, etag: '"late"'}});
  const count = ipc.length;
  await assert.rejects(native.webDavRequest(credentials, controller.signal), {name: 'AbortError'});
  assert.equal(ipc.length, count);
  global.fixtureInvoke = async (command, args) => {
    assert.equal(command, 'start_webdav_request');
    assert.deepEqual(Object.keys(args.request).sort(), ['authorization', 'body', 'etag', 'url']);
    assert.equal(args.request.etag, '"next"'); assert.equal(args.request.body, encrypted);
    args.onResponse.onmessage({Ok: {status: 204, body: '', etag: null}});
  };
  await native.webDavRequest(credentials, signal(), {body: encrypted, etag: '"next"'});
  console.log('PASS: encrypted two-device restore/restart, exact tokens/device IDs, Jellyfin+Emby library and playback negotiation without login, proxy paths, atomic merges, ETag conflicts, errors and IPC cancellation');
})().catch(error => {console.error(error); process.exitCode = 1;}).finally(() => {server.closeAllConnections(); server.close();});
