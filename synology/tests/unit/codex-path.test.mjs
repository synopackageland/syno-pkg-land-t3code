import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'codex-path-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const base = join(home, '.t3/tools/codex');
  const bin = join(home, 'wrapper');
  mkdirSync(base, { recursive: true });
  mkdirSync(bin);
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  symlinkSync(resolve('runtime/codex'), join(bin, 'codex'));
  symlinkSync(process.execPath, join(bin, 'node'));
  const runtimePath = /    PATH=(\S+) \\/.exec(readFileSync('runtime/Dockerfile', 'utf8'))[1]
    .replaceAll('/data/home', home).replace('/opt/synology/bin', bin);
  const env = { ...process.env, HOME: home, T3CODE_HOME: join(home, '.t3'), PATH: runtimePath };
  const active = (version) => writeFileSync(join(base, 'active.json'), JSON.stringify({ version }));
  const install = (version, status = 0) => {
    const dir = join(base, version, 'bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'codex'), `#!/bin/bash\nprintf '%s\\n' '${version}' "$@"\nexit ${status}\n`, { mode: 0o755 });
  };
  const run = (...args) => spawnSync('codex', args, { env, encoding: 'utf8' });
  return { home, active, install, run };
}

test('bare codex follows the active managed release and preserves arguments and exit status', (t) => {
  const f = fixture(t);
  f.install('0.166.0');
  f.install('0.167.0', 23);
  f.active('0.166.0');
  let result = f.run('exec', 'a title with spaces', '$(never-run)');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '0.166.0\nexec\na title with spaces\n$(never-run)\n');
  f.active('0.167.0');
  result = f.run('--version');
  assert.equal(result.status, 23, result.stderr);
  assert.equal(result.stdout, '0.167.0\n--version\n');
});

test('missing, invalid and removed active releases fail without selecting another version', (t) => {
  const f = fixture(t);
  f.install('0.166.0');
  for (const version of [undefined, '../0.166.0', '0.167.0']) {
    if (version !== undefined) f.active(version);
    const result = f.run('--version');
    assert.equal(result.status, 127, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /managed Codex is unavailable/);
  }
});

test('a user-installed Codex keeps PATH priority', (t) => {
  const f = fixture(t);
  f.install('0.166.0');
  f.active('0.166.0');
  writeFileSync(join(f.home, '.local/bin/codex'), '#!/bin/sh\necho user-installed\n', { mode: 0o755 });
  const result = f.run('--version');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'user-installed\n');
});
