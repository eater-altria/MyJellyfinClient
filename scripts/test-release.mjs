import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeVersion, projectRoot, versionPlan, versionFiles } from './release-version.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mjc-release-test-'));
try {
  for (const file of versionFiles) {
    const destination = path.join(temporary, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(projectRoot, file), destination);
  }
  for (const input of ['1.2.3', 'v1.2.3', '0.0.1', '65535.1.0']) assert.equal(normalizeVersion(input), input.replace(/^v/, ''));
  for (const input of ['01.2.3', '1.2', '1.2.3-beta', '1.2.3+build', '65536.0.0', '../1.2.3', '1.2.3;exit', undefined]) assert.throws(() => normalizeVersion(input));
  const originalLock = JSON.parse(fs.readFileSync(path.join(temporary, 'package-lock.json')));
  const originalCargo = fs.readFileSync(path.join(temporary, 'src-tauri/Cargo.lock'), 'utf8');
  const plan = versionPlan(temporary, 'v1.2.3');
  for (const entry of plan) fs.writeFileSync(path.join(temporary, entry.file), entry.after);
  assert.ok(versionPlan(temporary, '1.2.3').every(entry => entry.versions.every(v => v === '1.2.3') && entry.before === entry.after));
  const updatedLock = JSON.parse(fs.readFileSync(path.join(temporary, 'package-lock.json')));
  delete updatedLock.version;
  delete updatedLock.packages[''].version;
  delete originalLock.version;
  delete originalLock.packages[''].version;
  assert.deepEqual(updatedLock, originalLock, 'dependency lock data is unchanged');
  const updatedCargo = fs.readFileSync(path.join(temporary, 'src-tauri/Cargo.lock'), 'utf8');
  assert.equal(updatedCargo.replace('name = "my-jellyfin-client"\nversion = "1.2.3"', `name = "my-jellyfin-client"\nversion = "${plan[4].versions[0]}"`), originalCargo);
  for (const newline of ['\n', '\r\n']) {
    for (const entry of plan.filter(entry => entry.file.startsWith('src-tauri/Cargo.'))) {
      fs.writeFileSync(path.join(temporary, entry.file), entry.after.replace(/\r?\n/g, newline));
    }
    const changed = versionPlan(temporary, '1.2.4');
    for (const entry of changed.filter(entry => entry.file.startsWith('src-tauri/Cargo.'))) {
      assert.deepEqual(entry.versions, ['1.2.3']);
      assert.equal(entry.after.replace(`name = "my-jellyfin-client"${newline}version = "1.2.4"`,
        `name = "my-jellyfin-client"${newline}version = "1.2.3"`), entry.before,
        'only the application version changes; Cargo dependency data and line endings are preserved');
      fs.writeFileSync(path.join(temporary, entry.file), entry.after);
    }
    assert.ok(versionPlan(temporary, '1.2.4').filter(entry => entry.file.startsWith('src-tauri/Cargo.'))
      .every(entry => entry.versions[0] === '1.2.4' && entry.before === entry.after));
  }
  fs.writeFileSync(path.join(temporary, 'src-tauri/Cargo.lock'), 'invalid lock');
  assert.throws(() => versionPlan(temporary, '1.2.4'), /Missing application version/);
  const before = versionFiles.map(file => fs.readFileSync(path.join(projectRoot, file), 'utf8'));
  const preview = spawnSync('bash', ['scripts/release.sh', '1.2.3', '--dry-run'], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /No files, commits or remote state changed/);
  assert.deepEqual(versionFiles.map(file => fs.readFileSync(path.join(projectRoot, file), 'utf8')), before);
  if (process.platform === 'darwin') {
    // Real local Git commits/tags; external commands are isolated fixtures, never real uploads/builds.
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    const commands = path.join(temporary, 'commands');
    fs.mkdirSync(commands);
    const commandSource = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.mkdirSync('.tmp', {recursive:true});
fs.appendFileSync('.tmp/commands.jsonl', JSON.stringify([command, ...args]) + '\\n');
const realGit = ${JSON.stringify(realGit)};
if (command === 'cargo') {
  // Homebrew Cargo rejects +toolchain; rustup requires the Mac override in this repository.
  if (JSON.stringify(args) !== '["--version"]' || process.env.RUSTUP_TOOLCHAIN !== 'stable') process.exit(8);
  if (process.env.MJC_FIXTURE_FAIL_CARGO) process.exit(7);
}
if (command === 'git') {
  if (args[0] === 'remote') { console.log('https://github.com/eater-altria/MyJellyfinClient.git'); process.exit(0); }
  if (args[0] === 'fetch') process.exit(0);
  if (args[0] === 'push') {
    if (process.env.MJC_FIXTURE_FAIL_PUSH) process.exit(7);
    const run = spawnSync(realGit, ['update-ref','refs/remotes/origin/main','HEAD'], {stdio:'inherit'});
    process.exit(run.status);
  }
  const run = spawnSync(realGit, args, {stdio:'inherit'});
  process.exit(run.status);
}
const stateFile = '.tmp/github.json';
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : null;
if (command === 'gh') {
  if (args[0] === 'repo') console.log(JSON.stringify({nameWithOwner:'eater-altria/MyJellyfinClient',defaultBranchRef:{name:'main'}}));
  if (args[0] === 'api') console.log(JSON.stringify([[{tag_name:'v0.1.0',draft:false,prerelease:false,published_at:'2026-01-01'},...(state?[state]:[])]]));
  if (args[0] === 'workflow' && process.env.MJC_FIXTURE_FAIL_DISPATCH) process.exit(7);
  if (args[0] === 'release') {
    if (args[1] === 'create') {
      fs.writeFileSync(stateFile,JSON.stringify({tag_name:args[2],draft:true,assets:[],body:fs.readFileSync(args[args.indexOf('--notes-file')+1],'utf8'),html_url:'https://example.test/release'}));
    }
    if (args[1] === 'upload') {
      if (process.env.MJC_FIXTURE_FAIL_UPLOAD) process.exit(7);
      state.assets=args.slice(3,args.indexOf('--repo')).map(file=>({name:path.basename(file),size:fs.statSync(file).size}));
      fs.writeFileSync(stateFile,JSON.stringify(state));
    }
    if (args[1] === 'edit') {
      if(args.includes('--draft=false'))state.draft=false;
      if(args.includes('--notes-file'))state.body=fs.readFileSync(args[args.indexOf('--notes-file')+1],'utf8');
      fs.writeFileSync(stateFile,JSON.stringify(state));
    }
    if (args[1] === 'view') console.log(JSON.stringify({assets:state.assets,isDraft:state.draft,url:state.html_url}));
  }
}
if (command === 'codex') {
  const prompt=fs.readFileSync(0,'utf8');
  fs.writeFileSync('.tmp/prompt.txt',prompt);
  fs.writeFileSync('.tmp/version-at-codex.txt',JSON.parse(fs.readFileSync('package.json')).version);
  if(process.env.MJC_FIXTURE_FAIL_CODEX) process.exit(7);
  if(process.env.MJC_FIXTURE_DIRTY_CODEX) fs.appendFileSync('README.md','unexpected change');
  const notes='# MyJellyfinClient v1.2.3\\n\\n更新摘要：根据已提交的代码生成的双端发布文档，保留实际实现和平台差异。\\n\\n## macOS\\n\\n提供 DMG 和 App ZIP，当前只验证 Apple Silicon 和 SDR，本地签名不等于公证。\\n\\n## Windows\\n\\n提供 x64 安装版与单 EXE 便携版，Windows 构建将在发布后追加。\\n';
  fs.writeFileSync(args[args.indexOf('--output-last-message')+1], process.env.MJC_FIXTURE_EMPTY_CODEX?'':notes);
}
if (command === 'bash') {
  if (process.env.RUSTUP_TOOLCHAIN !== 'stable') process.exit(8);
  if (process.env.MJC_FIXTURE_FAIL_BUILD) process.exit(7);
  const version=JSON.parse(fs.readFileSync('package.json')).version;
  const bundle='src-tauri/target/release/bundle';
  fs.mkdirSync(bundle+'/macos/MyJellyfinClient.app/Contents',{recursive:true});
  fs.writeFileSync(bundle+'/macos/MyJellyfinClient.app/Contents/Info.plist','<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>'+version+'</string></dict></plist>');
  fs.mkdirSync(bundle+'/dmg',{recursive:true});
  fs.writeFileSync(bundle+'/dmg/MyJellyfinClient_'+version+'_aarch64.dmg','fixture dmg');
}
if (command === 'uname') console.log('arm64');
if (command === 'ditto') fs.writeFileSync(args.at(-1),'fixture app zip');
`;
    for (const command of ['git', 'gh', 'codex', 'pkg-config', 'xcrun', 'cargo', 'bash', 'codesign', 'hdiutil', 'uname', 'ditto']) {
      fs.writeFileSync(path.join(commands, command), commandSource, { mode: 0o755 });
    }
    // Make the extensionless command fixtures ESM independently of the fixture repository.
    fs.writeFileSync(path.join(temporary, 'package.json'), '{"type":"module"}');
    const env = { ...process.env, PATH: `${commands}:${process.env.PATH}`, RUSTUP_TOOLCHAIN: 'stable-x86_64-pc-windows-msvc' };
    delete env.CARGO_TARGET_DIR;
    delete env.CARGO_BUILD_TARGET;
    let count = 0;
    function setup() {
      const fixture = path.join(temporary, `flow-${count++}`);
      for (const file of [...versionFiles, 'scripts/release.mjs', 'scripts/release-version.mjs', 'scripts/release-notes.mjs']) {
        const destination = path.join(fixture, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(projectRoot, file), destination);
      }
      fs.writeFileSync(path.join(fixture, '.gitignore'), '.tmp/\nsrc-tauri/target/\n');
      fs.writeFileSync(path.join(fixture, 'README.md'), 'fixture source');
      fs.writeFileSync(path.join(fixture, 'scripts/test-macos-bundle.cjs'), 'process.exit(0);\n');
      const git = (...args) => {
        const result = spawnSync(realGit, args, { cwd: fixture, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git('init', '-b', 'main');
      git('config', 'user.name', 'Release fixture');
      git('config', 'user.email', 'fixture@example.invalid');
      git('config', 'commit.gpgsign', 'false');
      git('config', 'tag.gpgsign', 'false');
      git('add', '.');
      git('commit', '-m', 'fixture source');
      git('tag', 'v0.1.0');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      const execute = (resume = false, extra = {}) => spawnSync(process.execPath,
        ['scripts/release.mjs', '1.2.3', ...(resume ? ['--resume'] : [])],
        { cwd: fixture, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
      const calls = () => fs.readFileSync(path.join(fixture, '.tmp/commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      const clear = () => fs.writeFileSync(path.join(fixture, '.tmp/commands.jsonl'), '');
      return { fixture, git, execute, calls, clear };
    }
    const releaseCall = calls => calls.some(call => call[0] === 'gh' && ['release', 'workflow'].includes(call[1]));
    const cargoFailure = setup();
    const cargoHead = cargoFailure.git('rev-parse', 'HEAD');
    assert.equal(cargoFailure.execute(false, { MJC_FIXTURE_FAIL_CARGO: '1' }).status, 1);
    assert.equal(cargoFailure.git('rev-parse', 'HEAD'), cargoHead);
    assert.equal(cargoFailure.git('status', '--porcelain'), '');
    assert.ok(!cargoFailure.calls().some(call => call[0] === 'codex' || call[0] === 'bash' ||
      (call[0] === 'git' && ['push', 'commit'].includes(call[1]))));
    assert.ok(!releaseCall(cargoFailure.calls()));
    for (const failure of ['MJC_FIXTURE_FAIL_CODEX', 'MJC_FIXTURE_EMPTY_CODEX', 'MJC_FIXTURE_DIRTY_CODEX']) {
      const test = setup();
      const head = test.git('rev-parse', 'HEAD');
      const failed = test.execute(false, { [failure]: '1' });
      assert.equal(failed.status, 1, failed.stdout);
      assert.equal(test.git('rev-parse', 'HEAD'), head);
      assert.equal(JSON.parse(fs.readFileSync(path.join(test.fixture, 'package.json'))).version, JSON.parse(before[0]).version);
      assert.ok(!test.calls().some(call => call[0] === 'git' && ['push', 'commit'].includes(call[1])));
      assert.ok(!releaseCall(test.calls()));
    }
    console.log('PASS failed/empty Codex output and source mutation stop before version changes, commits or publication');
    for (const failure of ['MJC_FIXTURE_FAIL_PUSH', 'MJC_FIXTURE_FAIL_BUILD', 'MJC_FIXTURE_FAIL_UPLOAD', 'MJC_FIXTURE_FAIL_DISPATCH']) {
      const test = setup();
      const failed = test.execute(false, { [failure]: '1' });
      assert.equal(failed.status, 1, failed.stdout);
      assert.equal(test.git('status', '--porcelain'), '');
      const initialCalls = test.calls();
      const index = (command, action) => initialCalls.findIndex(call => call[0] === command && call[1] === action);
      assert.ok(index('codex', '--ask-for-approval') < index('git', 'commit'));
      assert.ok(index('git', 'commit') < index('git', 'push'));
      assert.ok(initialCalls[index('git', 'push')].includes('--atomic'));
      if (failure === 'MJC_FIXTURE_FAIL_PUSH') assert.equal(index('bash', 'scripts/build-tauri.sh'), -1);
      else assert.ok(index('git', 'push') < index('bash', 'scripts/build-tauri.sh'));
      if (['MJC_FIXTURE_FAIL_PUSH', 'MJC_FIXTURE_FAIL_BUILD'].includes(failure)) assert.ok(!releaseCall(initialCalls));
      const notes = path.join(test.fixture, '.tmp/releases/v1.2.3/release-notes-v1.2.3.md');
      const content = fs.readFileSync(notes, 'utf8');
      assert.equal(fs.readFileSync(path.join(test.fixture, '.tmp/version-at-codex.txt'), 'utf8'), JSON.parse(before[0]).version);
      assert.match(fs.readFileSync(path.join(test.fixture, '.tmp/prompt.txt'), 'utf8'), /v0\.1\.0\.\./);
      const codex = initialCalls.find(call => call[0] === 'codex');
      assert.ok(codex.includes('read-only') && codex.includes('--ephemeral') && codex.includes('never') && codex.at(-1) === '-');
      assert.deepEqual(test.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').sort(), [...versionFiles].sort());
      const releaseHead = test.git('rev-parse', 'HEAD');
      if (failure === 'MJC_FIXTURE_FAIL_PUSH') {
        // Simulate a process interruption between the version commit and state checkpoint.
        const stateFile = path.join(test.fixture, '.tmp/releases/v1.2.3/state.json');
        const state = JSON.parse(fs.readFileSync(stateFile));
        state.releaseHead = null;
        fs.writeFileSync(stateFile, JSON.stringify(state));
      }
      // Detect altered notes or source before any retry can push or upload.
      if (failure === 'MJC_FIXTURE_FAIL_BUILD') {
        const stateFile = path.join(test.fixture, '.tmp/releases/v1.2.3/state.json');
        fs.renameSync(stateFile, `${stateFile}.backup`);
        test.clear();
        assert.equal(test.execute(true).status, 1);
        assert.ok(!releaseCall(test.calls()));
        fs.renameSync(`${stateFile}.backup`, stateFile);
        fs.writeFileSync(notes, content + '\nchanged');
        test.clear();
        assert.equal(test.execute(true).status, 1);
        assert.ok(!test.calls().some(call => call[0] === 'git' && call[1] === 'push'));
        fs.writeFileSync(notes, content);
        test.git('commit', '--allow-empty', '-m', 'unrelated change');
        test.clear();
        assert.equal(test.execute(true).status, 1);
        assert.ok(!releaseCall(test.calls()));
        test.git('reset', '--hard', releaseHead); // Only this isolated fixture repository.
      }
      test.clear();
      const recovered = test.execute(true);
      assert.equal(recovered.status, 0, recovered.stderr);
      const calls = test.calls();
      assert.ok(!calls.some(call => call[0] === 'codex' || (call[0] === 'git' && call[1] === 'commit')));
      assert.equal(test.git('rev-parse', 'HEAD'), releaseHead);
      assert.equal(fs.readFileSync(notes, 'utf8'), content);
      const remote = JSON.parse(fs.readFileSync(path.join(test.fixture, '.tmp/github.json')));
      assert.equal(remote.draft, false);
      assert.equal(remote.body, content);
      assert.deepEqual(remote.assets.map(asset => asset.name).sort(), [
        'release-notes-v1.2.3.md', 'MyJellyfinClient_1.2.3_arm64.app.zip', 'MyJellyfinClient_1.2.3_arm64.app.zip.sha256',
        'MyJellyfinClient_1.2.3_aarch64.dmg', 'MyJellyfinClient_1.2.3_aarch64.dmg.sha256',
      ].sort());
      assert.ok(calls.some(call => call[0] === 'gh' && call[1] === 'workflow' && call.includes('tag=v1.2.3')));
      const publication = calls.findIndex(call => call[0] === 'gh' && call[1] === 'release' && call.includes('--draft=false'));
      const dispatch = calls.findIndex(call => call[0] === 'gh' && call[1] === 'workflow');
      if (failure !== 'MJC_FIXTURE_FAIL_DISPATCH') assert.ok(publication >= 0 && dispatch > publication);
      else assert.ok(!calls.some(call => call[0] === 'bash' || (call[0] === 'gh' && call[1] === 'release')));
      test.clear();
      const published = test.execute(true);
      assert.equal(published.status, 0, published.stderr);
      assert.ok(!test.calls().some(call => call[0] === 'codex' || call[0] === 'bash' || (call[0] === 'gh' && call[1] === 'release') || (call[0] === 'git' && call[1] === 'push')));
    }
    console.log('PASS Codex → version commit → push → macOS build/notes publication → explicit Windows dispatch');
    console.log('PASS standalone Cargo arguments, process-only stable override and Cargo failure before release mutations');
    console.log('PASS push/build/upload/dispatch recovery, original notes and HEAD binding, published retry without asset replacement');
  }
  console.log('PASS release version synchronization, dependency preservation, invalid inputs and nonmutating dry run');
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert(path.basename(temporary).startsWith('mjc-release-test-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
