#!/usr/bin/env python3
"""Stage only libmpv's Mach-O dependency graph, never Homebrew profiles/caches."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / '.tmp' / 'macos-runtime'

def run(*args):
    return subprocess.check_output(args, text=True).strip()

def dependencies(path):
    # The first entry is the dylib's own install name, not a dependency.
    return [line.strip().split(' (compatibility version', 1)[0]
            for line in run('otool', '-L', str(path)).splitlines()[2:]]

def resolve(name, parent):
    if name.startswith(('/usr/lib/', '/System/Library/')):
        return None
    if name.startswith('@loader_path/'):
        return (parent.parent / name[len('@loader_path/'):]).resolve(strict=True)
    if name.startswith('@rpath/'):
        leaf = name[len('@rpath/'):]
        candidates = [parent.parent / leaf]
        lines = run('otool', '-l', str(parent)).splitlines()
        for i, line in enumerate(lines):
            if line.strip() == 'cmd LC_RPATH':
                for entry in lines[i+1:i+5]:
                    if entry.strip().startswith('path '):
                        prefix = entry.strip()[5:].split(' (offset ', 1)[0]
                        prefix = prefix.replace('@loader_path', str(parent.parent))
                        candidates.append(Path(prefix) / leaf)
        for candidate in candidates:
            if candidate.is_file(): return candidate.resolve(strict=True)
        raise RuntimeError(f'Cannot resolve runtime dependency: {name}')
    if not name.startswith('/'):
        raise RuntimeError(f'Unsupported runtime dependency: {name}')
    return Path(name).resolve(strict=True)

def main():
    if sys.platform != 'darwin': raise RuntimeError('macOS runtime staging requires macOS')
    libdir = Path(run('pkg-config', '--variable=libdir', 'mpv'))
    libmpv = (libdir / 'libmpv.dylib').resolve(strict=True)
    pending = [libmpv]
    graph = {}
    names = {}
    arch = platform.machine()
    while pending:
        source = pending.pop()
        if source in graph: continue
        if arch not in run('lipo', '-archs', str(source)).split():
            raise RuntimeError(f'Wrong architecture for runtime library: {source.name}')
        if source.name in names and names[source.name] != source:
            if hashlib.sha256(source.read_bytes()).digest() != hashlib.sha256(names[source.name].read_bytes()).digest():
                raise RuntimeError(f'Conflicting runtime library name: {source.name}')
        names[source.name] = source
        edges = []
        for name in dependencies(source):
            target = resolve(name, source)
            if target is not None:
                edges.append((name, target))
                pending.append(target)
        graph[source] = edges
    fingerprint = {str(source): [source.stat().st_size, source.stat().st_mtime_ns] for source in sorted(graph)}
    # A Tahoe Homebrew bottle must not be advertised as a macOS 14 binary.
    # Derive the package/deployment minimum from every library in the graph.
    versions = [(14, 0)]
    for source in graph:
        output = run('xcrun', 'vtool', '-show-build', str(source))
        for value in re.findall(r'\bminos\s+([0-9.]+)', output):
            versions.append(tuple(map(int, value.split('.'))))
    minimum = '.'.join(map(str, max(versions)))
    target_config = ROOT / '.tmp' / 'macos-build-config.json'
    target_config.parent.mkdir(parents=True, exist_ok=True)
    config_text = json.dumps({'bundle': {'macOS': {'minimumSystemVersion': minimum}}}, indent=2) + '\n'
    if not target_config.is_file() or target_config.read_text() != config_text:
        target_config.write_text(config_text)
    manifest = OUTPUT / 'runtime-manifest.json'
    if manifest.is_file() and json.loads(manifest.read_text()) == fingerprint and all((OUTPUT / source.name).is_file() for source in graph):
        for source in graph: (OUTPUT / source.name).chmod(0o755)
        alias = OUTPUT / 'libmpv.dylib'
        if not alias.exists(): alias.symlink_to(libmpv.name)
        print(f'Using staged macOS libmpv runtime ({len(names)} libraries, minimum macOS {minimum}).')
        return
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='macos-runtime-stage-', dir=OUTPUT.parent))
    backup = OUTPUT.with_name('macos-runtime-previous')
    try:
        for name, source in names.items():
            shutil.copy2(source, staging / name)
            # Tauri refreshes these generated copies on subsequent builds.
            # Homebrew bottles are read-only; preserving that mode prevents refresh.
            (staging / name).chmod(0o755)
        for source, edges in graph.items():
            destination = staging / source.name
            command = ['install_name_tool', '-id', '@rpath/' + source.name]
            for old, target in edges:
                command += ['-change', old, '@loader_path/' + target.name]
            subprocess.run(command + [str(destination)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            # install_name_tool invalidates the bottle's original Mach-O signature.
            subprocess.run(['codesign', '--force', '--sign', '-', str(destination)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        (staging / 'runtime-manifest.json').write_text(json.dumps(fingerprint, sort_keys=True, indent=2) + '\n')
        (staging / 'libmpv.dylib').symlink_to(libmpv.name)
        if backup.exists(): shutil.rmtree(backup)
        if OUTPUT.exists(): OUTPUT.rename(backup)
        try:
            staging.rename(OUTPUT)
        except Exception:
            if backup.exists(): backup.rename(OUTPUT)
            raise
        if backup.exists(): shutil.rmtree(backup)
        print(f'Staged macOS libmpv runtime ({len(names)} libraries, {arch}).')
    finally:
        if staging.exists(): shutil.rmtree(staging)

if __name__ == '__main__':
    try: main()
    except (RuntimeError, subprocess.CalledProcessError, OSError, ValueError) as error:
        print(f'macOS runtime preparation failed: {error}', file=sys.stderr)
        sys.exit(1)
