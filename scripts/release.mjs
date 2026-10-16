import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { normalizeVersion, projectRoot, versionPlan, versionFiles } from './release-version.mjs';
import { generateNotes, notesHash, validateNotes } from './release-notes.mjs';

function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0] ?? ''} failed${result.error ? `: ${result.error.message}` : ''}`);
  return capture ? result.stdout.trim() : '';
}
const git = (...args) => run('git', args, true);
const gh = (...args) => run('gh', args, true);
const dispatchWindows = tag => gh('workflow', 'run', 'release-windows.yml', '--ref', tag, '-f', `tag=${tag}`);

function assertSource(head) {
  if (git('status', '--porcelain') || git('rev-parse', 'HEAD') !== head) {
    throw new Error('Source changed during release; inspect before resuming.');
  }
}

function previousReleaseTag(releases, head) {
  const ancestors = new Set(git('tag', '--merged', head).split('\n'));
  return releases.filter(release => !release.draft && !release.prerelease &&
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name) && ancestors.has(release.tag_name))
    .sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''))[0]?.tag_name ?? null;
}

function saveState(file, state) {
  fs.writeFileSync(`${file}.pending`, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(`${file}.pending`, file);
}

try {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20+ is required.');
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    console.log('Usage: ./scripts/release.sh X.Y.Z [--dry-run | --resume]\nCodex notes → version commit/push → macOS build/publication → Windows installer + portable CI.\nRequires codex on PATH and authenticated. --dry-run: local preview only. --resume: continue the same version/HEAD; never replace published assets.');
    process.exit(0);
  }
  const version = normalizeVersion(args[0]);
  const tag = `v${version}`;
  const resume = args.includes('--resume');
  if (args.slice(1).some(arg => !['--dry-run', '--resume'].includes(arg)) || (resume && args.includes('--dry-run'))) throw new Error('Invalid options; see --help.');
  const plan = versionPlan(projectRoot, version);
  if (args.includes('--dry-run')) {
    console.log(`Release ${tag}\nVersion files: ${versionFiles.join(', ')}\nCodex dual-platform notes → version update/commit → atomic branch/tag push → macOS app/DMG + verification → GitHub Release with notes → dispatch Windows installer + portable CI.\nNo files, commits or remote state changed.`);
    process.exit(0);
  }
  if (process.platform !== 'darwin') throw new Error('Run this release entry on macOS.');
  if (process.env.CARGO_TARGET_DIR || process.env.CARGO_BUILD_TARGET) throw new Error('Unset CARGO_TARGET_DIR and CARGO_BUILD_TARGET so release artifacts use the standard path.');
  if (git('status', '--porcelain')) throw new Error('Working tree must be clean. Commit your changes first; user files are never auto-staged.');
  const branch = git('symbolic-ref', '--short', 'HEAD');
  const origin = git('remote', 'get-url', '--push', 'origin');
  if (!/^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)eater-altria\/MyJellyfinClient(?:\.git)?\/?$/.test(origin)) throw new Error('origin push URL must point to eater-altria/MyJellyfinClient on GitHub.');
  run('gh', ['auth', 'status']);
  const repo = JSON.parse(gh('repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'));
  if (repo.nameWithOwner !== 'eater-altria/MyJellyfinClient') throw new Error('origin must identify eater-altria/MyJellyfinClient.');
  if (branch !== repo.defaultBranchRef.name) throw new Error('Release from the repository default branch.');
  git('fetch', 'origin', branch, '--tags');
  if (git('rev-list', '--count', `HEAD..origin/${branch}`) !== '0') throw new Error('Local branch is behind/diverged from origin; synchronize it first.');
  run('pkg-config', ['--exists', 'mpv']);
  run('xcrun', ['--find', 'clang']);
  run('cargo', ['+stable', '--version']);
  const tagExists = git('tag', '--list', tag) === tag;
  if (tagExists && (!resume || git('rev-parse', `${tag}^{commit}`) !== git('rev-parse', 'HEAD'))) throw new Error('Tag already exists; --resume requires its exact HEAD. Tags are never moved.');
  if (resume && plan.some(entry => entry.versions.some(v => v !== version))) throw new Error('--resume requires all version definitions to already match.');
  if (!resume && plan.every(entry => entry.versions.every(v => v === version))) throw new Error('Version already matches; choose a new version or use --resume.');
  if (!resume) {
    const current = plan[0].versions[0];
    if (plan.some(entry => entry.versions.some(v => v !== current))) throw new Error('Current version definitions are inconsistent; repair them first.');
    const previous = normalizeVersion(current).split('.').map(Number);
    const next = version.split('.').map(Number);
    const different = next.findIndex((part, index) => part !== previous[index]);
    if (different < 0 || next[different] < previous[different]) throw new Error('New release version must be greater than the current version.');
  }
  // Query the list rather than interpreting every failed HTTP request as a missing release.
  const releases = JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repo.nameWithOwner}/releases?per_page=100`)).flat();
  const existing = releases.find(release => release.tag_name === tag);
  if (existing && !resume) throw new Error('Release already exists.');
  if (existing && !tagExists) throw new Error('Existing release has no matching local/remote tag.');
  if (existing && !existing.draft) {
    dispatchWindows(tag);
    console.log(`Windows retry dispatched. ${existing.html_url}`);
    process.exit(0);
  }
  const output = path.join(projectRoot, '.tmp/releases', tag);
  const notes = path.join(output, `release-notes-${tag}.md`);
  const stateFile = path.join(output, 'state.json');
  let state;
  if (resume) {
    if (!fs.existsSync(stateFile) || !fs.existsSync(notes)) throw new Error(`Missing saved release notes/state in ${output}; restore the original files before resuming.`);
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    validateNotes(notes, version);
    if (state.version !== version || state.notesSha256 !== notesHash(notes)) throw new Error('Saved release notes/version changed; refusing to publish different notes on resume.');
    const head = git('rev-parse', 'HEAD');
    // Recover interruption after commit but before saving its hash. Accept only the exact version-only commit.
    if (!state.releaseHead) {
      const changed = git('diff-tree', '--no-commit-id', '--name-only', '-r', head).split('\n').sort();
      if (git('rev-parse', 'HEAD^') !== state.sourceHead || git('log', '-1', '--format=%s') !== `chore: release ${tag}` ||
          JSON.stringify(changed) !== JSON.stringify([...versionFiles].sort())) throw new Error('Cannot identify the original version commit; use a new version for changed source.');
      state.releaseHead = head;
      saveState(stateFile, state);
    }
    if (state.releaseHead !== head) throw new Error('--resume requires the original release HEAD; use a new version for changed source.');
  } else {
    const sourceHead = git('rev-parse', 'HEAD');
    const baseTag = previousReleaseTag(releases, sourceHead);
    console.log(`[1/6] Generating ${tag} macOS/Windows release notes with Codex${baseTag ? ` since ${baseTag}` : ''}`);
    generateNotes({ root: projectRoot, output, version, sourceHead, baseTag });
    assertSource(sourceHead);
    state = { version, sourceHead, baseTag, releaseHead: null, notesSha256: notesHash(notes) };
    saveState(stateFile, state);
    console.log(`[2/6] Updating version to ${version}`);
    for (const entry of plan) fs.writeFileSync(path.join(projectRoot, entry.file), entry.after);
    console.log('[3/6] Committing and pushing version files and tag');
    git('add', '--', ...versionFiles);
    run('git', ['commit', '-m', `chore: release ${tag}`, '--', ...versionFiles]);
    state.releaseHead = git('rev-parse', 'HEAD');
    saveState(stateFile, state);
  }
  const head = state.releaseHead;
  assertSource(head);
  if (!tagExists) git('tag', '-a', tag, '-m', `Release ${tag}`, head);
  run('git', ['push', '--atomic', 'origin', `${head}:refs/heads/${branch}`, `refs/tags/${tag}`]);
  console.log(`[4/6] Building macOS ${tag} from pushed commit ${head}`);
  run('bash', ['scripts/build-tauri.sh', '--desktop']);
  run('node', ['scripts/release-version.mjs', '--check', version]);
  assertSource(head);
  const bundle = path.join(projectRoot, 'src-tauri/target/release/bundle');
  const app = path.join(bundle, 'macos/MyJellyfinClient.app');
  const appVersion = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(app, 'Contents/Info.plist')], true);
  if (appVersion !== version) throw new Error('Built App version differs from the release version.');
  run('codesign', ['--verify', '--deep', '--strict', app]);
  run('node', ['scripts/test-macos-bundle.cjs']);
  const arch = run('uname', ['-m'], true);
  const dmg = path.join(bundle, 'dmg', `MyJellyfinClient_${version}_${arch === 'arm64' ? 'aarch64' : 'x64'}.dmg`);
  if (!fs.statSync(dmg).size) throw new Error('DMG is empty.');
  run('hdiutil', ['verify', dmg]);
  const zip = path.join(output, `MyJellyfinClient_${version}_${arch}.app.zip`);
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
  const assets = [zip, dmg];
  for (const asset of [...assets]) {
    const checksum = path.join(output, `${path.basename(asset)}.sha256`);
    fs.writeFileSync(checksum, `${createHash('sha256').update(fs.readFileSync(asset)).digest('hex')}  ${path.basename(asset)}\n`);
    assets.push(checksum);
  }
  assets.push(notes);
  assertSource(head);
  if (notesHash(notes) !== state.notesSha256) throw new Error('Release notes changed during build; refusing to publish.');
  if (!existing) gh('release', 'create', tag, '--repo', repo.nameWithOwner, '--verify-tag', '--draft', '--title', tag, '--notes-file', notes);
  else gh('release', 'edit', tag, '--repo', repo.nameWithOwner, '--notes-file', notes);
  // Only a draft can have incomplete assets replaced during explicit recovery.
  gh('release', 'upload', tag, ...assets, '--repo', repo.nameWithOwner, ...(resume ? ['--clobber'] : []));
  const draft = JSON.parse(gh('release', 'view', tag, '--repo', repo.nameWithOwner, '--json', 'assets'));
  for (const asset of assets) {
    if (!draft.assets.some(remote => remote.name === path.basename(asset) && remote.size === fs.statSync(asset).size)) throw new Error(`Upload verification failed: ${path.basename(asset)}`);
  }
  gh('release', 'edit', tag, '--repo', repo.nameWithOwner, '--draft=false');
  const release = JSON.parse(gh('release', 'view', tag, '--repo', repo.nameWithOwner, '--json', 'isDraft,url'));
  if (release.isDraft) throw new Error('Release is still a draft.');
  console.log(`macOS published: ${release.url}\n[5/6] Dispatching Windows build`);
  dispatchWindows(tag);
  console.log(`[6/6] Windows CI will append installer + portable EXEs and SHA-256 files. Follow https://github.com/${repo.nameWithOwner}/actions/workflows/release-windows.yml`);
} catch (error) {
  console.error(`Release stopped: ${error.message}\nAfter a version commit, fix the cause and use the same version/HEAD with --resume. Before a version commit, inspect local changes and rerun normally. Pushed commits/tags and saved notes are retained.`);
  process.exitCode = 1;
}
