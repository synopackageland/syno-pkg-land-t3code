// Build the SPKs offline: image metadata comes from the OCI archive whose
// digest compose.image.yaml pins, so no registry access is needed. The SDK
// still verifies every SHA-256, the repository and the platform.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// Usage: node scripts/offline-build.mjs [synology dir]
const root = resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname);
const archive = resolve(root, ".build/runtime.oci.tar");
const blob = (d) => execFileSync("tar", ["-xOf", archive, `blobs/sha256/${d.slice(7)}`], { maxBuffer: 64 << 20 });
const image = JSON.parse(readFileSync(resolve(root, "compose.image.yaml"), "utf8")).services.t3code.image;
const top = JSON.parse(execFileSync("tar", ["-xOf", archive, "index.json"])).manifests[0].digest;
if (!image.endsWith("@" + top)) throw new Error(`compose.image.yaml does not pin the archive (${top})`);
const indexBytes = blob(top);
if ("sha256:" + createHash("sha256").update(indexBytes).digest("hex") !== top) throw new Error("index digest");
const index = JSON.parse(indexBytes);
const repo = image.split("@")[0].replace(/:[^/:]+$/, "");
const proofs = {};
for (const [arch, platform] of [["x86_64", "amd64"], ["aarch64", "arm64"]]) {
  const m = index.manifests.find((x) => x.platform?.os === "linux" && x.platform?.architecture === platform);
  const manifest = blob(m.digest);
  const config = blob(JSON.parse(manifest).config.digest);
  proofs[arch] = { [image]: { reference: `${repo}@${m.digest}`, manifest: manifest.toString("base64"), config: config.toString("base64"), index: indexBytes.toString("base64") } };
}
const { buildStandalone } = await import(resolve(root, "node_modules/@synopackageland/cli/dist/standalone/build.js"));
const result = await buildStandalone({ root, composeImageProofsByArch: proofs });
console.log(JSON.stringify(result));
