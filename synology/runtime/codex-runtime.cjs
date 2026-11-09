const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function managedInstances(base) {
  const settings = JSON.parse(fs.readFileSync(path.join(base, 'userdata/settings.json'), 'utf8'));
  const candidates = Object.entries(settings.providerInstances ?? {}).filter(([, value]) =>
    value.driver === 'codex' && value.enabled !== false &&
    value.config?.enabled !== false && value.config?.setupMode === 'managed');
  return { settings, candidates };
}

function homePaths(base, env, id, config) {
  const absolute = (value) => path.resolve(value.replace(/^~(?=\/|$)/, env.HOME));
  const shared = absolute(config.homePath?.trim() || path.join(env.HOME, '.codex'));
  const shadow = absolute(config.shadowHomePath?.trim() ||
    (id === 'codex' ? shared : path.join(base, 'userdata/providers/codex', id, 'shadow')));
  return { shared, shadow };
}

function prepareManagedHomes(env = process.env) {
  const base = env.T3CODE_HOME || path.join(env.HOME, '.t3');
  if (!fs.existsSync(path.join(base, 'userdata/settings.json'))) return;
  for (const [id, { config }] of managedInstances(base).candidates) {
    const { shared, shadow } = homePaths(base, env, id, config);
    if (shared === shadow || !fs.existsSync(shadow)) continue;
    const source = path.join(shared, '.sandbox_migration');
    const target = path.join(shadow, '.sandbox_migration');
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink() && path.resolve(shadow, fs.readlinkSync(target)) === source) continue;
    if (fs.statSync(shadow).uid !== process.getuid()) throw new Error('migration marker home ownership mismatch');
    if (existing) {
      const original = fs.lstatSync(source, { throwIfNoEntry: false });
      if (!existing.isFile() || existing.uid !== process.getuid() || existing.size > 64 ||
          !original?.isFile() || original.uid !== process.getuid() || original.size !== existing.size ||
          !fs.readFileSync(target).equals(fs.readFileSync(source))) {
        throw new Error('migration marker differs from shared home');
      }
    }
    // Codex writes this marker in both homes; T3 requires shared entries to be links.
    const temporary = path.join(shadow, `.sandbox_migration-${randomUUID()}`);
    try {
      fs.symlinkSync(source, temporary);
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}

function managedHome(base, env) {
  const { settings, candidates } = managedInstances(base);
  const selected = candidates.find(([id]) => id === settings.textGenerationModelSelection?.instanceId);
  const instance = selected ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!instance) throw new Error('managed home unavailable');
  const [id, { config }] = instance;
  const { shadow: absolute } = homePaths(base, env, id, config);
  if (!fs.statSync(absolute).isDirectory()) throw new Error('managed home unavailable');
  return absolute;
}

function managedAuthArgs(executable, home, procRoot) {
  // T3 passes its existing token-helper configuration in argv, not in the shadow home.
  for (const pid of fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a))) {
    try {
      const dir = path.join(procRoot, pid);
      if (fs.statSync(dir).uid !== process.getuid() || fs.realpathSync(path.join(dir, 'exe')) !== fs.realpathSync(executable)) continue;
      const argv = fs.readFileSync(path.join(dir, 'cmdline'), 'utf8').split('\0');
      if (!argv.includes('app-server')) continue;
      const environment = fs.readFileSync(path.join(dir, 'environ'), 'utf8').split('\0');
      const activeHome = environment.find((value) => value.startsWith('CODEX_HOME='))?.slice('CODEX_HOME='.length);
      if (!activeHome || fs.realpathSync(activeHome) !== fs.realpathSync(home)) continue;
      const configs = [];
      for (let i = 0; i < argv.length - 1; i++) {
        if (argv[i] === '-c' || argv[i] === '--config') configs.push(argv[++i]);
      }
      const provider = configs.find((value) => /^model_provider="?openai_token_sharing"?$/.test(value));
      const auth = configs.find((value) => value.startsWith('model_providers.openai_token_sharing=') && value.includes('__managed-chatgpt-token'));
      if (provider && auth) {
        const features = configs.filter((value) =>
          value === 'features.api_key_model_discovery=true' ||
          value === 'features.multi_agent=false' || value === 'features.multi_agent_v2=false');
        return [provider, auth, ...features].flatMap((value) => ['-c', value]);
      }
    } catch {
      // Processes may exit while being inspected.
    }
  }
  return [];
}

function resolveRuntime(env = process.env, procRoot = '/proc') {
  const base = env.T3CODE_HOME || path.join(env.HOME, '.t3');
  const root = path.join(base, 'tools/codex');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8'));
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('invalid release');
  const executable = path.join(root, version, 'bin/codex');
  fs.accessSync(executable, fs.constants.X_OK);
  if (Object.hasOwn(env, 'CODEX_HOME')) return { executable, environment: env, authArgs: [] };
  const home = managedHome(base, env);
  return { executable, environment: { ...env, CODEX_HOME: home }, authArgs: managedAuthArgs(executable, home, procRoot) };
}

async function waitForRuntime(args, {
  env = process.env,
  procRoot = '/proc',
  pause = () => new Promise((resolve) => setTimeout(resolve, 1000)),
  now = Date.now,
} = {}) {
  let runtime = resolveRuntime(env, procRoot);
  if (args[0] !== 'exec' || Object.hasOwn(env, 'CODEX_HOME')) return runtime;
  const configured = Number(env.SYNOPKGLAND_STARTUP_BUDGET_SECONDS);
  const budget = Number.isInteger(configured) && configured > 0 && configured <= 900 ? configured : 900;
  const deadline = now() + budget * 1000;
  // A cold main turn may not have started its app-server when title generation begins.
  while (runtime.authArgs.length === 0 && !fs.existsSync(path.join(runtime.environment.CODEX_HOME, 'auth.json'))) {
    if (now() >= deadline) throw new Error('managed authentication runtime unavailable');
    await pause();
    runtime = resolveRuntime(env, procRoot);
  }
  return runtime;
}

async function run(args) {
  try {
    const runtime = await waitForRuntime(args);
    process.execve(runtime.executable, [runtime.executable, ...runtime.authArgs, ...args], runtime.environment);
  } catch {
    console.error('codex: managed Codex is unavailable; check its setup and active runtime in T3 Code Settings');
    process.exitCode = 127;
  }
}

if (require.main === module) prepareManagedHomes();
module.exports = { resolveRuntime, waitForRuntime, prepareManagedHomes, run };
