import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { cli } from '../support/cli.mjs';

// Explicit local build tier; no deployment or NAS connection.
test('the App checks, builds and passes package inspection', {timeout: 300_000}, () => {
  cli('check');
  const built = cli('build', '--arch', process.env.APP_TEST_ARCH || 'x86_64');
  assert.ok(built.outputs.length > 0);
  for (const spk of built.outputs) {
    assert.equal(existsSync(spk), true);
    const inspected = cli('inspect', spk);
    assert.equal(inspected.spk, spk);
  }
});
