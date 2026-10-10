/** Exercise the actual home/library effects against paginated view fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');
function load(file, imports = {}) {
  const code = esbuild.transformSync(fs.readFileSync(file, 'utf8'), { loader: file.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', jsx: 'automatic' }).code;
  const module = {exports:{}};
  new Function('require','module','exports',code)(name => imports[name] ?? (name === '../hooks/useBrowseActivity' ? { useBrowseActivity: () => true } : name === '../hooks/useAutoPagination' ? { useAutoPagination: () => ({current:null}) } : name === '../utils/browseHistory' ? load('src/utils/browseHistory.ts') : name === '../utils/libraryFilters' ? load('src/utils/libraryFilters.ts') : name === '../components/LibraryFilterDialog' ? {default:'FilterDialog'} : require(name)),module,module.exports);
  return module.exports;
}
const identity = load('src/utils/clientIdentity.ts', { './defaultClientIdentity.json': require('../src/utils/defaultClientIdentity.json') });
const media = load('src/api/mediaServer.ts', { '../utils/clientIdentity': identity });
const views = [
  {Id:'first',Name:'First',CollectionType:'movies'},
  {Id:'movies',Name:'Movies',CollectionType:'movies'},
  {Id:'collections',Name:'Collections',CollectionType:'boxsets'},
  {Id:'shows',Name:'Shows',CollectionType:'tvshows'},
  {Id:'empty',Name:'Empty',CollectionType:'boxsets'},
  {Id:'retry',Name:'Retry',CollectionType:'movies'},
];
const items = (prefix,count,type='Movie') => Array.from({length:count},(_,i)=>({Id:`${prefix}-${i}`,Name:`${prefix} ${i}`,Type:type,IsFolder:type==='BoxSet',ImageTags:{Primary:'image'}}));
const data = {first:items('first',2),movies:items('movie',61),collections:items('set',8,'BoxSet'),shows:items('show',30,'Series'),empty:[],retry:items('retry',1), 'set-0':items('member',4), '@resume':items('resume',30),'@next-up':items('next',30,'Episode')};
const calls=[],navigation=[];let failRetry=true;
let delayedPage;
const api={
  getUserViews:async()=>({Items:views}),
  getItem:async id=>id==='set-0'?{Id:id,Name:'Collection members',Type:'BoxSet'}:{...views.find(v=>v.Id===id),Type:'CollectionFolder'},
  queryItems:async(params,signal)=>{
    calls.push({...params,signal});
    if(params.ParentId==='retry' && failRetry)throw new Error('fixture failure');
    if(params.ParentId==='movies' && params.StartIndex===48 && delayedPage)return delayedPage;
    const list=params.ParentId==='collections' && params.IncludeItemTypes!=='BoxSet'?[]:data[params.ParentId]??[];
    return {Items:list.slice(params.StartIndex,params.StartIndex+params.Limit),TotalRecordCount:list.length};
  },
  getLibraryItems(view,start,limit,signal){return media.MediaServerApi.prototype.getLibraryItems.call(this,view,start,limit,signal);},
  getResumeItems:async(limit,start,signal)=>{calls.push({ParentId:'@resume',StartIndex:start,Limit:limit,signal});return {Items:data['@resume'].slice(start,start+limit),TotalRecordCount:30};},
  getNextUp:async(limit,start,signal)=>{calls.push({ParentId:'@next-up',StartIndex:start,Limit:limit,signal});return {Items:data['@next-up'].slice(start,start+limit),TotalRecordCount:30};},
  backdropUrl:item=>item.Type==='Movie'||item.Type==='Series'?`https://fixture/${item.Id}`:null,
  posterUrl:item=>`https://fixture/${item.Id}`,
  logoUrl:()=>null,
};
const settings={showPreviewImage:true,showItemCountInTitle:true,sortFoldersSeparately:false};
const librarySort=load('src/utils/librarySort.ts');
const preferences={sorts:{},setSort(scope,sort){this.sorts[scope]=sort;}};
const backdrop=load('src/store/appBackdrop.ts');
const backdropState=()=>backdrop.useAppBackdrop.getState();
const servers=Object.assign(selector=>selector({servers:[{id:'server',name:'Fixture',address:'https://fixture'}],apis:{server:api}}),{getState:()=>({getApi:()=>api})});
const presentation=load('src/utils/listPresentation.ts',{'../api/mediaServer':media});
function renderHarness(file,params) {
  let searchParams = new URLSearchParams();
  let cursor=0;const hooks=[],effects=[];
  const changed=(previous,deps)=>!previous||deps.some((value,i)=>!Object.is(value,previous[i]));
  const react={
    useState:initial=>{const i=cursor++;hooks[i]??={value:typeof initial==='function'?initial():initial};return [hooks[i].value,next=>{hooks[i].value=typeof next==='function'?next(hooks[i].value):next;}];},
    useRef:initial=>{const i=cursor++;hooks[i]??={current:initial};return hooks[i];},
    useMemo:(factory,deps)=>{const i=cursor++;if(changed(hooks[i]?.deps,deps))hooks[i]={value:factory(),deps};return hooks[i].value;},
    useEffect:(effect,deps)=>{const i=cursor++;if(changed(hooks[i]?.deps,deps))effects.push(()=>{hooks[i]?.cleanup?.();hooks[i]={deps,cleanup:effect()};});},
  };
  react.useCallback=(fn,deps)=>react.useMemo(()=>fn,deps);
  const component=load(file,{
    react,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
    'react-router-dom':{useParams:()=>params,useNavigate:()=>path=>navigation.push(path),useSearchParams:()=>[searchParams,next=>{searchParams=new URLSearchParams(next);}]},
    '../api/mediaServer':media,'../utils/listPresentation':presentation,
    '../store/servers':{useServers:servers},'../store/settings':{useSettings:selector=>selector?selector(settings):settings},
    '../store/libraryPreferences':{useLibraryPreferences:selector=>selector(preferences)},'../utils/librarySort':librarySort,
    '../store/appBackdrop':backdrop,
    '../components/SectionRow':{__esModule:true,default:'Section'},'../components/PosterCard':{__esModule:true,default:'Poster'},
    '../components/HeroCarousel':{__esModule:true,default:'Hero'},
    '../components/LiquidGlass':{__esModule:true,default:'Glass'},
    '../components/LibrarySortMenu':{__esModule:true,default:'SortMenu'},
    '../components/Feedback':{EmptyState:'Empty',ErrorState:'Error',Spinner:'Spinner'},
    '../components/icons':{IconServer:'Icon',IconChevronLeft:'Icon'},
  }).default;
  return {
    render(){cursor=0;let tree=component();if(file.endsWith('Home.tsx'))tree=tree.type(tree.props);for(const effect of effects.splice(0))effect();return tree;},
    unmount(){for(const hook of hooks)hook?.cleanup?.();},
  };
}
const find=(tree,predicate)=>!tree||typeof tree!=='object'?[]:Array.isArray(tree)?tree.flatMap(node=>find(node,predicate)):[...(predicate(tree)?[tree]:[]),...find(tree.props?.children,predicate)];
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const section=(tree,title)=>find(tree,n=>n.type==='Section'&&n.props.title===title)[0];
const posters=tree=>find(tree,n=>n.type==='Poster');
const buttons=tree=>find(tree,n=>n.type==='button');
(async()=>{
  const home=renderHarness('src/pages/Home.tsx',{serverId:'server'});
  home.render();await flush();let tree=home.render();
  assert.equal(find(tree,n=>n.type==='Section'&&n.props.title.startsWith('最新')).length,6,'every view must have a latest row, including the fourth and later views');
  assert.equal(posters(section(tree,'最新Shows')).length,24,'fourth view must load');
  const firstHero=find(tree,n=>n.type==='Hero')[0];
  assert(firstHero?.props.onCurrentItemChange,'The visible carousel must publish its current artwork to the glass backdrop');
  firstHero.props.onCurrentItemChange(firstHero.props.items[0]);
  assert.equal(backdropState().source?.route,'/server/server','Ambient artwork must remain scoped to the active home route');
  assert.equal(backdropState().source?.url,api.backdropUrl(firstHero.props.items[0],1920),'The shell must reuse the current carousel image');
  firstHero.props.onCurrentItemChange(firstHero.props.items.at(-1));
  assert.equal(backdropState().source?.url,api.backdropUrl(firstHero.props.items.at(-1),1920),'Changing the current carousel item must change the glass scenery');
  settings.showPreviewImage=false;tree=home.render();
  assert.equal(find(tree,n=>n.type==='Hero').length,0,'Disabling previews must remove the carousel');
  assert.equal(backdropState().source,null,'Disabling previews must also remove ambient artwork');
  settings.showPreviewImage=true;tree=home.render();
  const restoredHero=find(tree,n=>n.type==='Hero')[0];
  restoredHero.props.onCurrentItemChange(restoredHero.props.items[0]);
  assert(backdropState().source,'Re-enabling previews must allow current artwork to return');
  restoredHero.props.onCurrentItemChange(null);
  assert.equal(backdropState().source,null,'A carousel with no current image must retain the gradient fallback');
  restoredHero.props.onCurrentItemChange(restoredHero.props.items[0]);
  const sets=section(tree,'最新Collections');assert.equal(posters(sets).length,8,'all eight collection containers must appear');
  posters(sets)[0].props.onClick();assert.equal(navigation.at(-1),'/server/server/library/set-0','collections must navigate to their members');
  assert(find(section(tree,'最新Empty'),n=>n.props?.children==='此分类暂无内容').length);
  const retry=buttons(section(tree,'最新Retry')).find(n=>n.props.children==='重试');assert(retry,'errors must stay visible and offer retry');
  failRetry=false;retry.props.onClick();await flush();tree=home.render();assert.equal(posters(section(tree,'最新Retry')).length,1);
  const movies=section(tree,'最新Movies');movies.props.onLoadMore();movies.props.onLoadMore();await flush();tree=home.render();
  assert.equal(calls.filter(c=>c.ParentId==='movies'&&c.StartIndex===24).length,1,'in-flight pages must not be requested twice');
  assert.equal(posters(section(tree,'最新Movies')).length,48,'pagination must go beyond the old 12-item limit');
  section(tree,'最新Movies').props.onLoadMore();await flush();tree=home.render();
  assert.equal(posters(section(tree,'最新Movies')).length,61,'no total item cap is allowed');
  assert.equal(section(tree,'最新Movies').props.onLoadMore,undefined,'stop only when the server total is reached');
  section(tree,'继续观看').props.onLoadMore();section(tree,'接下来').props.onLoadMore();await flush();tree=home.render();
  assert.equal(posters(section(tree,'继续观看')).length,30);assert.equal(posters(section(tree,'接下来')).length,30);
  home.unmount();
  assert.equal(backdropState().source,null,'Leaving home must release its ambient artwork');
  restoredHero.props.onCurrentItemChange(restoredHero.props.items[0]);
  assert.equal(backdropState().source,null,'A callback from an unmounted home must not restore its artwork');
  assert(calls.every(c=>c.ParentId.startsWith('@')||c.SortBy==='DateCreated,SortName'));
  console.log('PASS: all categories, eight collection containers, unlimited pagination, resume/next-up pagination, retries and correct navigation');

  const params={serverId:'server',libraryId:'collections'};
  const library=renderHarness('src/pages/Library.tsx',params);
  library.render();await flush();library.render();await flush();tree=library.render();
  assert.equal(posters(tree).length,8,'the collection library must query BoxSet, not Movie/Series');
  assert(calls.some(c=>c.ParentId==='collections'&&c.IncludeItemTypes==='BoxSet'&&c.Limit===120));
  posters(tree)[0].props.onClick();assert.equal(navigation.at(-1),'/server/server/library/set-0');
  params.libraryId='set-0';library.render();await flush();library.render();await flush();tree=library.render();
  assert.equal(posters(tree).length,4,'a collection must show its media members');
  assert(calls.some(c=>c.ParentId==='set-0'&&c.IncludeItemTypes.includes('Movie')));
  library.unmount();
  console.log('PASS: collection library filters and collection-member browsing');

  let resolveLate;
  delayedPage=new Promise(resolve=>{resolveLate=resolve;});
  const cancelled=renderHarness('src/pages/Home.tsx',{serverId:'server'});
  cancelled.render();await flush();tree=cancelled.render();section(tree,'最新Movies').props.onLoadMore();await flush();tree=cancelled.render();
  section(tree,'最新Movies').props.onLoadMore();
  const request=calls.at(-1);assert.equal(request.StartIndex,48);cancelled.unmount();assert(request.signal.aborted);
  resolveLate({Items:items('late',24),TotalRecordCount:100});await flush();
  assert(!posters(section(cancelled.render(),'最新Movies')).some(p=>p.props.item.Id.startsWith('late')),'unmounted home must ignore late responses');
  console.log('PASS: pending pages are cancelled and late responses are ignored');

  const heroStates=[0,false],heroEffects=[],heroNotifications=[];let heroCursor=0;
  const Hero=load('src/components/HeroCarousel.tsx',{
    react:{useState:initial=>{const i=heroCursor++;return [heroStates[i]??initial,next=>{heroStates[i]=typeof next==='function'?next(heroStates[i]):next;}];},useCallback:fn=>fn,useEffect:effect=>heroEffects.push(effect)},
    'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
    'react-router-dom':{useNavigate:()=>path=>navigation.push(path)},'./icons':{IconChevronLeft:'Icon',IconChevronRight:'Icon',IconSearch:'Icon'},
    './LiquidGlass':{__esModule:true,default:'Glass'},
  }).default;
  const carouselItems=items('carousel',61);
  const publishCurrent=item=>heroNotifications.push(item);
  const renderHero=(list=carouselItems)=>{
    heroCursor=0;
    const tree=Hero({api,items:list,serverId:'server',onCurrentItemChange:publishCurrent});
    // Exercise actual effects while immediately disposing the fixture's autoplay interval.
    for(const effect of heroEffects.splice(0))effect()?.();
    return tree;
  };
  let hero=renderHero();
  assert.equal(heroNotifications.at(-1),carouselItems[0],'The first visible carousel item must publish itself');
  assert.equal(find(hero,n=>n.type==='img').length,3,'the unlimited carousel must not download every backdrop at once');
  const heroButton=label=>buttons(hero).find(button=>button.props['aria-label']===label);
  const searchButton=heroButton('搜索当前服务器媒体库');
  assert(searchButton&&searchButton.props.title==='搜索','Carousel search must have an accessible name and hover hint');
  let stopped=false;
  searchButton.props.onClick({stopPropagation(){stopped=true;}});
  assert(stopped,'Searching must not open the current media detail');
  const searchUrl=new URL(navigation.at(-1),'https://fixture');
  assert.equal(searchUrl.pathname,'/search');
  assert.equal(searchUrl.searchParams.get('serverId'),'server','Carousel search must keep the displayed server scope');
  assert(heroButton('上一张预览')&&heroButton('下一张预览'),'both carousel directions remain accessible');
  assert.equal(buttons(hero).filter(button=>button.props['aria-label']?.startsWith('查看第 ')).length,7,'keep a bounded indicator strip rather than dozens of dots');
  for(let i=0;i<60;i++)heroButton('下一张预览').props.onClick({stopPropagation(){}});
  hero=renderHero();
  assert(find(hero,n=>n.type==='img'&&n.props.alt==='carousel 60'&&n.props.className.includes('opacity-100')).length,'all carousel items remain navigable');
  assert.equal(heroNotifications.at(-1),carouselItems[60],'Backdrop publication must follow navigation to the last loaded item');
  hero=renderHero([carouselItems[0]]);
  assert(heroButton('搜索当前服务器媒体库'),'A single-item carousel must retain search');
  assert(!heroButton('上一张预览')&&!heroButton('下一张预览'),'A single-item carousel needs no arrows');
  renderHero([]);
  assert.equal(heroNotifications.at(-1),null,'An emptied carousel must publish the gradient fallback');
  console.log('PASS: unlimited carousel navigation with lazy backdrop rendering');
  console.log('PASS: circular carousel search, current-server navigation, click isolation and single-item previews');
  console.log('PASS: current carousel artwork, preview settings, empty-image fallback and home backdrop cleanup');
})().catch(error=>{console.error(error);process.exitCode=1;});
