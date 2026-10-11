/** Trusted mouse/keyboard input in isolated Chromium against the real Sidebar, Servers and store. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');
const browser = [process.env.MJC_TEST_CHROMIUM, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
assert(browser, 'Set MJC_TEST_CHROMIUM to a trusted Chromium executable');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mjc-server-order-'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, socket;

(async () => {
  const config = (await import(pathToFileURL(path.resolve('tailwind.config.js')).href)).default;
  const css = (await require('postcss')([require('tailwindcss')(config), require('autoprefixer')])
    .process(fs.readFileSync('src/index.css', 'utf8'), { from: path.resolve('src/index.css') })).css;
  const bundle = esbuild.buildSync({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {MemoryRouter,useLocation,useNavigate} from 'react-router-dom';
    import Sidebar from './src/components/Sidebar';
    import Servers from './src/pages/Servers';
    import {BrowseActivity} from './src/hooks/useBrowseActivity';
    import {useServers} from './src/store/servers';
    import {useServerReorder} from './src/store/serverReorder';
    const originals=Array.from({length:32},(_,i)=>({id:'s'+i,name:'测试服务器 '+(i+1),protocol:i%2?'emby':'jellyfin',
      address:'https://server-'+i+'.fixture.invalid',token:'fixture-token-'+i,userId:'fixture-user-'+i,deviceId:'fixture-device-'+i,
      clientName:'Fixture Client '+i,userName:'Fixture',version:'1.0',libraryCount:2}));
    const apis=Object.fromEntries(originals.map(server=>[server.id,{baseUrl:server.address,token:server.token,userId:server.userId,
      protocol:server.protocol,getUserViews:async()=>({Items:[{Id:'library',Name:'Fixture',RecursiveItemCount:2}]})}]));
    let navigate,setShown,route='',mounted=true,shown=true;
    function Shell(){
      const location=useLocation();route=location.pathname;navigate=useNavigate();
      const [visible,setVisible]=useState(true);setShown=setVisible;shown=visible;
      return <div className="app-shell flex h-full flex-col"><div className="app-titlebar h-9 shrink-0"/>
        <div className="app-workspace flex min-h-0 flex-1"><Sidebar/><main className="app-content min-w-0 flex-1 overflow-hidden">
          <BrowseActivity.Provider value={visible&&route==='/servers'}><div style={{height:'100%',display:visible&&route==='/servers'?'block':'none'}}><Servers/></div></BrowseActivity.Provider>
        </main></div></div>;
    }
    const root=createRoot(document.getElementById('root'));
    const state=()=>useServers.getState();
    const render=()=>flushSync(()=>root.render(<React.StrictMode><MemoryRouter initialEntries={['/servers']}><Shell/></MemoryRouter></React.StrictMode>));
    const element=(surface,id)=>document.querySelector('[data-server-reorder-surface="'+surface+'"][data-server-reorder-id="'+id+'"]');
    const snapshot=()=>({
      grid:[...document.querySelectorAll('[data-server-reorder-surface="grid"]')].map(node=>node.dataset.serverReorderId),
      sidebar:[...document.querySelectorAll('[data-server-reorder-surface="sidebar"]')].map(node=>node.dataset.serverReorderId),
      saved:JSON.parse(localStorage.getItem('mjc:servers')).state.servers.map(server=>server.id),
      active:state().activeServerId,route,drag:useServerReorder.getState().drag,owner:useServerReorder.getState().owner,
      ghost:!!document.querySelector('.server-reorder-ghost'),cursor:document.body.classList.contains('server-reordering'),
      integrity:state().servers.every(server=>['token','userId','deviceId','clientName','protocol','address'].every(key=>server[key]===originals.find(item=>item.id===server.id)[key]))
        &&state().servers.every(server=>state().apis[server.id]===apis[server.id]),
      overflow:document.documentElement.scrollWidth>innerWidth,
    });
    window.fixture={
      snapshot,
      reset(count=4){
        if(!mounted){mounted=true;render();}
        flushSync(()=>{navigate('/servers');setShown(true);useServers.setState({servers:originals.slice(0,count),apis,
          activeServerId:'s1',reachability:Object.fromEntries(originals.map(s=>[s.id,{address:s.address,reachable:true}]))});});
        document.querySelector('[data-server-reorder-list="sidebar"]').scrollTop=0;
        document.querySelector('[data-server-reorder-list="grid"]').parentElement.scrollTop=0;
      },
      point(surface,id,placement='center',scroll=true){
        const node=element(surface,id);if(scroll)node.scrollIntoView({block:'nearest'});
        const rect=node.getBoundingClientRect();
        return {x:surface==='grid'&&placement!=='center'?(placement==='before'?rect.left+24:rect.right-24):rect.left+rect.width/2,
          y:surface==='sidebar'&&placement!=='center'?(placement==='before'?rect.top+6:rect.bottom-6):rect.top+rect.height/2};
      },
      control(id,action){const rect=element('grid',id).querySelector('[aria-label="'+action+'服务器 '+originals.find(s=>s.id===id).name+'"]').getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};},
      capture(surface,id){return element(surface,id).hasPointerCapture(1);},
      focus(surface,id){const node=element(surface,id);(surface==='grid'?node.querySelector('button'):node).focus();},
      focusId(){return document.activeElement.closest('[data-server-reorder-id]')?.dataset.serverReorderId;},
      cursorFor(surface,id){return getComputedStyle(surface==='grid'?element(surface,id).querySelector('button'):element(surface,id)).cursor;},
      cancel(){document.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true}));},
      hide(){flushSync(()=>setShown(false));},
      remove(id){flushSync(()=>state().removeServer(id));},
      refresh(){return Promise.all(state().servers.map(s=>state().refreshServer(s.id)));},
      async add(){const server=originals[4];flushSync(()=>useServers.setState({servers:[...state().servers,server]}));},
      rename(){return state().updateServer('s2',{name:'改名测试服务器',address:originals[2].address,username:'Fixture',protocol:'jellyfin'});},
      rehydrate(){flushSync(()=>{useServers.setState({servers:[]});localStorage.setItem('mjc:servers',window.fixture.savedCopy);useServers.persist.rehydrate();});},
      saveCopy(){window.fixture.savedCopy=localStorage.getItem('mjc:servers');},
      unmount(){flushSync(()=>root.unmount());mounted=false;},
      scrollInfo(surface){const list=document.querySelector('[data-server-reorder-list="'+surface+'"]');const scroller=surface==='grid'?list.parentElement:list;const rect=scroller.getBoundingClientRect();return {top:scroller.scrollTop,x:rect.left+rect.width/2,y:rect.bottom-6,max:scroller.scrollHeight-scroller.clientHeight};},
    };
    if(new URLSearchParams(location.search).has('restore'))flushSync(()=>useServers.setState({apis}));
    else flushSync(()=>useServers.setState({servers:originals.slice(0,4),apis,activeServerId:'s1',reachability:{}}));
    render();
    window.fixtureReady=true;
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } }).outputFiles[0].text;
  const page = path.join(directory, 'fixture.html');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`);
  child = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-port=0', '--window-size=1280,800', `--user-data-dir=${path.join(directory,'profile')}`, 'about:blank'], {windowsHide:true,stdio:'ignore'});
  const deadline = Date.now()+15000;
  let port;
  while(Date.now()<deadline){try{port=Number(fs.readFileSync(path.join(directory,'profile','DevToolsActivePort'),'utf8').split('\n')[0]);break;}catch{await wait(50);}}
  assert(port,'Chromium debugging endpoint did not start');
  const targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  socket=new WebSocket(targets.find(target=>target.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let sequence=0;
  const pending=new Map();
  socket.addEventListener('message',event=>{const reply=JSON.parse(event.data);if(!reply.id)return;const entry=pending.get(reply.id);pending.delete(reply.id);clearTimeout(entry.timer);reply.error?entry.reject(Error(reply.error.message)):entry.resolve(reply.result);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Timed out: '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const response=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(response.exceptionDetails)throw Error(response.exceptionDetails.exception?.description||response.exceptionDetails.text);return response.result.value;};
  const fixture=expression=>evaluate('window.fixture.'+expression);
  const snapshot=()=>fixture('snapshot()');
  const mouse=(type,point,extra={})=>send('Input.dispatchMouseEvent',{type,x:point.x,y:point.y,...extra});
  const down=point=>mouse('mousePressed',point,{button:'left',buttons:1,clickCount:1});
  const up=point=>mouse('mouseReleased',point,{button:'left',buttons:0,clickCount:1});
  const move=point=>mouse('mouseMoved',point,{button:'left',buttons:1});
  const key=async(name,code,modifiers=0)=>{await send('Input.dispatchKeyEvent',{type:'keyDown',key:name,code,modifiers});await send('Input.dispatchKeyEvent',{type:'keyUp',key:name,code,modifiers});};
  const order=async(expected,label)=>{await wait(40);const current=await snapshot();for(const surface of ['grid','sidebar','saved'])assert.deepEqual(current[surface],expected,label+' '+surface);assert.equal(current.integrity,true,label+' connection/API identity');assert.equal(current.active,'s1',label+' active selection');};
  const reset=async(count=4)=>{await fixture('reset('+count+')');await wait(60);};
  const drag=async(surface,source,target,placement,targetSurface=surface)=>{
    const start=await fixture('point('+JSON.stringify(surface)+','+JSON.stringify(source)+')');
    await down(start);await move({x:start.x+9,y:start.y});
    assert.equal(await fixture('capture('+JSON.stringify(surface)+','+JSON.stringify(source)+')'),true,'Trusted input must exercise native pointer capture');
    const end=await fixture('point('+JSON.stringify(targetSurface)+','+JSON.stringify(target)+','+JSON.stringify(placement)+')');
    await move(end);await wait(25);
    assert(await evaluate('document.querySelector(".server-reorder-ghost")?.textContent.includes('+JSON.stringify('测试服务器 '+(Number(source.slice(1))+1))+')'),'Preview must visibly identify the dragged server');
    assert(await evaluate('(()=>{const node=document.querySelector(".server-reorder-ghost"),rect=node.getBoundingClientRect();return getComputedStyle(node).position==="fixed"&&rect.top>=0&&rect.bottom<=innerHeight+5&&rect.width>150;})()'),'Dragged card/row must actually remain visible in the viewport');
    assert(await evaluate('!!document.querySelector("[data-server-reorder-source]")'),'Source must retain a visible placeholder');
    return end;
  };

  await send('Page.enable');await send('Page.navigate',{url:pathToFileURL(page).href});
  for(let i=0;i<100;i++){if(await evaluate('!!window.fixtureReady'))break;await wait(50);}
  assert(await evaluate('!!window.fixtureReady'),'Fixture did not render');
  for(const [width,height,scale] of [[1280,800,1],[540,650,1],[1280,800,1.25],[1280,800,1.5]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:scale,mobile:false});await reset();
    assert.equal((await snapshot()).overflow,false,'Responsive layout must fit');
    assert.equal(await fixture('cursorFor("sidebar","s0")'),'grab');assert.equal(await fixture('cursorFor("grid","s0")'),'grab');
    let end=await drag('sidebar','s3','s0','before');
    await order(['s0','s1','s2','s3'],'Drag preview must not persist');
    assert.equal((await snapshot()).drag.targetId,'s0');
    await up(end);await order(['s3','s0','s1','s2'],'Sidebar forward');
    end=await drag('grid','s3','s2','after');await up(end);await order(['s0','s1','s2','s3'],'Grid backward');
    end=await drag('grid','s3','s0','before','sidebar');await up(end);await order(['s3','s0','s1','s2'],'Cross surface');
    await fixture('focus("grid","s2")');await key('ArrowUp','ArrowUp',1);await order(['s3','s0','s2','s1'],'Keyboard grid');
    assert.equal(await fixture('focusId()'),'s2');
    await fixture('focus("sidebar","s3")');await key('ArrowDown','ArrowDown',1);await order(['s0','s3','s2','s1'],'Keyboard sidebar');
    end=await drag('grid','s1','s0','before');await key('Escape','Escape');await up(end);
    await order(['s0','s3','s2','s1'],'Esc cancellation');assert.equal((await snapshot()).route,'/servers','Cancelled drag release must not navigate');
    end=await drag('sidebar','s1','s0','before');await fixture('cancel()');await up(end);await order(['s0','s3','s2','s1'],'Pointer cancellation');
    end=await drag('grid','s1','s0','before');await up({x:width-2,y:height-2});await order(['s0','s3','s2','s1'],'Outside drop');
    await fixture('refresh()');await order(['s0','s3','s2','s1'],'Metadata refresh');
    await fixture('saveCopy()');await fixture('rehydrate()');await order(['s0','s3','s2','s1'],'Hydration persistence');
    const editPoint=await fixture('control("s0","编辑")');await down(editPoint);await up(editPoint);await wait(40);
    assert(await evaluate('!!document.querySelector("[role=dialog]")'),'Edit button retains native click');
    await key('Escape','Escape');await wait(40);
    const ordinary=await fixture('point("grid","s0")');await down(ordinary);await move({x:ordinary.x+2,y:ordinary.y+1});await up(ordinary);await wait(40);
    assert.equal((await snapshot()).route,'/server/s0','Subthreshold motion remains a normal navigation click');
    await reset();
    console.log('PASS: trusted sidebar/grid/cross-surface drag, insertion preview, pointer capture, keyboard/focus, cancel/outside drop, click/edit, shared persistence/API identity ('+width+'px, '+scale+'x)');
  }
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await reset();let end=await drag('grid','s3','s0','before');await fixture('hide()');await up(end);
  assert.equal((await snapshot()).drag,null);assert.equal((await snapshot()).cursor,false);assert.deepEqual((await snapshot()).saved,['s0','s1','s2','s3']);
  await reset();end=await drag('sidebar','s3','s0','before');await fixture('remove("s3")');await up(end);
  assert.equal((await snapshot()).owner,null);assert.deepEqual((await snapshot()).saved,['s0','s1','s2']);
  await reset();end=await drag('grid','s3','s0','before');await fixture('remove("s0")');await up(end);
  assert.deepEqual((await snapshot()).saved,['s1','s2','s3'],'Removed target cannot be reinserted');
  await reset();end=await drag('sidebar','s3','s0','before');await fixture('add()');await up(end);await order(['s3','s0','s1','s2','s4'],'Concurrent addition');
  await fixture('rename()');await wait(40);assert.deepEqual((await snapshot()).saved,['s3','s0','s1','s2','s4'],'Editing retains order');
  for(const surface of ['sidebar','grid']){
    await reset(32);const start=await fixture('point('+JSON.stringify(surface)+',"s0")');await down(start);await move({x:start.x+9,y:start.y});
    const edge=await fixture('scrollInfo('+JSON.stringify(surface)+')');assert(edge.max>0,'Long list must scroll');await move(edge);await wait(450);
    assert((await fixture('scrollInfo('+JSON.stringify(surface)+')')).top>edge.top,'Drag near bottom must auto-scroll '+surface);
    await key('Escape','Escape');await up(edge);assert.equal((await snapshot()).drag,null);
  }
  await reset();end=await drag('sidebar','s3','s0','before');await fixture('unmount()');await up(end);
  assert.equal(await evaluate('document.body.classList.contains("server-reordering")'),false);assert.equal(await evaluate('!!document.querySelector(".server-reorder-ghost")'),false);
  console.log('PASS: hidden-page/unmount cleanup, deleted source/target, concurrent add/edit and both scroll containers');
  await evaluate('window.fixtureReady=false');await send('Page.navigate',{url:pathToFileURL(page).href});
  for(let i=0;i<100;i++){if(await evaluate('!!window.fixtureReady'))break;await wait(50);}
  await reset();end=await drag('sidebar','s3','s0','before');await up(end);await order(['s3','s0','s1','s2'],'Before fresh page');
  await evaluate('window.fixtureReady=false');await send('Page.navigate',{url:pathToFileURL(page).href+'?restore=1'});
  for(let i=0;i<100;i++){if(await evaluate('!!window.fixtureReady'))break;await wait(50);}
  await order(['s3','s0','s1','s2'],'Fresh store/page persistence');assert.equal((await snapshot()).drag,null);
  console.log('PASS: committed order restores in a fresh JavaScript/store/React page; transient drag state is discarded');
  // Leave a synthetic active-drag screenshot for visual QA when requested through an artifact directory.
  if(process.env.MJC_TEST_ARTIFACT_DIR){
    await reset();
    for(const surface of ['grid','sidebar']){
      end=await drag(surface,'s3','s0','before');await wait(50);
      const capture=await send('Page.captureScreenshot',{format:'png'});
      fs.mkdirSync(process.env.MJC_TEST_ARTIFACT_DIR,{recursive:true});
      fs.writeFileSync(path.join(process.env.MJC_TEST_ARTIFACT_DIR,surface==='grid'?'server-order-drag.png':'server-order-sidebar-drag.png'),Buffer.from(capture.data,'base64'));
      await key('Escape','Escape');await up(end);
    }
  }
  await send('Browser.close');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  socket?.close();if(child&&child.exitCode===null){child.kill();await wait(500);}
  const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert(path.basename(resolved).startsWith('mjc-server-order-'));
  fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:200});
});
