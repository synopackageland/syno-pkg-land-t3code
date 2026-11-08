// In-container auth adapter in front of T3 Code.
//
// T3 Code has no trusted-proxy mode: every browser must pair once. The DSM
// identity gateway has already admitted a DSM administrator, so this adapter
// turns that admission into T3's own credential: it accepts only requests that
// carry the gateway's per-install key, drops any client credential, and adds
// `Authorization: Bearer <token>` for a long-lived T3 session minted inside the
// container. The token never reaches the browser.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { createReaper, scanChrome } from "./t3-chrome-reaper.mjs";

const [listenHost, listenPort] = (process.env.T3_GATE_LISTEN ?? "0.0.0.0:8080").split(":");
const [upHost, upPort] = (process.env.T3_GATE_UPSTREAM ?? "127.0.0.1:3773").split(":");
const keyHeader = "x-synopkgland-t3-key";
const key = Buffer.from(process.env.T3_GATE_KEY ?? "");
const tokenFile = process.env.T3_GATE_TOKEN_FILE;
// The SDK readiness probe carries no gateway key; this is T3's unauthenticated
// environment descriptor (`/health` is only the SPA fallback page).
const publicPaths = new Set(["/.well-known/t3/environment"]);

const token = () => fs.readFileSync(tokenFile, "utf8").trim();

// Browser tabs stream over /api/preview-stream; see t3-chrome-reaper.mjs.
const previewPrefix = "/api/preview-stream";
const idleMinutes = Number(process.env.T3_CHROME_IDLE_MINUTES ?? 10);
const chromeDir = `${process.env.T3CODE_HOME ?? `${process.env.HOME}/.t3`}/tools/chrome-headless-shell`;
const reaper =
  idleMinutes > 0
    ? createReaper({
        idleMs: idleMinutes * 60_000,
        busyCpuSecondsPerMinute: Number(process.env.T3_CHROME_BUSY_CPU_SECONDS_PER_MINUTE ?? 0.5),
        scan: () => scanChrome(chromeDir),
      })
    : null;
if (reaper) setInterval(() => reaper.poll(), 60_000).unref();
const isPreview = (req) => (req.url ?? "").startsWith(previewPrefix);

function admitted(req) {
  const path = (req.url ?? "/").split("?")[0];
  if (publicPaths.has(path)) return true;
  const got = Buffer.from(String(req.headers[keyHeader] ?? ""));
  return key.length >= 32 && got.length === key.length && crypto.timingSafeEqual(got, key);
}

function upstreamHeaders(req) {
  const headers = { ...req.headers };
  delete headers[keyHeader];
  delete headers.authorization;
  // A T3 session cookie outranks the bearer and a rejected one never falls back.
  if (headers.cookie) {
    const kept = headers.cookie
      .split(/;\s*/)
      .filter((c) => c && !/^t3_session/i.test(c));
    if (kept.length) headers.cookie = kept.join("; ");
    else delete headers.cookie;
  }
  const path = (req.url ?? "/").split("?")[0];
  if (!publicPaths.has(path)) headers.authorization = `Bearer ${token()}`;
  return headers;
}

const server = http.createServer((req, res) => {
  if (!admitted(req)) {
    res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized\n");
    return;
  }
  if (reaper && isPreview(req)) reaper.previewRequest();
  const up = http.request(
    { host: upHost, port: upPort, method: req.method, path: req.url, headers: upstreamHeaders(req) },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.rawHeaders);
      upRes.pipe(res);
    },
  );
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502).end();
    else res.destroy();
  });
  req.pipe(up);
});

server.on("upgrade", (req, socket, head) => {
  if (!admitted(req)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
    return;
  }
  if (reaper && isPreview(req)) {
    reaper.previewOpened();
    socket.once("close", () => reaper.previewClosed());
  }
  const up = net.connect(+upPort, upHost, () => {
    const headers = upstreamHeaders(req);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      for (const one of Array.isArray(v) ? v : [v]) raw += `${k}: ${one}\r\n`;
    }
    up.write(raw + "\r\n");
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(+listenPort, listenHost, () => console.log(`t3-gate listening on ${listenHost}:${listenPort}`));
