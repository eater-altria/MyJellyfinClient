/** Real detail pages with synthetic transparent PNG logos: layout, fallback and rendered contrast. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

// Chromium screenshots use non-interlaced RGB/RGBA PNGs. Decode scanlines for actual color assertions.
function pngPixels(file) {
  const png = fs.readFileSync(file), chunks = [];
  let width, height, channels;
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + size);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.equal(data[8], 8); assert.equal(data[12], 0);
      channels = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0;
      assert(channels, 'Unexpected screenshot color format');
    }
    if (type === 'IDAT') chunks.push(data);
    offset += size + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks)), stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const prediction = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upperLeft)][filter];
      assert.notEqual(prediction, undefined, 'Invalid PNG scanline filter');
      pixels[y * stride + x] = (raw[y * (stride + 1) + x + 1] + prediction) & 255;
    }
  }
  return (x, y) => [...pixels.subarray((Math.round(y) * width + Math.round(x)) * channels,
    (Math.round(y) * width + Math.round(x)) * channels + 3)];
}
const luminance = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  .reduce((value, channel, index) => value + channel * [.2126, .7152, .0722][index], 0);

(async () => {
  const browser = [process.env.MJC_TEST_CHROMIUM,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(candidate => candidate && fs.existsSync(candidate));
  assert(browser, 'Set MJC_TEST_CHROMIUM for the detail logo regression');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mjc-detail-logo-'));
  try {
    const config = (await import(pathToFileURL(path.resolve('tailwind.config.js')).href)).default;
    const css = (await require('postcss')([require('tailwindcss')(config), require('autoprefixer')])
      .process(fs.readFileSync('src/index.css', 'utf8'), { from: path.resolve('src/index.css') })).css;
    const bundle = esbuild.buildSync({
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
        import SeriesDetail from './src/pages/SeriesDetail';
        import MovieDetail from './src/pages/MovieDetail';
        import MediaDetailHeader from './src/components/MediaDetailHeader';
        import { useServers } from './src/store/servers';
        import { useSettings } from './src/store/settings';
        const result=document.getElementById('result'),host=document.getElementById('root');
        const root=createRoot(host),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        const check=(ok,message)=>{if(!ok)throw new Error(message);};
        const svg=body=>'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">'+body+'</svg>');
        const cover=svg('<path fill="#fff" d="M0 0h1200v800H0z"/>');
        const canvas=document.createElement('canvas');canvas.width=360;canvas.height=112;
        const ctx=canvas.getContext('2d');
        ctx.fillStyle='#f04b1a';ctx.fillRect(8,22,30,30);ctx.fillRect(8,65,30,30);
        ctx.fillStyle='#fff';ctx.font='bold 32px Segoe UI';ctx.fillText('SYNTHETIC',58,48);ctx.fillText('TITLE',58,88);
        const logo=canvas.toDataURL('image/png');
        // Known opaque white and orange swatches, plus a transparent patch, remain part of the test artwork.
        ctx.fillStyle='#fff';ctx.fillRect(310,26,16,16);
        const sampledLogo=canvas.toDataURL('image/png');
        const blackCanvas=document.createElement('canvas');blackCanvas.width=360;blackCanvas.height=112;
        const blackContext=blackCanvas.getContext('2d');blackContext.drawImage(canvas,0,0);
        blackContext.globalCompositeOperation='source-in';blackContext.fillStyle='#000';blackContext.fillRect(0,0,360,112);
        const blackLogo=blackCanvas.toDataURL('image/png');
        const wideCanvas=document.createElement('canvas');wideCanvas.width=1600;wideCanvas.height=112;
        wideCanvas.getContext('2d').drawImage(canvas,0,0,1600,112);const wideLogo=wideCanvas.toDataURL('image/png');
        let logoSource=sampledLogo,hasCover=true,location,instance=0;
        const actions=[];
        const item=id=>({Id:id,Name:'Synthetic '+id,Type:id==='series'?'Series':id==='episode'?'Episode':'Movie',
          SeriesId:id==='episode'?'series':undefined,SeriesName:'Synthetic series',ParentIndexNumber:2,IndexNumber:3,
          Overview:'Synthetic synopsis remains on light glass.',Genres:['Fixture'],CommunityRating:8.4,
          UserData:{PlaybackPositionTicks:100000000,Played:false}});
        const api={getItem:async id=>item(id),getSimilar:async()=>({Items:[]}),
          getSeasons:async()=>({Items:[{Id:'season',Name:'Season',IndexNumber:1}]}),
          getEpisodes:async()=>({Items:[{...item('episode'),IndexNumber:1}]}),
          logoUrl:()=>logoSource,backdropUrl:()=>hasCover?cover:null,thumbUrl:()=>null,posterUrl:()=>null,
          markPlayed:async id=>actions.push('played:'+id),markUnplayed:async()=>{},setFavorite:async(id,value)=>actions.push('favorite:'+id+':'+value)};
        useServers.setState({servers:[{id:'fixture',name:'Fixture'}],apis:{fixture:api}});
        useSettings.setState({showPreviewImage:true,resumeFromLastPosition:true});
        function Location(){location=useLocation();return null;}
        const render=kind=>flushSync(()=>root.render(<MemoryRouter key={instance++} initialEntries={['/server/fixture/'+kind+'/'+kind]}>
          <Location/><Routes><Route path="/server/:serverId/series/:itemId" element={<SeriesDetail/>}/>
          <Route path="/server/:serverId/movie/:itemId" element={<MovieDetail/>}/>
          <Route path="/server/:serverId/episode/:itemId" element={<MovieDetail/>}/>
          <Route path="/player/:serverId/:itemId" element={<p>Playback fixture</p>}/></Routes></MemoryRouter>));
        const click=button=>flushSync(()=>button.click());
        const checkLayout=()=>{
          const image=host.querySelector('.detail-logo-image'),info=host.querySelector('.detail-header-info');
          check(image?.complete&&image.naturalWidth,'Transparent PNG must load');
          check(!image.closest('.liquid-glass'),'Logo must sit outside all glass material');
          check(info.querySelector('h1').textContent.startsWith('Synthetic')&&host.querySelectorAll('h1').length===1,'Light card must always expose exactly one text heading');
          check(host.querySelector('.detail-logo-artwork').getAttribute('aria-hidden')==='true','Logo artwork must not duplicate the accessible text title');
          const logoBounds=image.getBoundingClientRect(),infoBounds=info.getBoundingClientRect(),page=host.getBoundingClientRect();
          check(logoBounds.bottom<infoBounds.top,'Logo must float above the information card');
          check(logoBounds.left>=page.left&&logoBounds.right<=page.right,'Logo must stay inside narrow content');
          check(logoBounds.height<=112.1&&logoBounds.width<=448.1,'Logo dimensions must stay bounded');
          check(Math.abs(logoBounds.width/logoBounds.height-image.naturalWidth/image.naturalHeight)<.02,'Logo must preserve its original aspect ratio');
          const button=info.querySelector('.detail-action-row button').getBoundingClientRect();
          check(Math.abs(button.left-logoBounds.left)<=1,'Logo must align with information-card controls');
          check(host.textContent.includes('Synthetic synopsis remains on light glass.'),'Synopsis must remain available');
          check(getComputedStyle(info.querySelector('.detail-action-row')).marginTop==='20px','Actions must retain spacing below the visible title');
          check(host.firstElementChild.scrollWidth<=host.firstElementChild.clientWidth+1,'Detail page must not overflow sideways');
        };
        (async()=>{try{
          for(const kind of ['series','movie']){render(kind);await wait(100);checkLayout();
            click(host.querySelector('[aria-label="收藏"]'));await wait(20);
            check(actions.includes('favorite:'+kind+':true'),'Favorite action must survive the layout change');
            click(host.querySelector('[aria-label="标记已看"]'));await wait(20);
            check(actions.includes('played:'+kind),'Watched action must survive the layout change');
            const play=[...host.querySelectorAll('.detail-header-info button')].find(button=>button.textContent.startsWith('播放'));
            click(play);await wait(20);check(location.pathname.startsWith('/player/fixture/'),'Play must retain navigation');
          }
          logoSource=null;render('movie');await wait(80);
          check(!host.querySelector('.detail-logo-stage')&&host.querySelector('.detail-header-info h1').textContent==='Synthetic movie','Missing artwork must use a text title inside the light card');
          logoSource='data:image/png;base64,bm90LWEtdmFsaWQtcG5n';render('series');await wait(100);
          check(!host.querySelector('.detail-logo-stage')&&host.querySelector('.detail-header-info h1').textContent==='Synthetic series','Failed PNG must fall back to the media name');
          logoSource=sampledLogo;render('series');await wait(80);checkLayout();
          flushSync(()=>useSettings.setState({showPreviewImage:false}));await wait(30);
          check(!host.querySelector('img')&&host.querySelector('.detail-header-info h1'),'Disabled previews must stop mounting cover and logo images');
          flushSync(()=>useSettings.setState({showPreviewImage:true}));await wait(80);checkLayout();
          hasCover=false;render('movie');await wait(80);checkLayout();
          check(host.querySelectorAll('img').length===1,'A missing cover must not prevent the logo from displaying');
          hasCover=true;logoSource=wideLogo;render('movie');await wait(80);checkLayout();
          logoSource=blackLogo;render('movie');await wait(80);checkLayout();
          logoSource=sampledLogo;render('episode');await wait(80);
          check(!host.querySelector('.detail-logo-stage')&&host.querySelector('.detail-header-info h1').textContent==='Synthetic episode','Episodes must retain a text title');
          check(host.querySelector('a[href="/server/fixture/series/series"]')&&host.textContent.includes('第 2 季')&&host.textContent.includes('第 3 集'),'Episode series/season links must remain available');
          flushSync(()=>root.render(<MediaDetailHeader title={'VeryLongSyntheticTitle'.repeat(15)} logoUrl={null}><div className="detail-action-row mt-5"><button>Action</button></div></MediaDetailHeader>));
          check(host.querySelector('h1').getBoundingClientRect().right<=host.getBoundingClientRect().right,'Long fallback titles must wrap within the card');
          flushSync(()=>root.render(<MediaDetailHeader title="Updated logo fixture" logoUrl="data:image/png;base64,bm90LWEtdmFsaWQtcG5n">Content</MediaDetailHeader>));await wait(80);
          check(!host.querySelector('.detail-logo-stage'),'Broken component URL must fall back');
          flushSync(()=>root.render(<MediaDetailHeader title="Updated logo fixture" logoUrl={logo}>Content</MediaDetailHeader>));await wait(80);
          check(host.querySelector('.detail-logo-image')?.naturalWidth,'Updating the logo URL must retry the image');
          useSettings.setState({accentColor:'#bd55ed'});
          logoSource=new URLSearchParams(window.location.search).has('black')?blackLogo:sampledLogo;
          render('series');await wait(100);checkLayout();
          const image=host.querySelector('.detail-logo-image'),rect=image.getBoundingClientRect();
          const point=(x,y)=>[rect.left+x*rect.width/image.naturalWidth,rect.top+y*rect.height/image.naturalHeight];
          result.dataset.samples=JSON.stringify({white:point(318,34),red:point(23,37),background:point(318,70),outline:point(318,43)});
          result.dataset.status='pass';result.textContent='PASS: actual movie/series logo separation, always-visible text heading, PNG fit, missing/failed images, URL retry, previews, no cover, long titles, episode links and native actions';
        }catch(error){result.dataset.status='fail';result.textContent=String(error.stack||error);}})();
      ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    }).outputFiles[0].text;
    const page = path.join(directory, 'fixture.html');
    fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>${css}
      #root{position:relative;isolation:isolate;margin:42px 0 0 220px;width:calc(100% - 232px);height:calc(100% - 54px)}
      @media(max-width:620px){#root{margin-left:80px;width:calc(100% - 92px)}}
      </style><div id="root"></div><pre id="result" style="display:none" data-status="pending"></pre>
      <script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`);
    for (const [width, height, scale, black] of [[1280,800,1], [540,600,1], [1280,800,1.25], [1280,800,1.5], [1280,800,1,true]]) {
      const screenshot = path.resolve(process.env.MJC_TEST_ARTIFACT_DIR || directory, `detail-logo-${width}-${scale}${black ? '-black' : ''}.png`);
      const execution = spawnSync(browser, [
        '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        `--user-data-dir=${path.join(directory, 'profile')}`, `--window-size=${width},${height}`,
        `--force-device-scale-factor=${scale}`, `--screenshot=${screenshot}`,
        '--dump-dom', '--virtual-time-budget=5000', pathToFileURL(page).href + (black ? '?black=1' : ''),
      ], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      if (execution.error) throw execution.error;
      assert.equal(execution.status, 0, execution.stderr);
      const output = execution.stdout.match(/<pre id="result"[^>]*data-status="([^"]+)"[^>]*>([\s\S]*?)<\/pre>/);
      assert.equal(output?.[1], 'pass', output?.[2] ?? execution.stderr);
      const samples = JSON.parse(execution.stdout.match(/data-samples="([^"]+)"/)[1].replace(/&quot;/g, '"'));
      const pixel = pngPixels(screenshot), color = name => pixel(...samples[name].map(value => value * scale));
      const white = color('white'), red = color('red'), background = color('background');
      assert(background.every(value => value >= 210), 'Transparent logo areas must retain the cover without a dark gradient');
      // Locate the swatch's edge in the rendered crop: Chrome's CLI screenshot can adjust scrollbar gutters.
      const [edgeX, edgeY] = samples.white.map(value => value * scale);
      let outline = color('outline'), swatch = white;
      for (let y = -20; y <= 20; y++) for (let x = -20; x <= 20; x++) {
        const candidate = pixel(edgeX + x * scale, edgeY + y * scale);
        if (luminance(candidate) < luminance(outline)) outline = candidate;
        if (luminance(candidate) > luminance(swatch)) swatch = candidate;
      }
      if (black) {
        assert(outline.every(value => value <= 25), 'Black artwork must retain its original color');
        console.log('PASS: black transparent artwork retains original colors and clear background');
        continue;
      }
      assert(swatch.every(value => value >= 250), 'White artwork must retain its original color');
      assert(red[0] > 180 && red[1] < 130 && red[2] < 80, 'Colored branding must retain its original color');
      const contrast = (luminance(swatch) + .05) / (luminance(outline) + .05);
      assert(contrast >= 1.5, `White artwork must have a visible outline over a white cover: ${contrast.toFixed(2)} ${JSON.stringify({samples, white, red, background, outline})}`);
      console.log(output[2], `(${width}x${height}, ${scale * 100}%, visible outline ${contrast.toFixed(2)}:1, no dark substrate)`);
    }
  } finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('mjc-detail-logo-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
