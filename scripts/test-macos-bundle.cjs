/** Launch the actual signed bundle with an isolated, nonpersistent WebView. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

async function main() {
  assert.equal(process.platform, 'darwin', 'Bundle launch regression requires macOS');
  const root = path.resolve(__dirname, '..');
  const app = path.resolve(process.argv[2] || path.join(root, 'src-tauri/target/release/bundle/macos/MyJellyfinClient.app'));
  const executable = path.join(app, 'Contents/MacOS/my-jellyfin-client');
  assert(fs.existsSync(executable), 'Build the macOS app first');
  const signature = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' });
  assert.equal(signature.status, 0, signature.stderr);
  const loadCommands = spawnSync('/usr/bin/otool', ['-l', executable], { encoding: 'utf8' });
  assert.equal(loadCommands.status, 0, loadCommands.stderr);
  const rpaths = [...loadCommands.stdout.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset/g)].map(match => match[1]);
  assert(rpaths.includes('@executable_path/../Resources/mpv/lib'), 'Bundle must have its own mpv library path');
  assert(rpaths.every(value => !value.startsWith('/') || value.startsWith('/System/') || value.startsWith('/usr/lib/')),
    'Release must not depend on workspace or Homebrew library paths');
  const temporaryRoot = path.join(root, '.tmp');
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const data = fs.mkdtempSync(path.join(temporaryRoot, 'macos-bundle-test-'));
  const env = { ...process.env, MJC_NATIVE_TEST_MODE: '1', MJC_WEBVIEW_DATA: data };
  for (const key of Object.keys(env)) if (key.startsWith('DYLD_')) delete env[key];
  let child;
  try {
    child = spawn(executable, [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
    const ended = new Promise(resolve => {
      child.once('error', error => resolve({ error }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let timer;
    const result = await Promise.race([ended, new Promise(resolve => { timer = setTimeout(() => resolve(null), 8000); })]);
    clearTimeout(timer);
    assert.equal(result, null, `Signed app exited during startup: ${JSON.stringify(result)}\n${stderr}`);
    child.kill('SIGTERM');
    await ended;
    console.log('PASS signed macOS bundle starts with packaged libmpv, no external library paths and an isolated WebView');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    fs.rmSync(data, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
