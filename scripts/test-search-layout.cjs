/** Render the actual search page and measure empty/result scrolling in Chromium. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

(async () => {
  const browser = [process.env.MJC_TEST_CHROMIUM,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(candidate => candidate && fs.existsSync(candidate));
  assert(browser, 'Set MJC_TEST_CHROMIUM for the search layout regression');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mjc-search-layout-'));
  try {
    const config = (await import(pathToFileURL(path.resolve('tailwind.config.js')).href)).default;
    const css = (await require('postcss')([require('tailwindcss')(config), require('autoprefixer')])
      .process(fs.readFileSync('src/index.css', 'utf8'), { from: path.resolve('src/index.css') })).css;
    const bundle = esbuild.buildSync({
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { MemoryRouter } from 'react-router-dom';
        import Search from './src/pages/Search';
        import { useServers } from './src/store/servers';
        const items = Array.from({length:80}, (_, index) => ({Id:'fixture-'+index, Name:'Media '+index, Type:'Movie'}));
        const api = { posterUrl:()=>null, search:async term => {
          if(term==='error')throw new Error('fixture failure');
          if(term==='loading')return new Promise(()=>{});
          return {Items:term==='results'?items:[]};
        }};
        useServers.setState({servers:[{id:'fixture',name:'Fixture',address:'https://fixture.invalid'}], activeServerId:'fixture', apis:{fixture:api}});
        const host = document.getElementById('root');
        const root = createRoot(host);
        const result = document.getElementById('result');
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const check = (ok,message) => {if(!ok)throw new Error(message);};
        let instance=0;
        const render = term => flushSync(()=>root.render(<MemoryRouter key={instance++} initialEntries={[term?'/search?q='+term:'/search']}><Search/></MemoryRouter>));
        const noScroll = state => {
          const page=host.firstElementChild;
          check(page.scrollHeight<=page.clientHeight+1, state+' must not create blank scrolling: '+page.scrollHeight+'/'+page.clientHeight);
          const input=page.querySelector('input').getBoundingClientRect();
          const bounds=page.getBoundingClientRect();
          check(input.top>=bounds.top&&input.bottom<=bounds.bottom, state+' must keep search visible');
        };
        (async()=>{try{
          render(''); await wait(80); noScroll('Initial empty state');
          check(document.activeElement===host.querySelector('input'),'Search must retain initial focus');
          render('loading'); await wait(80); noScroll('Loading state');
          render('empty'); await wait(550); noScroll('No results');
          render('error'); await wait(550); noScroll('Error state');
          check(host.querySelector('[role=alert] button'),'Error must retain retry');
          render('results'); await wait(550);
          const page=host.firstElementChild;
          check(page.scrollHeight>page.clientHeight,'Populated search must scroll when results exceed the window');
          const cards=host.querySelectorAll('button[title^="Media "]');
          check(cards.length===80,'Every fixture result must remain available');
          page.scrollTop=page.scrollHeight;
          check(cards[79].getBoundingClientRect().bottom<=page.getBoundingClientRect().bottom,'Last result must remain reachable by scrolling');
          page.scrollTop=0;
          flushSync(()=>host.querySelector('[aria-label="清除搜索"]').click());
          await wait(80); noScroll('Cleared search');
          check(host.querySelector('input').value==='','Clear must remove the query');
          useServers.setState({activeServerId:null});render(''); await wait(80); noScroll('No selected server');
          result.dataset.status='pass';result.textContent='PASS: initial, loading, no-result, error, clear and no-server layouts; populated scrolling and last result access';
          root.unmount();
        }catch(error){result.dataset.status='fail';result.textContent=String(error.stack||error);}})();
      ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    }).outputFiles[0].text;
    const page = path.join(directory, 'fixture.html');
    fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>${css}
      #root{margin:42px 0 0 220px;width:calc(100% - 232px);height:calc(100% - 54px)}
      @media(max-width:620px){#root{margin-left:80px;width:calc(100% - 92px)}}
      </style><div id="root"></div><pre id="result" style="display:none" data-status="pending"></pre>
      <script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`);
    for (const [width, height] of [[1280, 800], [540, 600]]) {
      const execution = spawnSync(browser, [
        '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        `--user-data-dir=${path.join(directory, 'profile')}`, `--window-size=${width},${height}`,
        '--dump-dom', '--virtual-time-budget=5000', pathToFileURL(page).href,
      ], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      if (execution.error) throw execution.error;
      assert.equal(execution.status, 0, execution.stderr);
      const output = execution.stdout.match(/<pre id="result"[^>]*data-status="([^"]+)"[^>]*>([\s\S]*?)<\/pre>/);
      assert.equal(output?.[1], 'pass', output?.[2] ?? execution.stderr);
      console.log(output[2], `(${width}x${height})`);
    }
  } finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('mjc-search-layout-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
