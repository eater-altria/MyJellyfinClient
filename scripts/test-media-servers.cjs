/** Integration checks against local HTTP fixtures; no real accounts or servers are used. */
const assert = require('node:assert/strict');
const http = require('node:http');
const esbuild = require('esbuild');
const calls = [];
const deviceRegistrations = new Map();
const headerField = (header, name) => {
  const value = header?.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  return value == null ? undefined : decodeURIComponent(value);
};
const storage = new Map();
global.localStorage = {getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,String(v)), removeItem: k => storage.delete(k)};
global.window = {localStorage: global.localStorage};
const fixtures = {
  '/jf': {protocol:'jellyfin', info:{Id:'jf-server',Version:'12.0.0',ProductName:'Jellyfin Server',ServerName:'Emby is just my chosen name'}},
  '/oldjf': {protocol:'jellyfin', info:{Id:'old-jf',Version:'10.10.7',ServerName:'Library'}},
  '/proxy/emby': {protocol:'emby', info:{Id:'emby-server',Version:'4.9.1.0',ServerName:'Jellyfin is just my chosen name'}},
  '/explicit': {protocol:'emby', info:{Id:'explicit-emby',Version:'5.0.0',ProductName:'Emby Server'}},
  '/branded': {protocol:'emby', info:{Id:'branded-server',Version:'4.9.3.0',ProductName:'Fixture Media Server'}},
  '/branded/emby': {protocol:'emby', info:{Id:'branded-server',Version:'4.9.3.0',ProductName:'Fixture Media Server'}},
  '/manual/emby': {protocol:'emby', info:{Id:'manual-emby',Version:'99.0.0',ProductName:'Jellyfin Server'}},
  '/manual-jf': {protocol:'jellyfin', info:{Id:'manual-jf',Version:'4.0.0',ProductName:'Emby Server'}},
  '/fallback/emby': {protocol:'emby', info:{Id:'fallback',Version:'4.8.0.0'}},
  '/client-jf': {protocol:'jellyfin', client:'SenPlayer', info:{Id:'client-jf',Version:'12.0.0',ProductName:'Jellyfin Server'}},
  '/client-emby': {protocol:'emby', client:'SenPlayer', info:{Id:'client-emby',Version:'4.9.1.0',ProductName:'Emby Server'}},
  '/registration/emby': {protocol:'emby', info:{Id:'registration-emby',Version:'4.9.1.0',ProductName:'Emby Server'}},
};
const movie = {Id:'movie',Name:'Fixture film',Type:'Movie',MediaSources:[{Id:'source',Container:'mkv',SupportsDirectPlay:true,Size:123,MediaStreams:[{Type:'Video',Codec:'hevc',Width:3840,Height:2160}]}]};
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url,'http://fixture');
  let body=''; for await (const chunk of req) body+=chunk;
  calls.push({path:url.pathname,params:url.searchParams,headers:req.headers,body:body ? JSON.parse(body) : undefined,method:req.method});
  const json = (value,status=200) => {res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if (url.pathname === '/redirect/System/Info/Public') {res.writeHead(302,{Location:'/proxy/emby/System/Info/Public'});res.end();return;}
  if (url.pathname === '/unknown/System/Info/Public') return json({Id:'unknown',Version:'99.0.0',ProductName:'Other product'});
  if (url.pathname === '/html/System/Info/Public') {res.writeHead(200,{'Content-Type':'text/html'});res.end('<html>proxy login</html>');return;}
  if (url.pathname === '/slow/System/Info/Public') {const timer=setTimeout(()=>json(fixtures['/jf'].info),300);res.on('close',()=>clearTimeout(timer));return;}
  const prefix = Object.keys(fixtures).sort((a,b)=>b.length-a.length).find(p=>url.pathname.startsWith(p+'/'));
  if (!prefix) return json({},404);
  const fixture=fixtures[prefix], path=url.pathname.slice(prefix.length);
  let token=fixture.protocol+'-token';
  if (prefix==='/registration/emby' && path==='/Videos/movie/stream') {
    const registration=[...deviceRegistrations.values()].find(row=>row.token===url.searchParams.get('api_key'));
    if (registration?.allowed) {res.writeHead(206,{'Content-Type':'video/mp4'});res.end('fixture-media');return;}
    res.writeHead(302,{Location:'/fixture-error-video'});res.end();return;
  }
  if (fixture.client && headerField(req.headers.authorization ?? req.headers['x-emby-authorization'], 'Client') !== fixture.client) {
    return json({message:'fixture client restriction'},403);
  }
  if (path === '/System/Info/Public') return json(fixture.info);
  const authorization=req.headers['x-emby-authorization'];
  if (!authorization?.startsWith('MediaBrowser ')
    || (fixture.protocol==='jellyfin' ? req.headers.authorization!==authorization : req.headers.authorization!==undefined)) {
    return json({message:'wrong SenPlayer protocol headers'},401);
  }
  if (path === '/Users/AuthenticateByName') {
    if (JSON.parse(body).Pw !== 'test-password') return json({message:'invalid login'},401);
    if (prefix==='/registration/emby') {
      const device=headerField(req.headers['x-emby-authorization'],'DeviceId');
      if (!deviceRegistrations.has(device)) deviceRegistrations.set(device,{client:headerField(req.headers['x-emby-authorization'],'Client'),token:'registration-token-'+deviceRegistrations.size,allowed:deviceRegistrations.size>0});
      token=deviceRegistrations.get(device).token;
    }
    return json({AccessToken:token,ServerId:fixture.info.Id,User:{Id:'user',Name:'tester'}});
  }
  if (prefix==='/registration/emby') token=[...deviceRegistrations.values()].find(row=>row.token===req.headers['x-emby-token'])?.token;
  if (req.headers['x-emby-token'] !== token) return json({message:'missing token'},401);
  if (path === '/Users/user/Views') return json({Items:[{Id:'library',Name:'Movies',RecursiveItemCount:3}],TotalRecordCount:1});
  if (path === '/Users/user/Items/movie' || path === '/Users/user/Items/person') return json(movie);
  if (path === '/Users/user/Items/Latest') return json([movie]);
  if (path === '/Items/movie/PlaybackInfo') return json({PlaySessionId:'session',MediaSources:[{...movie.MediaSources[0],TranscodingUrl:'/emby/Videos/movie/master.m3u8?MediaSourceId=source&AudioStreamIndex=2'}]});
  if (path.startsWith('/Sessions/') || path.includes('/FavoriteItems/') || path.includes('/PlayedItems/')) {res.writeHead(204);res.end();return;}
  return json({Items:[movie],TotalRecordCount:1,StartIndex:0});
});

