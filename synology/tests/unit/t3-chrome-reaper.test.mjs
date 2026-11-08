import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createReaper, scanChrome } from '../../runtime/t3-chrome-reaper.mjs';

const MIN = 60_000;

// A scripted Chrome: processes and their CPU ticks, and a manual clock.
function harness({ idleMs = 10 * MIN } = {}) {
  let t = 0;
  let procs = [];
  const signals = [];
  const scheduled = [];
  const reaper = createReaper({
    idleMs,
    scan: () => procs.map((p) => ({ ...p })),
    kill: (pid, sig) => signals.push([pid, sig]),
    now: () => t,
    log: () => {},
    schedule: (fn) => scheduled.push(fn),
  });
  return {
    reaper,
    signals,
    scheduled,
    set procs(v) { procs = v; },
    advance(ms) { t += ms; },
    tick(pid, by) { procs = procs.map((p) => (p.pid === pid ? { ...p, ticks: p.ticks + by } : p)); },
  };
}

// browser 10 (parent: T3 server 1) with renderer 11 and gpu 12.
const chrome = () => [
  { pid: 10, ppid: 1, ticks: 500 },
  { pid: 11, ppid: 10, ticks: 300 },
  { pid: 12, ppid: 10, ticks: 100 },
];

test('without Chrome a poll does nothing', () => {
  const h = harness();
  h.procs = [];
  h.advance(60 * MIN);
  assert.equal(h.reaper.poll(), 'none');
  assert.deepEqual(h.signals, []);
});

test('an idle Chrome is ended after the idle period: SIGTERM to the browser, then SIGKILL to survivors', () => {
  const h = harness();
  h.procs = chrome();
  assert.equal(h.reaper.poll(), 'active'); // first sight counts as activity
  for (let i = 1; i < 10; i++) {
    h.advance(MIN);
    h.tick(11, 1); // background timers: 0.01 s per minute
    assert.equal(h.reaper.poll(), 'active', `minute ${i}`);
  }
  h.advance(MIN);
  assert.equal(h.reaper.poll(), 'reaped');
  assert.deepEqual(h.signals, [[10, 'SIGTERM']]);

  // The renderer survived the grace period; a browser T3 relaunched meanwhile must not be touched.
  h.procs = [{ pid: 11, ppid: 1, ticks: 301 }, { pid: 20, ppid: 1, ticks: 5 }];
  h.scheduled[0]();
  assert.deepEqual(h.signals, [[10, 'SIGTERM'], [11, 'SIGKILL']]);
});

test('an open browser-tab viewer keeps Chrome running', () => {
  const h = harness();
  h.procs = chrome();
  h.reaper.previewOpened();
  for (let i = 0; i < 30; i++) {
    h.advance(MIN);
    assert.equal(h.reaper.poll(), 'active');
  }
  h.reaper.previewClosed();
  for (let i = 1; i < 10; i++) {
    h.advance(MIN);
    assert.equal(h.reaper.poll(), 'active', `minute ${i} after the viewer left`);
  }
  h.advance(MIN);
  assert.equal(h.reaper.poll(), 'reaped');
});

test('Chrome CPU use (an agent driving the preview) and preview requests count as activity', () => {
  const h = harness();
  h.procs = chrome();
  for (let i = 0; i < 25; i++) {
    h.advance(MIN);
    if (i % 5 === 0) h.tick(10, 200); // 2 s of CPU every 5 minutes
    assert.equal(h.reaper.poll(), 'active', `minute ${i}`);
  }
  for (let i = 0; i < 25; i++) {
    h.advance(MIN);
    if (i % 9 === 0) h.reaper.previewRequest();
    assert.equal(h.reaper.poll(), 'active', `request minute ${i}`);
  }
  assert.deepEqual(h.signals, []);
});

test('a restarted Chrome starts a new idle period', () => {
  const h = harness();
  h.procs = chrome();
  h.advance(9 * MIN);
  h.reaper.poll();
  h.procs = [{ pid: 30, ppid: 1, ticks: 40 }]; // T3 relaunched it
  h.advance(5 * MIN);
  assert.equal(h.reaper.poll(), 'active');
});

test('scanChrome matches only T3 Code\'s own chrome-headless-shell', () => {
  const proc = mkdtempSync(join(tmpdir(), 'proc-'));
  const dir = '/data/home/.t3/tools/chrome-headless-shell';
  const fake = (pid, exe, ppid, utime, stime) => {
    mkdirSync(join(proc, String(pid)));
    symlinkSync(exe, join(proc, String(pid), 'exe'));
    // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime
    writeFileSync(join(proc, String(pid), 'stat'), `${pid} (chrome-headle) S ${ppid} 1 1 0 -1 0 0 0 0 0 ${utime} ${stime} 0 0`);
  };
  fake(10, `${dir}/linux64/156/chrome-headless-shell`, 1, 40, 2);
  fake(11, '/usr/bin/chrome-headless-shell', 1, 9, 9); // not T3's
  fake(12, `${dir}/linux64/156/chrome_crashpad_handler`, 10, 1, 1); // not the browser binary
  fake(13, '/opt/t3/t3', 0, 1, 1);
  mkdirSync(join(proc, 'self'));
  assert.deepEqual(scanChrome(dir, proc), [{ pid: 10, ppid: 1, ticks: 42 }]);
});
