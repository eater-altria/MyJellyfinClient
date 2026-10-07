/** Verify the real glass buttons in Chromium: native actions, disabled state and section scrolling. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

const browser = [
  process.env.MJC_TEST_CHROMIUM,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(candidate => candidate && fs.existsSync(candidate));
assert(browser, 'Set MJC_TEST_CHROMIUM to a Chromium executable for the native button regression');
const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mjc-glass-buttons-'));
try {
  const bundle = esbuild.buildSync({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import GlassButton from './src/components/GlassButton';
      import SectionRow from './src/components/SectionRow';
      const result = document.getElementById('result');
      const check = (value, message) => { if (!value) throw new Error(message); };
      let clicks = 0, disabledClicks = 0, submissions = 0, pointerMoves = 0, pointerLeaves = 0, moreClicks = 0;
      const buttonRef = React.createRef<HTMLButtonElement>();
      const root = createRoot(document.getElementById('root')!);
      try {
        flushSync(() => root.render(<>
          <form onSubmit={event => { event.preventDefault(); submissions++; }}>
            <GlassButton ref={buttonRef} id="normal" name="action" value="play" title="Play fixture"
              aria-label="Play fixture" data-fixture="native"
              onClick={() => clicks++} onPointerMove={() => pointerMoves++} onPointerLeave={() => pointerLeaves++}>
              <span>Play fixture</span>
            </GlassButton>
            <GlassButton id="disabled" disabled onClick={() => disabledClicks++}>Disabled fixture</GlassButton>
            <GlassButton id="submit" type="submit">Submit fixture</GlassButton>
          </form>
          <SectionRow title="Fixture" onMore={() => moreClicks++}><span>Media fixture</span></SectionRow>
        </>));
        const normal = document.getElementById('normal') as HTMLButtonElement;
        const disabled = document.getElementById('disabled') as HTMLButtonElement;
        check(normal instanceof HTMLButtonElement && normal.type === 'button', 'Default control must be a native non-submitting button');
        check(buttonRef.current === normal, 'Consumer ref must expose the native button');
        check(normal.name === 'action' && normal.value === 'play' && normal.title === 'Play fixture', 'Native attributes must be forwarded');
        check(normal.getAttribute('aria-label') === 'Play fixture' && normal.dataset.fixture === 'native', 'Accessible and custom attributes must be forwarded');
        const material = normal.querySelector('.glass-button-material');
        check(material.tagName === 'SPAN' && material.getAttribute('aria-hidden') === 'true' && material.dataset.glassIntensity === 'prominent', 'Optical backdrop must be phrasing content hidden from accessibility');
        check(!normal.querySelector('div') && normal.querySelector('.glass-button-content').textContent === 'Play fixture', 'Label must stay outside the optical material');
        normal.click();
        check(clicks === 1 && submissions === 0, 'Native activation must retain its callback without submitting by default');
        normal.focus(); disabled.focus(); disabled.click();
        check(document.activeElement === normal && disabledClicks === 0 && disabled.disabled, 'Native disabled must prevent focus and activation');
        document.getElementById('submit').click();
        check(submissions === 1, 'Explicit submit type must retain native form behavior');
        const rect = normal.getBoundingClientRect();
        normal.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
        check(pointerMoves === 1 && normal.style.getPropertyValue('--glass-pointer-x') === '50%', 'Pointer highlighter must retain consumer callback');
        normal.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body }));
        check(pointerLeaves === 1 && !normal.style.getPropertyValue('--glass-pointer-x'), 'Pointer leave must clear inherited highlight and retain callback');
        const scroller = document.querySelector('[aria-label="Fixture列表"]') as HTMLDivElement;
        const scrolls = [];
        scroller.scrollBy = options => scrolls.push(options);
        document.querySelector('[aria-label="查看全部Fixture"]').click();
        document.querySelector('[aria-label="Fixture向左滚动"]').click();
        document.querySelector('[aria-label="Fixture向右滚动"]').click();
        check(moreClicks === 1 && scrolls.length === 2 && scrolls[0].left === -scroller.clientWidth * .8 && scrolls[1].left === scroller.clientWidth * .8 && scrolls.every(value => value.behavior === 'smooth'), 'Section controls must retain native more/scroll actions');
        check([...document.querySelectorAll('section button')].every(button => button.querySelector('.glass-button-material')), 'Every section navigation control must carry optical glass');
        flushSync(() => root.unmount());
        check(buttonRef.current === null, 'Native ref must clear after unmount');
        result.dataset.status = 'pass';
        result.textContent = 'PASS: native glass button attributes, refs, disabled activation, form types, pointer callbacks and section scrolling';
      } catch (error) {
        result.dataset.status = 'fail'; result.textContent = String(error.stack || error);
      }
    ` },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).outputFiles[0].text;
  const page = path.join(fixtureDirectory, 'fixture.html');
  fs.writeFileSync(page, `<!doctype html><html><body><div id="root"></div><pre id="result" data-status="pending"></pre><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script></body></html>`);
  const execution = spawnSync(browser, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    `--user-data-dir=${path.join(fixtureDirectory, 'profile')}`, '--dump-dom', '--virtual-time-budget=1000', pathToFileURL(page).href,
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  if (execution.error) throw execution.error;
  assert.equal(execution.status, 0, execution.stderr);
  const output = execution.stdout.match(/<pre id="result" data-status="([^"]+)">([\s\S]*?)<\/pre>/);
  assert.equal(output?.[1], 'pass', output?.[2] ?? execution.stderr);
  console.log(output[2]);
} finally {
  const resolved = path.resolve(fixtureDirectory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('mjc-glass-buttons-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