(async () => {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result=await esbuild.build({stdin:{contents:"export * from './src/api/mediaServer'; export * from './src/api/detectServer'; export {useServers} from './src/store/servers'; export * from './src/store/settings';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',packages:'external',write:false});
  const bundle={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(require,bundle,bundle.exports);
  const {MediaServerApi,detectServer,ServerDetectionError,ApiError,useServers,normalizeAddress,useSettings,getClientIdentity,DEFAULT_CLIENT_IDENTITY}=bundle.exports;
  assert.equal(normalizeAddress(origin+'/proxy/web/index.html?x=1#!/home'),origin+'/proxy');
  assert.equal(normalizeAddress('https://example.test/proxy/'), 'https://example.test/proxy');
  const jf=await detectServer(origin+'/jf');assert.equal(jf.protocol,'jellyfin');
  assert.equal((await detectServer(origin+'/oldjf')).protocol,'jellyfin');
  assert.equal((await detectServer(origin+'/explicit')).protocol,'emby');
  const branded=await detectServer(origin+'/branded');
  assert.equal(branded.protocol,'emby','Custom branding must not hide the Emby version family');
  assert.equal(branded.address,origin+'/branded/emby','Branded servers must still validate the preferred API prefix');
  const brandedApi=new MediaServerApi(branded.address,undefined,undefined,branded.protocol);
  const brandedLogin=await brandedApi.authenticate('tester','test-password');
  assert.equal(brandedLogin.token,'emby-token');
  assert.equal(calls.at(-1).headers.authorization,undefined);
  assert(calls.at(-1).headers['x-emby-authorization'].startsWith('MediaBrowser '));
  const emby=await detectServer(origin+'/proxy');assert.equal(emby.protocol,'emby');assert.equal(emby.address,origin+'/proxy/emby');
  assert.equal((await detectServer(origin+'/fallback')).address,origin+'/fallback/emby');
  assert.equal((await detectServer(origin+'/proxy/emby/web/index.html')).address,emby.address);
  assert.equal((await detectServer(origin+'/redirect')).address,emby.address);
  // Public metadata can redirect to an API domain that is not the media route.
  // Exercise the actual detector without sending any requests to real hosts.
  const originalFetch = global.fetch;
  const publicInfo = {Id:'redirected-fixture',Version:'4.9.1.0',ProductName:'Emby Server'};
  const discoveryCalls = [];
  const fakeResponse = (info, finalUrl, status = 200) => {
    const response = new Response(JSON.stringify(info), {status,headers:{'Content-Type':'application/json'}});
    Object.defineProperty(response, 'url', {value:finalUrl}); return response;
  };
  try {
    global.fetch = async (url, options) => {
      discoveryCalls.push({url:String(url),headers:Object.fromEntries(new Headers(options.headers))});
      return fakeResponse(publicInfo, 'https://metadata.fixture.invalid/System/Info/Public');
    };
    const redirected = await detectServer('https://media.fixture.invalid');
    assert.equal(redirected.address, 'https://media.fixture.invalid/emby', 'Emby media origin must survive cross-origin public redirects');
    assert(discoveryCalls.every(call => !call.headers['x-emby-token']
      && !Object.values(call.headers).some(value => /(?:Token|UserId)=/.test(value))), 'Cross-origin public discovery must never send account credentials');
    const samePrefix = new MediaServerApi(redirected.address, 'fixture-token', 'fixture-user', 'emby');
    assert.equal(new URL(samePrefix.directStreamUrl('movie', 'source', 'session', {Id:'source',DirectStreamUrl:'/Videos/movie/original.mkv'})).pathname,
      '/emby/Videos/movie/original.mkv', 'Relative direct streams must retain the validated Emby prefix');
    global.fetch = async url => String(url).includes('/emby/') || String(url).includes('/mediabrowser/')
      ? fakeResponse({}, String(url), 404) : fakeResponse(publicInfo, 'https://metadata.fixture.invalid/System/Info/Public');
    assert.equal((await detectServer('https://media.fixture.invalid')).address, 'https://media.fixture.invalid', 'Root-only Emby endpoints must remain supported');
    global.fetch = async url => String(url).includes('/emby/') || String(url).includes('/mediabrowser/')
      ? fakeResponse({...publicInfo,Id:'different-server'}, String(url)) : fakeResponse(publicInfo, String(url));
    assert.equal((await detectServer('https://media.fixture.invalid')).address, 'https://media.fixture.invalid', 'An alias for a different server must not replace the root server');
    global.fetch = async () => fakeResponse({...publicInfo,Version:'12.0.0',ProductName:'Jellyfin Server'}, 'https://metadata.fixture.invalid/jellyfin/System/Info/Public');
    assert.equal((await detectServer('https://media.fixture.invalid/proxy')).address, 'https://media.fixture.invalid/proxy', 'Jellyfin must retain the chosen cross-origin route too');
    global.fetch = async () => fakeResponse({...publicInfo,Version:'12.0.0',ProductName:'Jellyfin Server'}, 'https://media.fixture.invalid/proxy/System/Info/Public');
    assert.equal((await detectServer('http://media.fixture.invalid/proxy')).address, 'https://media.fixture.invalid/proxy', 'Same-host HTTPS upgrades must remain supported');
  } finally { global.fetch = originalFetch; }
  console.log('PASS: cross-origin metadata redirects preserve media routes, validated Emby prefixes, root-only fallbacks, server identity and secure upgrades');
  await assert.rejects(detectServer(origin+'/unknown'),ServerDetectionError);
  await assert.rejects(detectServer(origin+'/html'),ServerDetectionError);
  await assert.rejects(detectServer(origin+'/slow',{timeoutMs:25}),ServerDetectionError);
  const controller=new AbortController();controller.abort();
  await assert.rejects(detectServer(origin+'/jf',{signal:controller.signal}),{name:'AbortError'});
  assert(calls.filter(c=>c.path.endsWith('/System/Info/Public')).every(c=>!c.body),'Discovery must not send a credential body');
  assert(calls.filter(c=>c.path.endsWith('/System/Info/Public')).every(c=>!c.headers['x-emby-token']
    && !c.headers['x-emby-authorization']?.includes('Token=') && !c.headers['x-emby-authorization']?.includes('UserId=')), 'Discovery metadata must contain no account credentials');
  console.log('PASS: automatic product detection, legacy versions, API prefixes, proxy/web URLs, redirects, invalid responses, timeouts and cancellation');

  for (const detected of [jf,emby]) {
    const unauth=new MediaServerApi(detected.address,undefined,undefined,detected.protocol);
    const auth=await unauth.authenticate('tester','test-password');
    const login=calls.at(-1);
    assert.equal(login.headers.authorization,detected.protocol==='jellyfin'?login.headers['x-emby-authorization']:undefined,'SenPlayer uses dual Jellyfin headers and only the Emby X header');
    assert.deepEqual(login.body,{Username:'tester',Pw:'test-password',Password:'test-password'},'Password login exchanges the credentials directly, without client-side password hashing');
    assert.equal(auth.token,detected.protocol+'-token','Preserve the server-issued AccessToken verbatim');
    await assert.rejects(unauth.authenticate('tester','wrong-password'),ApiError);
    const api=new MediaServerApi(detected.address,auth.token,auth.userId,detected.protocol);
    assert.equal((await api.getUserViews()).Items[0].Id,'library');
    assert.equal((await api.getItem('movie')).MediaSources[0].MediaStreams[0].Codec,'hevc');
    await api.getLatest('library');await api.getResumeItems();await api.getNextUp();await api.queryItems({StartIndex:60});
    await api.getSeasons('series');await api.getEpisodes('series','season');await api.getSimilar('movie');
    await assert.rejects(api.getEpisodes('series','season',controller.signal),{name:'AbortError'},'Episode requests must forward cancellation in both protocols');
    await api.getPersonItems('person');await api.search('fixture');await api.getPlayedItems();
    const playback=await api.getPlaybackInfo('movie','native');assert.equal(playback.PlaySessionId,'session');
    const request=calls.at(-1);assert.equal(request.body.DeviceProfile.Name,'SenPlayer mpv');
    assert(request.body.DeviceProfile.DirectPlayProfiles[0].Container.includes('mkv'));
    if (detected.protocol==='emby') assert.equal(request.params.get('UserId'),'user');
    await api.getPlaybackInfo('movie','web');assert.equal(calls.at(-1).body.DeviceProfile.DirectPlayProfiles[0].VideoCodec,'h264');
    await api.setFavorite('movie',true);await api.setFavorite('movie',false);await api.markPlayed('movie');await api.markUnplayed('movie');
    for (const action of ['reportPlaybackStart','reportPlaybackProgress','reportPlaybackStopped']) await api[action]({ItemId:'movie',PlaySessionId:'session',MediaSourceId:'source',PositionTicks:100});
    const direct=new URL(api.directStreamUrl('movie','source','session'));
    assert.equal(direct.pathname,new URL(detected.address).pathname+'/Videos/movie/stream');
    assert.equal(direct.searchParams.get('PlaySessionId'),'session');assert.equal(direct.searchParams.get('api_key'),auth.token);
    const image=new URL(api.posterUrl({...movie,ImageTags:{Primary:'image-tag'}}));assert.equal(image.searchParams.get('tag'),'image-tag');assert.equal(image.searchParams.get('api_key'),auth.token);
  }
  console.log('PASS: both protocol auth headers, login errors, browsing, details, cast, search, favorites, playback profiles, images and session reporting');

  const api=new MediaServerApi(emby.address,'emby-token','user','emby');
  for (const path of ['/Videos/movie/master.m3u8?AudioStreamIndex=2','/emby/Videos/movie/master.m3u8?AudioStreamIndex=2','/proxy/emby/Videos/movie/master.m3u8?AudioStreamIndex=2','Videos/movie/master.m3u8?AudioStreamIndex=2']) {
    const url=new URL(api.hlsUrl('movie','source','session',{Id:'source',TranscodingUrl:path}));
    assert.equal(url.pathname,'/proxy/emby/Videos/movie/master.m3u8');assert.equal(url.searchParams.get('AudioStreamIndex'),'2');assert.equal(url.searchParams.get('api_key'),'emby-token');
  }
  const direct=api.directStreamUrl('movie','source','session',{Id:'source',DirectStreamUrl:'/emby/Videos/movie/stream.mkv?api_key=existing'});
  assert.equal(new URL(direct).searchParams.get('api_key'),'existing');
  assert.equal(new URL(api.resolveMediaUrl('https://cdn.example.test/movie.mkv')).searchParams.get('api_key'),null,'Never attach server tokens to unrelated hosts');
  const subtitles=api.externalSubtitleUrls('movie',{Id:'source',MediaStreams:[{Type:'Subtitle',Codec:'ass',DeliveryUrl:'/emby/Videos/movie/source/Subtitles/1/Stream.ass?x=1'},{Type:'Subtitle',Codec:'srt',IsExternal:true,Index:2}]});
  assert(subtitles.every(u=>new URL(u).pathname.startsWith('/proxy/emby/Videos/')));assert.equal(new URL(subtitles[0]).searchParams.get('x'),'1');
  console.log('PASS: advertised transcode/direct/subtitle URLs, reverse-proxy prefixes, existing auth parameters and external token isolation');

  const state=useServers.getState();
  const savedJf=await state.addServer(origin+'/jf','tester','test-password','My Jellyfin');
  const savedEmby=await state.addServer(origin+'/proxy','tester','test-password','My Emby');
  for (const connection of [savedJf, savedEmby]) {
    const existing = useServers.getState().getApi(connection.id);
    await useServers.getState().refreshServer(connection.id);
    assert.equal(useServers.getState().getApi(connection.id), existing, 'Refreshing metadata must preserve the API and retained page identity');
  }
  assert.equal(savedEmby.protocol,'emby');assert.equal(savedEmby.address,emby.address);assert.equal(savedEmby.name,'My Emby');
  assert.equal(useServers.getState().getApi(savedJf.id).protocol,'jellyfin');assert.equal(useServers.getState().getApi(savedEmby.id).protocol,'emby');
  const persisted=JSON.parse(storage.get('mjc:servers'));assert.equal(persisted.state.servers[1].protocol,'emby');
  assert.equal(persisted.state.servers[1].token,'emby-token','Persist the login response token for this server');
  const manualEmby=await state.addServer(origin+'/manual','tester','test-password','Manual Emby',undefined,'emby');
  assert.equal(manualEmby.protocol,'emby');assert.equal(manualEmby.address,origin+'/manual/emby');
  const manualJf=await state.addServer(origin+'/manual-jf','tester','test-password','Manual Jellyfin',undefined,'jellyfin');
  assert.equal(manualJf.protocol,'jellyfin');assert.equal(manualJf.token,'jellyfin-token');
  const manualProbe=calls.find(c=>c.path==='/manual/emby/System/Info/Public');
  assert(manualProbe.headers['x-emby-authorization'].startsWith('MediaBrowser '));
  const manualBefore=calls.length;
  await state.updateServer(manualEmby.id,{name:'Manual renamed',address:manualEmby.address,username:'tester',protocol:'emby'});
  assert.equal(calls.length,manualBefore,'Unchanged manually selected protocol preserves login');
  await assert.rejects(state.updateServer(manualEmby.id,{name:'Wrong type',address:manualEmby.address,username:'tester',password:'test-password',protocol:'jellyfin'}),ApiError);
  assert.equal(useServers.getState().servers.find(s=>s.id===manualEmby.id).protocol,'emby','Failed protocol change must preserve connection');
  await state.updateServer(manualJf.id,{name:'Manual changed',address:origin+'/manual',username:'tester',password:'test-password',protocol:'emby'});
  assert.equal(useServers.getState().getApi(manualJf.id).protocol,'emby');
  assert.equal(JSON.parse(storage.get('mjc:servers')).state.servers.find(s=>s.id===manualJf.id).protocol,'emby');
  console.log('PASS: manual types override product/version, select protocol headers, persist, preserve login and roll back failed changes');
  const before=calls.length;await state.updateServer(savedEmby.id,{name:'Renamed',address:savedEmby.address,username:'tester'});assert.equal(calls.length,before,'Rename must preserve login without a new probe');
  await assert.rejects(state.updateServer(savedJf.id,{name:'Bad',address:origin+'/proxy',username:'tester',password:'wrong-password'}),ApiError);
  assert.equal(useServers.getState().servers.find(s=>s.id===savedJf.id).protocol,'jellyfin','Failed login must preserve the previous connection');
  await state.updateServer(savedJf.id,{name:'Changed',address:origin+'/proxy',username:'tester',password:'test-password'});
  assert.equal(useServers.getState().getApi(savedJf.id).protocol,'emby');assert.equal(useServers.getState().servers.find(s=>s.id===savedJf.id).address,emby.address);
  useServers.setState({apis:{}});assert.equal(useServers.getState().getApi(savedEmby.id).protocol,'emby','Saved type must survive API cache rebuild');
  const existingApi = useServers.getState().getApi(savedEmby.id);
  const stableDevice = storage.get('mjc:deviceId');
  useSettings.getState().setClientIdentity('emby', 'name', 'Infuse');
  useSettings.getState().setClientIdentity('emby', 'version', '9.8.7');
  useSettings.getState().setClientIdentity('emby', 'deviceName', '测试电脑 "Desk", DeviceId="changed');
  await existingApi.search('identity');
  let request = calls.at(-1);
  assert.equal(request.headers.authorization, undefined);
  for (const header of [request.headers['x-emby-authorization']]) {
    assert.equal(headerField(header, 'Client'), 'SenPlayer');
    assert.equal(headerField(header, 'Version'), '6.2.2');
    assert.equal(headerField(header, 'Device'), '测试电脑 "Desk", DeviceId="changed');
    assert.equal(headerField(header, 'DeviceId'), stableDevice, 'Changing metadata must preserve the device ID');
  }
  assert.equal(request.headers['x-emby-token'], 'emby-token');
  await existingApi.getPlaybackInfo('movie', 'native');
  assert.equal(calls.at(-1).body.DeviceProfile.Name, 'SenPlayer mpv');
  assert(calls.at(-1).body.DeviceProfile.DirectPlayProfiles[0].Container.includes('mkv'), 'A name preset must preserve actual mpv capabilities');
  useSettings.persist.rehydrate();
  assert.equal(getClientIdentity('emby').name, 'Infuse');
  assert.deepEqual(getClientIdentity('jellyfin'), DEFAULT_CLIENT_IDENTITY, 'Emby edits must not affect Jellyfin');
  useSettings.getState().setClientIdentity('jellyfin', 'name', 'Jellyfin Web');
  const independentJf = new MediaServerApi(jf.address, 'jellyfin-token', 'user', 'jellyfin', () => getClientIdentity('jellyfin'));
  await independentJf.search('scope');
  assert.equal(headerField(calls.at(-1).headers['x-emby-authorization'], 'Client'), 'SenPlayer');
  await existingApi.search('scope');
  assert.equal(headerField(calls.at(-1).headers['x-emby-authorization'], 'Client'), 'SenPlayer', 'Jellyfin edits must not affect an existing Emby API');
  useServers.setState({apis:{}});
  await useServers.getState().getApi(savedEmby.id).getUserViews();
  assert.equal(headerField(calls.at(-1).headers['x-emby-authorization'], 'Client'), 'SenPlayer', 'Rebuilt APIs must retain the identity provider');
  useSettings.getState().reset();
  await existingApi.search('defaults');
  assert.equal(headerField(calls.at(-1).headers['x-emby-authorization'], 'Client'), 'SenPlayer');
  assert.equal(headerField(calls.at(-1).headers['x-emby-authorization'], 'Version'), '6.2.2');
  useSettings.getState().reset();
  assert.equal((await detectServer(origin + '/client-jf')).protocol, 'jellyfin');
  assert.equal((await detectServer(origin + '/client-emby')).protocol, 'emby');
  useSettings.getState().setClientIdentity('jellyfin', 'name', 'Jellyfin Web');
  useSettings.getState().setClientIdentity('emby', 'name', 'Emby Theater');
  for (const [prefix, client] of [['/client-jf', 'SenPlayer'], ['/client-emby', 'SenPlayer']]) {
    const connected = await useServers.getState().addServer(origin + prefix, 'tester', 'test-password', 'Client fixture');
    await useServers.getState().getApi(connected.id).getPlaybackInfo('movie', 'native');
    request = calls.at(-1);
    assert.equal(headerField(request.headers['x-emby-authorization'], 'Client'), client);
    assert.equal(request.body.DeviceProfile.Name, `${client} mpv`);
    const login = calls.findLast(call => call.path === prefix + '/Users/AuthenticateByName');
    assert.equal(headerField(login.headers['x-emby-authorization'], 'Client'), client, 'Login must use SenPlayer even with legacy custom settings');
    assert.equal(storage.get('mjc:deviceId'), stableDevice);
  }
  useSettings.getState().reset();
  for (const protocol of ['jellyfin', 'emby']) useSettings.getState().setClientIdentity(protocol, 'name', 'SenPlayer');
  for (const api of [independentJf, existingApi]) {
    await api.getPlaybackInfo('movie', 'native');
    assert.equal(headerField(calls.at(-1).headers['x-emby-authorization'], 'Client'), 'SenPlayer', 'SenPlayer must apply to both protocols');
    assert.equal(calls.at(-1).body.DeviceProfile.Name, 'SenPlayer mpv');
  }
  useSettings.getState().reset();
  console.log('PASS: fixed API identity with preserved legacy settings, separate encoded device names, stable IDs, cached/rebuilt APIs and actual playback capabilities');

  const registered=await state.addServer(origin+'/registration','tester','test-password','Registration fixture');
  const blockedToken=registered.token;
  const streamStatus=async api => (await fetch(api.directStreamUrl('movie','source','session'),{redirect:'manual'})).status;
  assert.equal(await streamStatus(useServers.getState().getApi(registered.id)),302);
  useSettings.getState().setClientIdentity('emby','name','Supported Fixture Client');
  await state.updateServer(registered.id,{name:'Registration fixture',address:registered.address,username:'tester',password:'test-password'});
  assert.equal(useServers.getState().servers.find(s=>s.id===registered.id).token,blockedToken,'Ordinary reauthentication reuses the registered device token');
  assert.equal(await streamStatus(useServers.getState().getApi(registered.id)),302,'Changing headers alone does not repair the original device registration');
  const otherToken=useServers.getState().servers.find(s=>s.id===savedEmby.id).token;
  await state.updateServer(registered.id,{name:'Registration fixture',address:registered.address,username:'tester',password:'test-password',registerNewDevice:{clientName:' Supported Fixture Client '}});
  const repaired=useServers.getState().servers.find(s=>s.id===registered.id);
  assert.notEqual(repaired.deviceId,stableDevice);assert.notEqual(repaired.token,blockedToken);
  assert.equal(repaired.clientName,registered.clientName,'Device registration must not overwrite legacy client-name data');
  assert.equal(storage.get('mjc:deviceId'),stableDevice,'Do not reset the global device ID');
  assert.equal(useServers.getState().servers.find(s=>s.id===savedEmby.id).token,otherToken,'Do not alter another connection');
  assert.equal(await streamStatus(useServers.getState().getApi(registered.id)),206,'Explicitly replacing the blocked fixture device enables media access');
  assert.equal(new URL(useServers.getState().getApi(registered.id).hlsUrl('movie','source','session')).searchParams.get('DeviceId'),repaired.deviceId);
  useSettings.getState().reset();useServers.setState({apis:{}});
  const rebuilt=useServers.getState().getApi(registered.id);
  assert.equal(rebuilt.clientIdentity().name,'SenPlayer','Legacy connection overrides cannot replace the fixed API identity');
  await rebuilt.getUserViews();assert.equal(headerField(calls.at(-1).headers['x-emby-authorization'],'DeviceId'),repaired.deviceId);
  const savedRegistration=JSON.parse(storage.get('mjc:servers')).state.servers.find(s=>s.id===registered.id);
  assert.equal(savedRegistration.deviceId,repaired.deviceId);assert.equal(savedRegistration.clientName,repaired.clientName);
  await assert.rejects(state.updateServer(registered.id,{name:'Failed repair',address:registered.address,username:'tester',password:'wrong-password',registerNewDevice:{clientName:'Different client'}}),ApiError);
  assert.deepEqual(useServers.getState().servers.find(s=>s.id===registered.id),repaired,'Failed registration preserves the previous connection');
  await state.updateServer(registered.id,{name:'Rename only',address:registered.address,username:'tester'});
  assert.equal(useServers.getState().servers.find(s=>s.id===registered.id).deviceId,repaired.deviceId,'Ordinary edits preserve the registered ID');
  const reachabilityApi=useServers.getState().getApi(registered.id);
  let completed;
  const reached=new Promise(resolve=>{completed=resolve;});
  const probePublicInfo=reachabilityApi.getPublicSystemInfo.bind(reachabilityApi);
  reachabilityApi.getPublicSystemInfo=async signal=>{const info=await probePublicInfo(signal);completed();return info;};
  let effect;
  const hookModule={exports:{}};
  const hookCode=esbuild.transformSync(require('node:fs').readFileSync('src/hooks/useServerReachability.ts','utf8'),{loader:'ts',format:'cjs'}).code;
  const hookStore=Object.assign(selector=>selector(useServers.getState()),{getState:useServers.getState});
  const hookWindow={setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},addEventListener(){},removeEventListener(){}};
  new Function('require','module','exports','window',hookCode)(name=>({react:{useEffect:fn=>{effect=fn;}},'../api/mediaServer':{MediaServerApi},'../store/servers':{useServers:hookStore},'../store/settings':{getClientIdentity}})[name],hookModule,hookModule.exports,hookWindow);
  hookModule.exports.useServerReachability();const stopProbing=effect();
  await reached;stopProbing();
  const connectionProbe=calls.findLast(call=>call.path==='/registration/emby/System/Info/Public');
  assert.equal(headerField(connectionProbe.headers['x-emby-authorization'],'Client'),'SenPlayer');
  assert.equal(headerField(connectionProbe.headers['x-emby-authorization'],'DeviceId'),repaired.deviceId,'Online probing must share the actual connection identity');
  console.log('PASS: online probing uses fixed SenPlayer identity and the persistent connection device ID');
  console.log('PASS: explicit per-server device replacement preserves other connections/global ID and legacy data, survives API rebuild and rolls back failed login');
  useServers.setState({servers:[{id:'legacy',address:jf.address,token:'jellyfin-token',userId:'user',name:'Legacy'}],apis:{}});assert.equal(useServers.getState().getApi('legacy').protocol,'jellyfin');
  console.log('PASS: add/edit, custom names, saved protocol, API cache rebuild, legacy Jellyfin connections and atomic failed reauthentication');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{server.closeAllConnections();server.close()});
