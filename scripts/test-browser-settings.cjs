const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');
const storage = new Map();
global.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,String(v)), removeItem:k=>storage.delete(k) };
global.HTMLElement = class HTMLElement {};
global.window = { localStorage: global.localStorage };
storage.set('mjc:settings', JSON.stringify({ version: 0, state: {
  autoLockOnPause: true, autoHideControlsSeconds: 10, accentColor: '#30b0c7', jpegQuality: 70,
} }));
const output = esbuild.buildSync({ stdin: { contents: "export {bindBrowserPlaybackKeys} from './src/player/browserKeyboard'; export {preferredTrack} from './src/player/trackSelection'; export * from './src/store/settings'; export {MediaServerApi,matchesExternalSubtitleRule} from './src/api/mediaServer';", resolveDir: process.cwd(), loader: 'ts' },
  bundle:true,platform:'node',format:'cjs',packages:'external',write:false }).outputFiles[0].text;
const mod={exports:{}};new Function('require','module','exports',output)(require,mod,mod.exports);
const {bindBrowserPlaybackKeys,preferredTrack,useSettings,MediaServerApi,matchesExternalSubtitleRule}=mod.exports;
assert.equal(useSettings.getState().autoHideControlsSeconds, 3, 'Existing settings must adopt the requested 3-second interval');
assert.equal(useSettings.getState().accentColor, '#30b0c7', 'Timeout migration must preserve other preferences');
assert.equal(useSettings.getState().jpegQuality, 70);
assert(!Object.hasOwn(useSettings.getState(), 'autoLockOnPause'), 'Retired pause-lock setting must be removed during migration');
useSettings.getState().set('autoHideControlsSeconds', 5);
useSettings.persist.rehydrate();
assert.equal(useSettings.getState().autoHideControlsSeconds, 5, 'Later user changes must not be reset on each launch');
assert.equal(JSON.parse(storage.get('mjc:settings')).version, 2);
assert.equal(useSettings.getState().playerCacheSizeMB, 150, 'Old settings must receive the default cache size');
useSettings.getState().set('playerCacheSizeMB', 512);
useSettings.persist.rehydrate();
assert.equal(useSettings.getState().playerCacheSizeMB, 512, 'Cache size must persist across hydration');
for (const [input, expected] of [[0, 1], [-5, 1], [10000, 8192], [512.6, 513], [NaN, 150], [Infinity, 150]]) {
  useSettings.getState().set('playerCacheSizeMB', input);
  assert.equal(useSettings.getState().playerCacheSizeMB, expected);
}
storage.set('mjc:settings', JSON.stringify({ version: 2, state: { playerCacheSizeMB: 'broken', autoHideControlsSeconds: 5 } }));
useSettings.persist.rehydrate();
assert.equal(useSettings.getState().playerCacheSizeMB, 150, 'Corrupt persisted cache values must fall back safely');
assert.equal(useSettings.getState().autoHideControlsSeconds, 5, 'Cache hydration must retain unrelated settings');
assert.deepEqual(mod.exports.DEFAULT_CLIENT_IDENTITY,{name:'RodelPlayer',version:'2.2610.12.0',deviceName:'Windows PC'});
useSettings.getState().setClientIdentity('jellyfin', 'name', '  Name\r\nTest\ud800  ');
assert.equal(mod.exports.getClientIdentity('jellyfin').name, 'NameTest', 'Controls and invalid UTF-16 must be removed before header encoding');
useSettings.getState().setClientIdentity('emby', 'deviceName', 'd'.repeat(500));
assert.equal(useSettings.getState().clientIdentities.emby.deviceName.length, mod.exports.CLIENT_IDENTITY_MAX_LENGTH);
storage.set('mjc:settings', JSON.stringify({ version: 2, state: { clientName: 7, clientVersion: {}, clientDeviceName: [] } }));
useSettings.persist.rehydrate();
assert.deepEqual(mod.exports.getClientIdentity('jellyfin'), mod.exports.DEFAULT_CLIENT_IDENTITY, 'Corrupt identity overrides must safely use defaults');
assert.deepEqual(mod.exports.getClientIdentity('emby'), mod.exports.DEFAULT_CLIENT_IDENTITY);

