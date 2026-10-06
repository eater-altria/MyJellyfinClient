/** Integration checks against local HTTP fixtures; no real accounts or servers are used. */
const assert = require('node:assert/strict');
const http = require('node:http');
const esbuild = require('esbuild');
const calls = [];
const storage = new Map();
global.localStorage = {getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,String(v)), removeItem: k => storage.delete(k)};
global.window = {localStorage: global.localStorage};
const fixtures = {
  '/jf': {protocol:'jellyfin', info:{Id:'jf-server',Version:'12.0.0',ProductName:'Jellyfin Server',ServerName:'Emby is just my chosen name'}},
  '/oldjf': {protocol:'jellyfin', info:{Id:'old-jf',Version:'10.10.7',ServerName:'Library'}},
  '/proxy/emby': {protocol:'emby', info:{Id:'emby-server',Version:'4.9.1.0',ServerName:'Jellyfin is just my chosen name'}},
  '/explicit': {protocol:'emby', info:{Id:'explicit-emby',Version:'5.0.0',ProductName:'Emby Server'}},
  '/fallback/emby': {protocol:'emby', info:{Id:'fallback',Version:'4.8.0.0'}},
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
  const fixture=fixtures[prefix], path=url.pathname.slice(prefix.length), token=fixture.protocol+'-token';
  if (path === '/System/Info/Public') return json(fixture.info);
  const scheme=fixture.protocol==='emby' ? 'Emby ' : 'MediaBrowser ';
  if (!req.headers.authorization?.startsWith(scheme)) return json({message:'wrong protocol header'},401);
  if (path === '/Users/AuthenticateByName') {
    if (JSON.parse(body).Pw !== 'test-password') return json({message:'invalid login'},401);
    return json({AccessToken:token,ServerId:fixture.info.Id,User:{Id:'user',Name:'tester'}});
  }
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
  const result=await esbuild.build({stdin:{contents:"export * from './src/api/mediaServer'; export * from './src/api/detectServer'; export {useServers} from './src/store/servers';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',packages:'external',write:false});
  const bundle={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(require,bundle,bundle.exports);
  const {MediaServerApi,detectServer,ServerDetectionError,ApiError,useServers,normalizeAddress}=bundle.exports;
  assert.equal(normalizeAddress(origin+'/proxy/web/index.html?x=1#!/home'),origin+'/proxy');
  assert.equal(normalizeAddress('https://example.test/proxy/'), 'https://example.test/proxy');
  const jf=await detectServer(origin+'/jf');assert.equal(jf.protocol,'jellyfin');
  assert.equal((await detectServer(origin+'/oldjf')).protocol,'jellyfin');
  assert.equal((await detectServer(origin+'/explicit')).protocol,'emby');
  const emby=await detectServer(origin+'/proxy');assert.equal(emby.protocol,'emby');assert.equal(emby.address,origin+'/proxy/emby');
  assert.equal((await detectServer(origin+'/fallback')).address,origin+'/fallback/emby');
  assert.equal((await detectServer(origin+'/proxy/emby/web/index.html')).address,emby.address);
  assert.equal((await detectServer(origin+'/redirect')).address,emby.address);
  await assert.rejects(detectServer(origin+'/unknown'),ServerDetectionError);
  await assert.rejects(detectServer(origin+'/html'),ServerDetectionError);
  await assert.rejects(detectServer(origin+'/slow',{timeoutMs:25}),ServerDetectionError);
  const controller=new AbortController();controller.abort();
  await assert.rejects(detectServer(origin+'/jf',{signal:controller.signal}),{name:'AbortError'});
  assert(calls.filter(c=>c.path.endsWith('/System/Info/Public')).every(c=>!c.headers.authorization && !c.body),'Discovery must not send credentials');
  console.log('PASS: automatic product detection, legacy versions, API prefixes, proxy/web URLs, redirects, invalid responses, timeouts and cancellation');

  for (const detected of [jf,emby]) {
    const unauth=new MediaServerApi(detected.address,undefined,undefined,detected.protocol);
    const auth=await unauth.authenticate('tester','test-password');
    await assert.rejects(unauth.authenticate('tester','wrong-password'),ApiError);
    const api=new MediaServerApi(detected.address,auth.token,auth.userId,detected.protocol);
    assert.equal((await api.getUserViews()).Items[0].Id,'library');
    assert.equal((await api.getItem('movie')).MediaSources[0].MediaStreams[0].Codec,'hevc');
    await api.getLatest('library');await api.getResumeItems();await api.getNextUp();await api.queryItems({StartIndex:60});
    await api.getSeasons('series');await api.getEpisodes('series','season');await api.getSimilar('movie');
    await api.getPersonItems('person');await api.search('fixture');await api.getPlayedItems();
    const playback=await api.getPlaybackInfo('movie','native');assert.equal(playback.PlaySessionId,'session');
    const request=calls.at(-1);assert.equal(request.body.DeviceProfile.Name,'MyJellyfinClient mpv');
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
  assert.equal(savedEmby.protocol,'emby');assert.equal(savedEmby.address,emby.address);assert.equal(savedEmby.name,'My Emby');
  assert.equal(useServers.getState().getApi(savedJf.id).protocol,'jellyfin');assert.equal(useServers.getState().getApi(savedEmby.id).protocol,'emby');
  const persisted=JSON.parse(storage.get('mjc:servers'));assert.equal(persisted.state.servers[1].protocol,'emby');
  const before=calls.length;await state.updateServer(savedEmby.id,{name:'Renamed',address:savedEmby.address,username:'tester'});assert.equal(calls.length,before,'Rename must preserve login without a new probe');
  await assert.rejects(state.updateServer(savedJf.id,{name:'Bad',address:origin+'/proxy',username:'tester',password:'wrong-password'}),ApiError);
  assert.equal(useServers.getState().servers.find(s=>s.id===savedJf.id).protocol,'jellyfin','Failed login must preserve the previous connection');
  await state.updateServer(savedJf.id,{name:'Changed',address:origin+'/proxy',username:'tester',password:'test-password'});
  assert.equal(useServers.getState().getApi(savedJf.id).protocol,'emby');assert.equal(useServers.getState().servers.find(s=>s.id===savedJf.id).address,emby.address);
  useServers.setState({apis:{}});assert.equal(useServers.getState().getApi(savedEmby.id).protocol,'emby','Saved type must survive API cache rebuild');
  useServers.setState({servers:[{id:'legacy',address:jf.address,token:'jellyfin-token',userId:'user',name:'Legacy'}],apis:{}});assert.equal(useServers.getState().getApi('legacy').protocol,'jellyfin');
  console.log('PASS: add/edit, custom names, saved protocol, API cache rebuild, legacy Jellyfin connections and atomic failed reauthentication');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{server.closeAllConnections();server.close()});
