import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Use the actual CLI and its registered host/session, never a direct HTTP shortcut.
export function cli(...args) {
  const result = JSON.parse(execFileSync('synopkgland', [...args, '--json'], {
    encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  assert.equal(result.ok, true);
  return result.data;
}
