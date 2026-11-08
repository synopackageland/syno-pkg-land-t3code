# T3 Code for DSM

This folder packages [T3 Code](https://github.com/pingdotgg/t3code), a minimal
web GUI for coding agents, as a Synology DSM package. Everything here is ours;
files outside `synology/` are upstream's and are never edited.

- **Maintainer:** T3 Tools (upstream). **Distributor:** Syno Package Land.
- **Version:** `<upstream version>-<build>`, for example `0.1.7-0001`. The
  build restarts at 1 with every upstream release.
- **Requires:** DSM 7.2.1 or later, Container Manager, an x86_64 or aarch64 NAS.
  Plan for about 1 GB of RAM for T3 Code and the agents you run.

## Using T3 Code

Open **T3 Code** from the DSM main menu as an administrator. The first time,
T3 Code's setup wizard asks you to connect agents and add a project.

### Install an agent

The package installs no agent. Install the ones you want from T3 Code itself;
they go into the App's own storage, survive package upgrades, and you update
them whenever you like.

- In the setup wizard or **Settings → Providers**, an agent that is not
  installed shows **Install**. It opens T3 Code's terminal with the agent's
  install command filled in; press Enter to run it.
- You can also open a terminal in T3 Code and run the command yourself:

| Agent | Install | Update |
| --- | --- | --- |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude update` |
| Codex | `npm i -g @openai/codex` | the same command again |
| Pi | `npm i -g --ignore-scripts @earendil-works/pi-coding-agent` | the same command again |
| OpenCode | `npm i -g opencode-ai` | the same command again |

`npm i -g` installs into your App home (`~/.local`), with no administrator
password. Pi and OpenCode appear after **Settings → Providers → Add provider**.
After installing or signing in, select **Refresh provider status**.

### Sign in to an agent

Agents run on the NAS, so their sign-in pages cannot return to it
automatically. Each one shows a link and lets you finish by pasting a code:

- **Claude Code:** **Sign in** in T3 Code, or `claude auth login` in the
  terminal. Open the link, approve, then paste the code into the terminal.
- **Codex:** `codex login --device-auth` in the terminal. Open the link and enter
  the one-time code. **Continue with ChatGPT** in T3 Code also works: when the
  browser ends on a page that does not load, paste that page's address into
  T3 Code's sign-in panel.
- **Pi:** run `pi`, then `/login`. Paste the code or the final address when asked.
- **OpenCode:** `opencode auth login`.

Agents can also use API keys: **Settings → Providers → (agent) → Environment
variables**. Sign-ins are kept in the App's storage across upgrades.

### Projects

Projects live in the Shared Folder chosen at installation (default `T3Code`),
which T3 Code sees as `/workspace`. Agents and the terminal work there as the
package's own account, not as the signed-in DSM user. Files they create belong
to that account. Grant other users access with the Shared Folder's permissions.

### Who can use it

Only DSM administrators. Every administrator who opens T3 Code uses the same
T3 Code instance: the same threads, settings and agent sign-ins (for example one
Claude subscription). Do not install it on a NAS where administrators should not
share these.

### Signing in to T3 Code

DSM sign-in is the only sign-in. T3 Code's own pairing is not used: the package
holds a T3 Code session named **DSM sign-in**, and the DSM gateway uses it for
every administrator. If you revoke that session in **Settings → Sharing &
access**, T3 Code stops answering; stop and start T3 Code in Package Center to
create a new one.

### Access from outside your network

T3 Code has its own HTTPS port, chosen in the install wizard (default 23773),
with DSM's certificate. QuickConnect does not carry it, and opening it to the
internet is not recommended. To use T3 Code away from home, connect to your
network with a VPN (for example DSM VPN Server or Tailscale) first.

T3 Connect, pairing other devices, the mobile app and app.t3.codes are not
available in this package.

### Updates and data

- **T3 Code** updates only through Package Center; its own updater is off.
  Anonymous usage data is off.
- **Agents** update from T3 Code (Settings → Maintenance checks for new
  versions) or with the commands above.
- **Uninstalling** keeps the Shared Folder. The container volume that holds
  T3 Code's data, agents and sign-ins is kept too, even when you choose to delete
  data; Package Center lists its name.

## How it works

```text
browser ──HTTPS :23773 (DSM nginx, DSM certificate)──▶ SDK identity gateway
          DSM administrator sign-in; t3-key adds X-Synopkgland-T3-Key
                         ──▶ container (package account, read-only root, no capabilities)
                             t3-gate :8080  checks the key, drops browser credentials,
                                            adds Authorization: Bearer <DSM sign-in session>
                             T3 Code 127.0.0.1:3773
```

- **Image** (`runtime/`): Debian slim with Node.js, git, ripgrep, Python and
  T3 Code's official Linux release archive, pinned by upstream's SHA-256. No
  agent CLI. Published as
  `ghcr.io/synopackageland/syno-pkg-land-t3code-runtime:<version>-<build>` and
  pinned by index digest in `compose.image.yaml`.
- **`runtime/t3-launch`**: prepares the home (`/data/home`, a named volume) and a
  passwd entry for the package UID, runs T3 Code on the container's loopback,
  issues the long-lived **DSM sign-in** session when it is missing or revoked,
  then runs `t3-gate`.
- **`runtime/t3-gate.mjs`**: the only listener on the bridge. It requires the
  per-install key, removes the browser's `Authorization` and `t3_session*`
  cookies (a T3 cookie would outrank the bearer), and adds the session. Only
  `/.well-known/t3/environment`, the readiness probe, passes without the key.
- **Gateway key:** the SDK generates the Compose runtime secret `gateway-key`.
  It reaches the container as `T3_GATE_KEY` and `helper/` (`t3-key`, the
  gateway's token adapter) reads the same private file. Neither the key nor the
  T3 session reaches the browser.
- **`runtime/policy.json`**: T3 Code's managed policy (`/etc/t3code/policy.json`):
  updates off, T3 Connect off, usage data off, loopback clients only.
- **PATH:** T3 Code reads PATH from a login shell; Debian's `/etc/profile`
  resets it, so `/etc/profile.d/synology-t3-path.sh` puts `~/.local/bin` first.
- **git:** repositories in the Shared Folder belong to DSM users, so the image
  sets `safe.directory` for the package UID.

## Maintaining

```sh
npm ci                                     # pinned CLI
GH_TOKEN=... ./build-source.sh             # helpers, runtime OCI archive, image pin
npx synopkgland check --json
npx synopkgland build --arch x86_64 --json
npx synopkgland build --arch aarch64 --json
npx synopkgland inspect dist/<spk> --json
npm test                                   # t3-gate and helper contracts
```

`build-source.sh` downloads the release archives (or uses `gh release download`
where GitHub's release CDN is unreachable), checks them against upstream's
`SHA256SUMS`, builds `t3-key` for both NAS architectures, builds the runtime
image for linux/amd64 and linux/arm64 into `.build/runtime.oci.tar`, and writes
its index digest to `compose.image.yaml`.

`synopkgland build` reads the image's manifests from the registry. Before the
image is published, serve the archive from a local registry and point the CLI
at it:

```sh
skopeo copy --all --preserve-digests oci-archive:.build/runtime.oci.tar \
  docker://<local-registry>/synopackageland/syno-pkg-land-t3code-runtime:<tag>
SYNOPKGLAND_COMPOSE_REGISTRY_MIRRORS='{"ghcr.io":"https://<local-registry>"}' npx synopkgland build ...
```

### Release

1. Publish the exact archive, keeping its digest:
   `skopeo copy --all --preserve-digests oci-archive:.build/runtime.oci.tar docker://ghcr.io/synopackageland/syno-pkg-land-t3code-runtime:<tag>`.
   Make the package public. Container Manager downloads it at install.
2. Rebuild the SPKs without a mirror and check that `inspect` reports the same
   image digest.

### Upgrade to a new upstream release

```sh
GH_TOKEN=... bash synology/upgrade.sh v<X.Y.Z> <next build>
```

`upgrade.sh` merges the upstream tag, then `build-source.sh` records the new
release's SHA-256 pins in `runtime/Dockerfile` and rebuilds everything. Reset
`build` to 1 for a new upstream version, as above. Review `T3 Code`'s release
notes for changes to the auth descriptor, `/.well-known/t3/environment`,
`t3 auth session issue`, the managed policy keys and the agent setup flows.

## Limitations

- No DSM path (`/synopkgland/T3Code/`): the web app uses root-absolute URLs and
  has no base-path setting, so it has its own HTTPS port.
- One shared instance for administrators; no per-user isolation.
- Revoking the **DSM sign-in** session needs a package restart.
- T3 Code's browser tabs and HTML previews need a headless Chrome sandbox that
  the container does not provide; they are unavailable.
