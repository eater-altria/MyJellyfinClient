import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const versionFiles = ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function normalizeVersion(value) {
  const version = value?.replace(/^v/, '');
  // Stable releases only; also compatible with Windows installer version fields.
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '') ||
      version.split('.').some(part => Number(part) > 65535)) {
    throw new Error('Version must be X.Y.Z (each component 0–65535), optionally prefixed with v.');
  }
  return version;
}

export function versionPlan(root, value) {
  const version = normalizeVersion(value);
  return versionFiles.map(file => {
    const before = fs.readFileSync(path.join(root, file), 'utf8');
    let after;
    let versions;
    if (file.endsWith('.json')) {
      const data = JSON.parse(before);
      versions = [data.version];
      data.version = version;
      if (file === 'package-lock.json') {
        versions.push(data.packages[''].version);
        data.packages[''].version = version;
      }
      after = `${JSON.stringify(data, null, 2)}\n`;
    } else {
      const pattern = file.endsWith('Cargo.toml')
        ? /(\[package\][\s\S]*?\nversion = ")([^"]+)(")/
        : /(\[\[package\]\]\nname = "my-jellyfin-client"\nversion = ")([^"]+)(")/;
      const match = before.match(pattern);
      if (!match) throw new Error(`Missing application version in ${file}`);
      versions = [match[2]];
      after = before.replace(pattern, (_, prefix, old, suffix) => `${prefix}${version}${suffix}`);
    }
    return { file, before, after, versions };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, value] = process.argv.slice(2);
    if (!['--check', '--set'].includes(mode) || process.argv.length !== 4) throw new Error('Usage: node scripts/release-version.mjs --check|--set X.Y.Z');
    const plan = versionPlan(projectRoot, value);
    if (mode === '--check') {
      if (plan.some(entry => entry.versions.some(version => version !== normalizeVersion(value)))) throw new Error('Application versions do not match the release tag.');
    } else {
      for (const entry of plan) fs.writeFileSync(path.join(projectRoot, entry.file), entry.after);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
