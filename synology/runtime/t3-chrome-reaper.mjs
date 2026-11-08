// Ends T3 Code's headless Chrome after it has been idle, to give its memory
// back on small NAS models. T3 Code keeps its shared preview browser running
// once started; when the browser exits, T3 Code launches it again on next use.
//
// Idle means, for the whole idle period:
//   - no browser-tab viewer is connected (t3-gate counts /api/preview-stream
//     WebSockets) and no preview request passed through t3-gate, and
//   - T3's Chrome processes used almost no CPU (agents drive Chrome inside
//     the T3 server, which t3-gate cannot see, but driving it costs CPU).
// Only processes whose executable is T3 Code's own chrome-headless-shell are
// considered. Nothing runs between polls; without Chrome a poll is one /proc scan.
import fs from "node:fs";
import path from "node:path";

const CLK_TCK = 100; // Linux USER_HZ; /proc stat times use it on every DSM kernel.

/** Reads /proc: [{pid, ppid, ticks}] for processes running `executableDir`'s Chrome. */
export function scanChrome(executableDir, proc = "/proc") {
  const found = [];
  for (const name of fs.readdirSync(proc)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const exe = fs.readlinkSync(path.join(proc, name, "exe"));
      if (!exe.startsWith(executableDir + "/") || path.basename(exe) !== "chrome-headless-shell") continue;
      // Fields after the parenthesised command: state ppid ... utime(12) stime(13).
      const stat = fs.readFileSync(path.join(proc, name, "stat"), "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      found.push({ pid: Number(name), ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]) });
    } catch {
      // The process exited during the scan, or is not ours to read.
    }
  }
  return found;
}

export function createReaper({
  idleMs,
  busyCpuSecondsPerMinute = 0.5,
  scan,
  kill = (pid, signal) => process.kill(pid, signal),
  now = Date.now,
  log = (line) => console.log(line),
  graceMs = 10_000,
  schedule = (fn, ms) => setTimeout(fn, ms).unref(),
}) {
  let viewers = 0;
  let lastActivity = now();
  let lastTicks = null;
  let lastPoll = now();

  return {
    previewOpened() {
      viewers++;
      lastActivity = now();
    },
    previewClosed() {
      viewers = Math.max(0, viewers - 1);
      lastActivity = now();
    },
    previewRequest() {
      lastActivity = now();
    },
    /** One poll; returns what it did, for tests and logs. */
    poll() {
      const t = now();
      const elapsedMin = Math.max((t - lastPoll) / 60_000, 1 / 60);
      lastPoll = t;
      const chrome = scan();
      if (chrome.length === 0) {
        lastTicks = null;
        return "none";
      }
      const ticks = chrome.reduce((sum, p) => sum + p.ticks, 0);
      // A new or restarted browser counts as activity.
      if (lastTicks === null || ticks < lastTicks) lastActivity = t;
      else if ((ticks - lastTicks) / CLK_TCK / elapsedMin > busyCpuSecondsPerMinute) lastActivity = t;
      lastTicks = ticks;
      if (viewers > 0) lastActivity = t;
      if (t - lastActivity < idleMs) return "active";

      const pids = new Set(chrome.map((p) => p.pid));
      const roots = chrome.filter((p) => !pids.has(p.ppid));
      log(`t3-chrome-reaper: preview idle for ${Math.round((t - lastActivity) / 60_000)} min; ending ${chrome.length} Chrome processes`);
      for (const p of roots) signal(p.pid, "SIGTERM");
      // Only the processes ended here: a browser T3 relaunched meanwhile is in use.
      schedule(() => {
        for (const p of scan()) if (pids.has(p.pid)) signal(p.pid, "SIGKILL");
      }, graceMs);
      lastTicks = null;
      lastActivity = t;
      return "reaped";
    },
  };

  function signal(pid, sig) {
    try {
      kill(pid, sig);
    } catch {
      // Already gone.
    }
  }
}
