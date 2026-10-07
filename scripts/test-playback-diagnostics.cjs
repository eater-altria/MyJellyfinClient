const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');
const calls = [];
const code = esbuild.transformSync(fs.readFileSync('src/player/playbackDiagnostics.ts', 'utf8'), {loader:'ts',format:'cjs'}).code;
const moduleValue = {exports:{}};
new Function('require','module','exports',code)(name => name === '@tauri-apps/api/core'
  ? {invoke:(name,args)=>{calls.push({name,args});return Promise.resolve();}}
  : {isTauri:true}, moduleValue, moduleValue.exports);
const {sanitizePlaybackDetails,playbackErrorDetails,describePlaybackUrl,describePlaybackRoute,createPlaybackDiagnostics} = moduleValue.exports;
const secret='fixture-access-token';
const input={Authorization:'Bearer hidden',nested:[{password:'hidden',AccessToken:secret}],
  message:`HTTP 522 token=hidden https://user:password@fixture.invalid/stream?api_key=${secret}; echo ${secret}`};
const safe=JSON.stringify(sanitizePlaybackDetails(input,[secret]));
for(const value of ['fixture.invalid',secret,'hidden','user:password'])assert(!safe.includes(value),safe);
assert(safe.includes('522')&&safe.includes('redacted'));
const error=Object.assign(new Error('API error'),{status:403,body:`Client denied ${secret} https://fixture.invalid/path?api_key=${secret}`});
assert.equal(playbackErrorDetails(error,[secret]).httpStatus,403);
assert(!playbackErrorDetails(error,[secret]).message.includes(secret));
assert.deepEqual(describePlaybackUrl('https://fixture.invalid/proxy/Videos/id/master.m3u8?api_key=private','https://fixture.invalid/proxy'),
  {scheme:'https:',sameServerOrigin:true,kind:'hls',queryParameterCount:1});
assert(!JSON.stringify(describePlaybackUrl('https://cdn.invalid/path?token=private','https://fixture.invalid')).includes('private'));
const first=createPlaybackDiagnostics([secret]),second=createPlaybackDiagnostics();
assert.notEqual(first.id,second.id);
first.record('playback.failed',input);
assert.equal(calls[0].name,'record_playback_diagnostic');
assert.equal(calls[0].args.traceId,first.id);
assert(!JSON.stringify(calls).includes(secret));
console.log('PASS: structured diagnostic redaction, full-body HTTP errors, URL summaries, separate attempt IDs and safe IPC payloads');
describePlaybackRoute('https://fixture.invalid/emby/Videos/private-id/original.mkv?api_key=private-token&MediaSourceId=private-source','https://fixture.invalid/emby').then(route=>{
  assert.equal(route.embyPrefix,true);
  assert.equal(route.endpoint,'original.mkv');
  assert.equal(route.prefixSegments,1);
  assert.equal(route.originFingerprint,require('node:crypto').createHash('sha256').update('https://fixture.invalid').digest('hex'));
  assert.equal(route.serverOriginFingerprint,route.originFingerprint);
  const value=JSON.stringify(route);
  for(const secret of ['fixture.invalid','private-id','private-token','private-source'])assert(!value.includes(secret));
  console.log('PASS: private route fingerprints, Emby prefix and media endpoint classification');
}).catch(error=>{console.error(error);process.exitCode=1});