// Exercise the real settings tab/input handlers against the persistent store.
let cursor = 0;
const rootHooks = [], effects = [], componentHooks = new Map();
let hooks = rootHooks;
const react = {
  useState(initial) {
    const index = cursor++;
    hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial };
    const hook = hooks[index];
    return [hook.value, value => { hook.value = typeof value === 'function' ? value(hook.value) : value; }];
  },
  useEffect(effect, deps) {
    const index = cursor++;
    if (!hooks[index]?.deps || deps.some((value, i) => !Object.is(value, hooks[index].deps[i]))) {
      hooks[index] = { deps }; effects.push(effect);
    }
  },
};
const platform = { isTauri: true };
const settingsStore = Object.assign(selector => selector(useSettings.getState()), { getState: useSettings.getState });
const settingsModule = { exports: {} };
const settingsCode = esbuild.transformSync(fs.readFileSync('src/pages/Settings.tsx', 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code;
const imports = {
  react, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
  '../store/settings': { ...mod.exports, useSettings: settingsStore },
  '../platform/window': platform, '../components/Toggle': { default: 'Toggle' }, '../components/LiquidGlass': { default: 'Glass' },
  '../components/icons': new Proxy({}, { get: () => 'Icon' }),
};
new Function('require', 'module', 'exports', settingsCode)(name => imports[name] ?? require(name), settingsModule, settingsModule.exports);
const expand = node => {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node.type === 'function') {
    const previousHooks = hooks, previousCursor = cursor;
    const key = node.type.name + ':' + (node.props.protocol ?? '') + ':' + (node.props.field ?? '');
    if (!componentHooks.has(key)) componentHooks.set(key, []);
    hooks = componentHooks.get(key); cursor = 0;
    const tree = expand(node.type(node.props));
    hooks = previousHooks; cursor = previousCursor;
    return tree;
  }
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
};
const find = (node, predicate) => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(value => find(value, predicate))
  : [...(predicate(node) ? [node] : []), ...find(node.props?.children, predicate)];
const renderSettings = () => { cursor = 0; const tree = expand(settingsModule.exports.default()); effects.splice(0).forEach(effect => effect()); return tree; };
let settingsTree = renderSettings();
find(settingsTree, node => node.props?.id === 'settings-tab-play')[0].props.onClick();
settingsTree = renderSettings();
const cacheInput = () => find(renderSettings(), node => node.type === 'input' && node.props['aria-label'] === '缓存大小')[0];
assert.equal(cacheInput().props.value, '150');
assert.equal(cacheInput().props.type, 'number');
assert.equal(cacheInput().props.disabled, false);
cacheInput().props.onChange({ target: { value: '768' } });
assert.equal(useSettings.getState().playerCacheSizeMB, 150, 'Typing must allow a draft before committing');
cacheInput().props.onBlur();
assert.equal(useSettings.getState().playerCacheSizeMB, 768);
useSettings.persist.rehydrate();
assert.equal(useSettings.getState().playerCacheSizeMB, 768);
cacheInput().props.onChange({ target: { value: '1024' } });
cacheInput().props.onKeyDown({ key: 'Enter', preventDefault() {} });
assert.equal(useSettings.getState().playerCacheSizeMB, 1024, 'Enter must save the cache size');
cacheInput().props.onChange({ target: { value: '' } }); cacheInput().props.onBlur();
assert.equal(cacheInput().props.value, '1024', 'Empty input must restore the saved value');
cacheInput().props.onChange({ target: { value: '99999' } }); cacheInput().props.onBlur();
assert.equal(cacheInput().props.value, '8192', 'Out-of-range input must normalize on commit');
platform.isTauri = false;
assert(cacheInput().props.disabled, 'Browser playback must disable the desktop-only setting');
useSettings.getState().reset();
assert.equal(useSettings.getState().playerCacheSizeMB, 150, 'Reset must restore the cache default');
useSettings.getState().set('autoHideControlsSeconds', 5);
console.log('PASS: cache size default, bounds, corruption recovery, persistence, actual settings draft/blur/Enter, reset and browser scope');

find(renderSettings(), node => node.props?.id === 'settings-tab-general')[0].props.onClick();
renderSettings();
for (const [protocol, product] of [['jellyfin', 'Jellyfin'], ['emby', 'Emby']]) {
  const other = protocol === 'jellyfin' ? 'emby' : 'jellyfin';
  const otherIdentity = JSON.stringify(useSettings.getState().clientIdentities[other]);
  const presetInput = () => find(renderSettings(), node => node.type === 'select' && node.props['aria-label'] === product + ' 客户端预设')[0];
  const identityInput = label => find(renderSettings(), node => node.type === 'input' && node.props['aria-label'] === product + ' ' + label)[0];
  assert.equal(presetInput().props.value, 'default');
  const presetNames = find(presetInput(), node => node.type === 'option').map(node => node.props.value);
  for (const preset of mod.exports.CLIENT_NAME_PRESETS[protocol]) {
    assert(presetNames.includes(preset));
    presetInput().props.onChange({ target: { value: preset } });
    assert.equal(useSettings.getState().clientIdentities[protocol].name, preset);
    assert.equal(presetInput().props.value, preset);
  }
  identityInput('客户端版本').props.onChange({ target: { value: '9.8.7' } });
  identityInput('客户端版本').props.onKeyDown({ key: 'Enter', preventDefault() {} });
  identityInput('设备名称').props.onChange({ target: { value: '我的电脑' } });
  identityInput('设备名称').props.onBlur();
  presetInput().props.onChange({ target: { value: 'custom' } });
  identityInput('客户端名称').props.onChange({ target: { value: '  Fixture Player\r\n  ' } });
  identityInput('客户端名称').props.onBlur();
  useSettings.persist.rehydrate();
  assert.deepEqual(useSettings.getState().clientIdentities[protocol], {name:'Fixture Player', version:'9.8.7', deviceName:'我的电脑'});
  assert.equal(presetInput().props.value, 'custom');
  assert.equal(JSON.stringify(useSettings.getState().clientIdentities[other]), otherIdentity, 'Editing one protocol must preserve the other identity');
  presetInput().props.onChange({ target: { value: 'default' } });
  assert.deepEqual(mod.exports.getClientIdentity(protocol), mod.exports.DEFAULT_CLIENT_IDENTITY);
  assert.equal(useSettings.getState().autoHideControlsSeconds, 5, 'Restoring identity defaults must preserve other settings');
  assert.equal(presetInput().props.value, 'default');
}
console.log('PASS: separate Jellyfin/Emby dropdown presets, custom fields, blur/Enter, persistence and isolated defaults');

const handlers=new Map(),timers=new Map();let serial=0;
const target={addEventListener:(k,fn)=>handlers.set(k,fn),removeEventListener:k=>handlers.delete(k),
  setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
const fire=(kind,key,repeat=false)=>handlers.get(kind)({key,repeat,target:null,preventDefault(){}});
const hold=()=>{const timer=[...timers.values()].find(t=>t.ms===350);assert(timer,'hold timer missing');timer.fn();};
const video={currentTime:100,duration:150,volume:1,playbackRate:1.25,muted:false,
  fastSeek(time){this.currentTime=time;this.fastSeekCalls=(this.fastSeekCalls??0)+1;}};
let exits=0,plays=0,activities=0,fullscreens=0;
const dispose=bindBrowserPlaybackKeys(target,()=>video,()=>useSettings.getState(),{
  togglePlay:()=>plays++,fullscreen:()=>fullscreens++,exit:()=>exits++,activity:()=>activities++});
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
video.paused=true;fire('keydown','ArrowRight');fire('keyup','ArrowRight');assert.equal(video.currentTime,150, 'Paused seeking must remain usable');
const beforeSpace=activities;fire('keydown',' ');assert.equal(plays,2);
assert.equal(activities,beforeSpace,'Space must not wake hidden controls');
fire('keydown','Enter');assert.equal(fullscreens,1,'Enter must switch fullscreen while paused');
fire('keydown','Escape');assert.equal(exits,1,'exit must remain usable while paused');
const searchInput = new HTMLElement(); searchInput.tagName = 'INPUT';
handlers.get('keydown')({ key: 'Escape', repeat: false, target: searchInput, preventDefault() {} });
assert.equal(exits, 2, 'Escape must close an overlay even when its search input has focus');
fire('keydown','Escape',true); assert.equal(exits, 2, 'Holding Escape must not close a menu and then exit playback');
const focusedButton = new HTMLElement(); focusedButton.tagName = 'BUTTON';
handlers.get('keydown')({ key: ' ', repeat: false, target: focusedButton, preventDefault() {} });
assert.equal(plays, 2, 'Focused buttons must handle their own keyboard activation without a duplicate global pause');
const beforeK=activities;fire('keydown','K');assert.equal(activities,beforeK,'Retired K lock shortcut must do nothing');
dispose();assert.equal(handlers.size,0);assert.equal(timers.size,0);
console.log('PASS: configured seek, fast/exact seek, held rates and restoration, focus cancellation, numeric rate, paused seeking/fullscreen, hidden Space playback and exit');

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
