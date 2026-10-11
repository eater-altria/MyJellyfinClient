/** Inject only a registry entry, then exercise real discovery/store/settings/UI with a third backend. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const esbuild = require('esbuild');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const storage = new Map();
global.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
global.window = { localStorage: global.localStorage };
global.document = { activeElement: null };
global.HTMLElement = class HTMLElement {};
const registryPath = path.resolve('src/api/connectors/index.ts');
const registrySource = "import { fixtureConnector } from '../../../scripts/fixtures/connector';\n" + fs.readFileSync(registryPath, 'utf8')
  .replace('export const serverConnectors = {', 'export const serverConnectors = {\n  fixture: fixtureConnector,');

// Prove the derived protocol union and every app consumer also compile with the added connector.
const config = ts.readConfigFile('tsconfig.app.json', ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const host = ts.createCompilerHost(parsed.options);
const readFile = host.readFile;
host.readFile = file => path.resolve(file) === registryPath ? registrySource : readFile(file);
const program = ts.createProgram(parsed.fileNames, parsed.options, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: () => process.cwd(), getCanonicalFileName: file => file, getNewLine: () => '\n',
}));

const calls = [];
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const url = new URL(req.url, 'http://fixture');
  const payload = body ? JSON.parse(body) : undefined;
  calls.push({ path: url.pathname, query: url.searchParams, headers: req.headers, body: payload });
  let status = 200, result;
  if (url.pathname === '/about') result = { instance: 'fixture-instance', build: '1.2.3', label: 'Independent backend' };
  else if (url.pathname === '/session') {
    status = payload.secret === 'fixture-password' ? 200 : 401;
    result = { account: 'fixture-user', bearer: 'fixture-token', instance: 'fixture-instance' };
  } else if (!req.headers.authorization?.startsWith('Bearer fixture-token')) { status = 401; result = {}; }
  else if (url.pathname === '/catalog') result = [{ Id: 'library', Name: 'Fixture Library', CollectionType: 'movies' }];
  else if (url.pathname === '/find') result = [{ Id: 'movie', Name: url.searchParams.get('q'), Type: 'Movie' }];
  else { status = 404; result = {}; }
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
});

(async () => {
  const built = await esbuild.build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    export * from './src/api/mediaServer'; export * from './src/api/detectServer';
    export * from './src/store/servers'; export * from './src/store/settings';
    export {default as AddServerDialog} from './src/components/AddServerDialog';
    export {default as SettingsPage} from './src/pages/Settings';
    export {default as ServerIcon} from './src/components/ServerIcon';
  ` }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, jsx: 'automatic',
    plugins: [{ name: 'register-fixture', setup(build) {
      build.onLoad({ filter: /[\\/]api[\\/]connectors[\\/]index\.ts$/ }, () => ({ contents: registrySource, loader: 'ts' }));
      build.onLoad({ filter: /useBrowseActivity\.ts$/ }, () => ({ contents: 'export const useBrowseActivity = () => true;', loader: 'ts' }));
    } }] });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports);
  const app = module.exports;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  assert.equal(app.getServerConnector('fixture').name, 'Fixture Backend');
  assert.equal(app.getServerConnector('jellyfin').requiresNativePlaybackInfo, false);
  assert.equal(app.getServerConnector('emby').requiresNativePlaybackInfo, true);
  assert.equal(app.createServerApi({ address, protocol: 'jellyfin' }).constructor.name, 'JellyfinConnectorApi');
  assert.equal(app.createServerApi({ address, protocol: 'emby' }).constructor.name, 'EmbyConnectorApi');
  assert.throws(() => app.createServerApi({ address, protocol: 'unregistered' }), /不支持/);
  app.useSettings.getState().setClientIdentity('fixture', 'name', 'Fixture Client');
  app.useSettings.persist.rehydrate();
  assert.equal(app.getClientIdentity('fixture').name, 'Fixture Client');
  const dialog = renderToStaticMarkup(React.createElement(app.AddServerDialog, { onClose() {} }));
  assert.match(dialog, /value="fixture"/);
  assert.match(dialog, /Fixture Backend/);
  const settings = renderToStaticMarkup(React.createElement(app.SettingsPage));
  assert.match(settings, /Fixture Backend 客户端标识/);
  assert.match(settings, /Fixture Client/);
  const icon = renderToStaticMarkup(React.createElement(app.ServerIcon, { protocol: 'fixture', size: 20 }));
  assert.match(icon, /<svg/);
  const saved = await app.useServers.getState().addServer(address, 'tester', 'fixture-password', undefined, undefined, 'fixture');
  assert.equal(saved.protocol, 'fixture'); assert.equal(saved.token, 'fixture-token'); assert.equal(saved.libraryCount, 1);
  assert.deepEqual(calls.map(call => call.path), ['/about', '/session', '/catalog'], 'Manual selection invokes only the new connector');
  assert.deepEqual(calls[1].body, { login: 'tester', secret: 'fixture-password' });
  assert.equal(calls[0].headers.authorization, undefined, 'Discovery must carry no credentials');
  assert(calls.every(call => !call.headers['x-emby-authorization']));
  const api = app.useServers.getState().getApi(saved.id);
  assert.equal(api.protocol, 'fixture');
  await app.useServers.getState().refreshServer(saved.id);
  assert.equal(app.useServers.getState().getApi(saved.id), api);
  app.useServers.setState({ apis: {} });
  const rebuilt = app.useServers.getState().getApi(saved.id);
  assert.equal(rebuilt.protocol, 'fixture'); assert.equal((await rebuilt.search('Adapter search')).Items[0].Name, 'Adapter search');
  app.useSettings.getState().setClientIdentity('fixture', 'name', 'Changed Fixture Client');
  await rebuilt.search('Live identity');
  assert.equal(calls.at(-1).headers['x-fixture-client'], 'Changed Fixture Client');
  await assert.rejects(app.useServers.getState().updateServer(saved.id, { name: 'Failed change', address, username: 'tester', password: 'wrong', protocol: 'fixture' }), app.ApiError);
  assert.equal(app.useServers.getState().servers.find(item => item.id === saved.id).token, saved.token);
  assert.equal((await app.detectServer(address)).protocol, 'fixture', 'Automatic discovery tries independent discovery handlers');
  const beforeRegistration = calls.length;
  await assert.rejects(app.useServers.getState().updateServer(saved.id, { name: saved.name, address, username: 'tester',
    protocol: 'fixture', registerNewDevice: { clientName: 'Fixture Client' } }), app.ServerRegistrationError);
  assert.equal(calls.length, beforeRegistration, 'Unsupported device registration fails before sending a request');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(app.detectServer(address, { protocol: 'fixture', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(JSON.parse(storage.get('mjc:servers')).state.servers[0].protocol, 'fixture');
  console.log('PASS: third independent connector compiles by registration alone; automatic/manual discovery, own auth/API, persistence/cache, live identity, rollback, cancellation, type/settings UI and generic icon');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { server.closeAllConnections(); server.close(); });
