const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const storage = new Map();
global.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,String(v)), removeItem:k=>storage.delete(k) };
global.HTMLElement = class HTMLElement {};
global.window = { localStorage: global.localStorage };
const output = esbuild.buildSync({ stdin: { contents: "export {bindBrowserPlaybackKeys} from './src/player/browserKeyboard'; export {preferredTrack} from './src/player/trackSelection'; export {useSettings} from './src/store/settings'; export {MediaServerApi,matchesExternalSubtitleRule} from './src/api/mediaServer';", resolveDir: process.cwd(), loader: 'ts' },
  bundle:true,platform:'node',format:'cjs',packages:'external',write:false }).outputFiles[0].text;
const mod={exports:{}};new Function('require','module','exports',output)(require,mod,mod.exports);
const {bindBrowserPlaybackKeys,preferredTrack,useSettings,MediaServerApi,matchesExternalSubtitleRule}=mod.exports;

const handlers=new Map(),timers=new Map();let serial=0;
const target={addEventListener:(k,fn)=>handlers.set(k,fn),removeEventListener:k=>handlers.delete(k),
  setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
const fire=(kind,key,repeat=false)=>handlers.get(kind)({key,repeat,target:null,preventDefault(){}});
const hold=()=>{const timer=[...timers.values()].find(t=>t.ms===350);assert(timer,'hold timer missing');timer.fn();};
const video={currentTime:100,duration:150,volume:1,playbackRate:1.25,muted:false,
  fastSeek(time){this.currentTime=time;this.fastSeekCalls=(this.fastSeekCalls??0)+1;}};
let locked=false,exits=0,plays=0;
const dispose=bindBrowserPlaybackKeys(target,()=>video,()=>useSettings.getState(),{
  togglePlay:()=>plays++,toggleLock:()=>{locked=!locked;},fullscreen(){},exit:()=>exits++,activity(){},locked:()=>locked});
useSettings.setState({rewindSeconds:5,forwardSeconds:30,preciseSeek:true,longPressLeftRate:0.25,longPressRightRate:3,numberKeyRateSwitch:false});
fire('keydown','ArrowLeft');fire('keyup','ArrowLeft');assert.equal(video.currentTime,95);
fire('keydown','ArrowRight');fire('keyup','ArrowRight');assert.equal(video.currentTime,125);
fire('keydown','ArrowRight');fire('keydown','ArrowRight',true);hold();assert.equal(video.playbackRate,3);
fire('keyup','ArrowRight');assert.equal(video.playbackRate,1.25);assert.equal(video.currentTime,125,'long press must not seek on release');
fire('keydown','ArrowLeft');hold();assert.equal(video.playbackRate,0.25);
fire('keydown',' ');assert.equal(video.playbackRate,1.25,'pausing must immediately restore held rate');
assert.equal(plays,1);
fire('keydown','ArrowLeft');hold();
handlers.get('blur')();assert.equal(video.playbackRate,1.25);assert.equal(video.currentTime,125,'losing focus must not seek');
fire('keydown','9');assert.equal(video.playbackRate,1.25,'disabled numeric rate must do nothing');
useSettings.setState({numberKeyRateSwitch:true});fire('keydown','2');assert.equal(video.playbackRate,2);
fire('keydown','0');assert.equal(video.playbackRate,1);
useSettings.setState({preciseSeek:false});fire('keydown','ArrowLeft');fire('keyup','ArrowLeft');assert.equal(video.fastSeekCalls,1);
locked=true;fire('keydown','ArrowRight');fire('keyup','ArrowRight');assert.equal(video.currentTime,120);
fire('keydown','9');assert.equal(video.playbackRate,1);fire('keydown',' ');assert.equal(plays,2,'pause lock must still allow resume');
fire('keydown','Escape');assert.equal(exits,1,'exit must remain usable when locked');
fire('keydown','K');assert.equal(locked,false,'K must unlock controls');
dispose();assert.equal(handlers.size,0);assert.equal(timers.size,0);
console.log('PASS: configured seek, fast/exact seek, held rates and restoration, focus cancellation, numeric rate, lock and exit');

assert(matchesExternalSubtitleRule('C:\\Movie\\Film.mkv','C:\\Movie\\Film.zh.srt','sameFolderSameName'));
assert(!matchesExternalSubtitleRule('C:\\Movie\\Film.mkv','C:\\Movie\\Other.srt','sameFolderSameName'));
assert(matchesExternalSubtitleRule('/movie/Film.mkv','/movie/Other.srt','sameFolder'));
assert(!matchesExternalSubtitleRule('/movie/Film.mkv','/else/Film.srt','sameFolder'));
assert(matchesExternalSubtitleRule(undefined,undefined,'sameFolderSameName'),'server-linked subtitles with undisclosed paths must remain available');
assert(matchesExternalSubtitleRule('Film.mkv','Film.zh.srt','sameFolderSameName'));
assert(!matchesExternalSubtitleRule(undefined,undefined,'none'));
const source={Id:'source',Path:'/movie/Film.mkv',MediaStreams:[
  {Type:'Subtitle',Index:1,Codec:'srt',IsExternal:true,Path:'/movie/Film.zh.srt'},
  {Type:'Subtitle',Index:2,Codec:'srt',IsExternal:true,Path:'/movie/Other.srt'},
  {Type:'Subtitle',Index:3,Codec:'ass',IsExternal:true,Path:'/else/Film.ass'},
]};
for(const protocol of ['jellyfin','emby']){
  const api=new MediaServerApi('https://fixture.test/proxy','fixture-token','user',protocol);
  assert.equal(api.externalSubtitleUrls('movie',source,'none').length,0);
  assert.equal(api.externalSubtitleUrls('movie',source,'sameFolderSameName').length,1);
  assert.equal(api.externalSubtitleUrls('movie',source,'sameFolder').length,2);
  const extracted = { ...source, MediaStreams: [...source.MediaStreams, {Type:'Subtitle',Index:4,Codec:'srt',IsExternal:false,DeliveryUrl:'/internal.vtt'}] };
  assert.equal(api.externalSubtitleUrls('movie',extracted,'none').length,1,'sidecar rules must not hide extracted embedded subtitles');
}
console.log('PASS: real external subtitle URL filtering for both protocols, matching names, directories and omitted metadata');

const tracks=[{id:0,lang:'zho',title:'中文'},{id:1,lang:'zho',title:'繁体中文'},{id:2,lang:'zho',title:'简体中文'}];
assert.equal(preferredTrack(tracks,undefined,'简中').id,2,'explicit simplified subtitle must beat generic Chinese');
assert.equal(preferredTrack(tracks,undefined,'繁中').id,1);
assert.equal(preferredTrack(tracks,{id:1},'简中').id,1,'remembered user selection overrides language preference');
assert.equal(preferredTrack(tracks,{id:'no'},'简中'),undefined);
assert.equal(preferredTrack([{id:0,lang:'zh-TW',title:'中文'}],undefined,'繁中').id,0);
assert.equal(preferredTrack([{id:0,lang:'zh-Hant',title:'中文'}],undefined,'简中'),undefined);
assert.equal(preferredTrack([{id:0,lang:'jpn',title:'Japanese'}],undefined,'日文').id,0);
console.log('PASS: simplified/traditional script preference, remembered exact track, explicit subtitle off and audio language');
