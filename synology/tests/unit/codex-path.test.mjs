import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const { resolveRuntime } = createRequire(import.meta.url)('../../runtime/codex-runtime.cjs');

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'codex-path-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const base = join(home, '.t3/tools/codex');
  const bin = join(home, 'wrapper');
  mkdirSync(base, { recursive: true });
  mkdirSync(bin);
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  const state = join(home, '.t3/userdata');
  const shadow = join(state, 'providers/codex/personal/shadow');
  mkdirSync(shadow, { recursive: true });
  writeFileSync(join(shadow, 'auth.json'), '{}');
  writeFileSync(join(state, 'settings.json'), JSON.stringify({
    providerInstances: {
      personal: { driver: 'codex', enabled: true, config: { setupMode: 'managed' } },
    },
  }));
  symlinkSync(resolve('runtime/codex'), join(bin, 'codex'));
  symlinkSync(process.execPath, join(bin, 'node'));
  const runtimePath = /    PATH=(\S+) \\/.exec(readFileSync('runtime/Dockerfile', 'utf8'))[1]
    .replaceAll('/data/home', home).replace('/opt/synology/bin', bin);
  const env = { ...process.env, HOME: home, T3CODE_HOME: join(home, '.t3'), PATH: runtimePath };
  delete env.CODEX_HOME;
  const active = (version) => writeFileSync(join(base, 'active.json'), JSON.stringify({ version }));
  const install = (version, status = 0) => {
    const dir = join(base, version, 'bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'codex'), `#!/bin/bash\nif [ "\${1:-}" = --print-home ]; then printf '%s\\n' "\${CODEX_HOME-unset}"; else printf '%s\\n' '${version}' "$@"; fi\nexit ${status}\n`, { mode: 0o755 });
  };
  const run = (...args) => spawnSync('codex', args, { env, encoding: 'utf8' });
  return { home, shadow, env, active, install, run };
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
  writeFileSync(join(f.home, '.local/bin/codex'), '#!/bin/sh\nprintf "user-installed:%s\\n" "${CODEX_HOME-unset}"\n', { mode: 0o755 });
  const result = f.run('--version');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'user-installed:unset\n');
});

test('CODEX_HOME defaults to the managed shadow home and preserves an explicit value', (t) => {
  const f = fixture(t);
  f.install('0.166.0');
  f.active('0.166.0');
  let result = f.run('--print-home');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${f.shadow}\n`);
  for (const home of [join(f.home, 'explicit home'), '']) {
    f.env.CODEX_HOME = home;
    result = f.run('--print-home');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${home}\n`);
  }
});

test('only reuses the existing managed auth command for the matching app-server home', (t) => {
  const f = fixture(t);
  f.install('0.166.0');
  f.active('0.166.0');
  const proc = join(f.home, 'proc');
  const executable = join(f.home, '.t3/tools/codex/0.166.0/bin/codex');
  const provider = 'model_provider="openai_token_sharing"';
  const auth = 'model_providers.openai_token_sharing={auth={command="t3",args=["__managed-chatgpt-token","existing-socket","personal"]}}';
  const features = ['features.api_key_model_discovery=true', 'features.multi_agent=false', 'features.multi_agent_v2=false'];
  for (const [pid, home] of [['10', f.shadow], ['20', f.home]]) {
    const dir = join(proc, pid);
    mkdirSync(dir, { recursive: true });
    symlinkSync(executable, join(dir, 'exe'));
    writeFileSync(join(dir, 'environ'), `CODEX_HOME=${home}\0`);
    writeFileSync(join(dir, 'cmdline'), ['codex', 'app-server', '-c', provider, '-c',
      pid === '10' ? auth : auth.replace('personal', 'other'), ...features.flatMap((value) => ['-c', value]),
      '-c', 'unrelated=value', ''].join('\0'));
  }
  const runtime = resolveRuntime(f.env, proc);
  assert.equal(runtime.environment.CODEX_HOME, f.shadow);
  assert.deepEqual(runtime.authArgs, ['-c', provider, '-c', auth, ...features.flatMap((value) => ['-c', value])]);
  f.env.CODEX_HOME = f.home;
  assert.deepEqual(resolveRuntime(f.env, proc).authArgs, []);
  delete f.env.CODEX_HOME;
  rmSync(join(proc, '10'), { recursive: true });
  assert.deepEqual(resolveRuntime(f.env, proc).authArgs, []);
});
