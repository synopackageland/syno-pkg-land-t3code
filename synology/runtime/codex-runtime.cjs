const fs = require('node:fs');
const path = require('node:path');

function managedHome(base, env) {
  const state = path.join(base, 'userdata');
  const settings = JSON.parse(fs.readFileSync(path.join(state, 'settings.json'), 'utf8'));
  const candidates = Object.entries(settings.providerInstances ?? {}).filter(([, value]) =>
    value.driver === 'codex' && value.enabled !== false &&
    value.config?.enabled !== false && value.config?.setupMode === 'managed');
  const selected = candidates.find(([id]) => id === settings.textGenerationModelSelection?.instanceId);
  const instance = selected ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!instance) throw new Error('managed home unavailable');
  const [id, { config }] = instance;
  const shared = config.homePath?.trim() || path.join(env.HOME, '.codex');
  const home = config.shadowHomePath?.trim() ||
    (id === 'codex' ? shared : path.join(state, 'providers/codex', id, 'shadow'));
  const absolute = path.resolve(home.replace(/^~(?=\/|$)/, env.HOME));
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

function run(args) {
  try {
    const runtime = resolveRuntime();
    if (args[0] === 'exec' && !Object.hasOwn(process.env, 'CODEX_HOME') &&
      runtime.authArgs.length === 0 && !fs.existsSync(path.join(runtime.environment.CODEX_HOME, 'auth.json'))) {
      throw new Error('managed authentication runtime unavailable');
    }
    process.execve(runtime.executable, [runtime.executable, ...runtime.authArgs, ...args], runtime.environment);
  } catch {
    console.error('codex: managed Codex is unavailable; check its setup and active runtime in T3 Code Settings');
    process.exitCode = 127;
  }
}

module.exports = { resolveRuntime, run };
