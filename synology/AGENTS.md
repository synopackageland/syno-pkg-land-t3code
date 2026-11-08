# Compose App development

Run `synopkgland skill list`, then `synopkgland skill show orchestrator`,
`synopkgland skill show compose` and `synopkgland skill show upstream-fork`.
Prefer `check --json`, `build --json`, `inspect <spk> --json` for reviewable results.

Never write `AppPortal.json` or `@appconf` directly, or relay QuickConnect.
Compose has no native Application Portal alias; use its supported web entry.

Use dsm-package.yaml schema 2. Keep upstream Compose bytes unchanged; declare DSM
policy in compose.files and compose.web. Never use file/targets/address_env or
identity_gateway.upstream: the SDK planner derives ingress.

## Compose health and launch

Select compose.web.health.path and its actual expected 2xx status before
check/build. Redirects are not followed; a 302 to login is unhealthy. check is
static, not an HTTP or arbitrary-UID/storage probe. Test the selected official image as
the package UID, including writable volumes, first setup and upgrade.
Omitted ui.launch means new-page via the SDK standalone launcher, without
Application Portal. Headless Apps omit compose.web and have no launcher.
Compose ctl is unsupported.

Use supported upstream config files, environment, argv or reverse proxy for
login/settings. For integrated upstream Apps, select supported trusted-header authentication or disable upstream login behind the DSM admin gate; or use the existing SDK token adapter: OpenList uses mode: token, access: dsm-admins and entry: admin-only. Its unmodified admin token CLI supplies a package-private 0600 credential; the gateway injects Authorization server-side after DSM admission, without delivering it to the browser. All DSM admins share one upstream admin; token reset requires package restart; WebDAV keeps its own credentials. Verify each App adapter and DSM admission separately.
Containers use the package account and a dedicated bridge; they do not inherit
an interactive user's NAS ACL. Do not use root/chown during any App lifecycle
phase. Preserve licenses and dependency/source provenance. Read the CLI skill
reference/compose.md and reference/upstream-fork.md for the full recipe.

Public npm access does not grant anonymous Go SDK access. Obtain authorised
source/cache access or a matching SYNOPKGLAND_SDK_DIR checkout first. Never copy
credentials into the App. Do not install, publish or modify NAS data without task authorization.

## Integrating an existing open-source App

If you package someone else's open-source project, set maintainer to the original project/owner (prefer the project's own team/org name, else the owner's display name, else login), metadata.maintainer_url to the upstream repo, and yourself as metadata.distributor/metadata.distributor_url. Resolve all attribution TODOs before release; run check and review its warnings. Only your own Apps use your publisher as maintainer.

Keep the upstream fork/history and remote upstream. All wrapper-owned files belong in synology/; never edit upstream files or treat the App as an SDK component. Read synopkgland skill show upstream-fork.

Leave ctl absent from the manifest by default. Inventory upstream APIs with `synopkgland ctl import-openapi openapi.json --output synology/operations.json` (or import a handwritten v2 registry); every new entry is hidden. Group discovered APIs by area, recommend a small useful set, and ask the user about each API. Only explicitly approved APIs may be exposed; never use an all-or-nothing opt-in. Keep all specs and adapters in synology/ and reuse the existing external/ingress transport. Add ctl.registry only after implementing the selected adapters, then run ctl generate and ctl generate --check. If requested, read synopkgland skill show ctl and produce ctl-plan covering existing UI actions and public API endpoints, including common reads and writes. Status-only commands do not meet completion. Wrap existing native APIs without changing upstream code or inventing features. Long operations must return through existing asynchronous APIs without waiting for completion; report synchronous-only long APIs as blockers for discussion.

Commit the scaffold, then run bash synology/upgrade.sh <upstream-tag> <build-number>. It fetches the exact tag, verifies ancestry/untouched upstream files, merges, derives version/provenance, checks and builds. Commit synology/ before upgrading again. It does not publish or touch a NAS.

Default: use the upstream official image. upgrade.sh updates its release tag and resolves an OCI index/manifest digest through synopkgland images pin, writing only synology/compose.image.yaml. Container Manager downloads that pinned official image at install. Configure upstream-recipe.json repository/service and imageTag: tag (exact upstream tag) or version (strip v only when upstream image naming requires it). Review multi-architecture support and upstream source/license correspondence. The SELECT_UPSTREAM_TAG placeholder must be replaced by a successful upgrade before check/build.

Use DSM administrator identity without an additional App password, an OIDC/SSO server or upstream source changes. Prefer supported trusted-header/proxy auth (FreshRSS), otherwise disable upstream login/enable guest behind the administrator-only gateway after a bounded first bootstrap (Uptime Kuma disableAuth). The third shipped pattern is the existing SDK token adapter: mode: token, access: dsm-admins, entry: admin-only. OpenList obtains its native API token with the unmodified admin token CLI while stopped, stores it package-private 0600 under a 0700 directory, and the gateway injects Authorization server-side after DSM admission; packaging never delivers it to the browser. All DSM admins share one upstream admin; token reset requires package restart; WebDAV keeps its own native credentials. The upstream admin token/settings APIs remain unchanged. Verify actual DSM admission/revocation separately. Use supported config, environment, argv or proxy adapters. Every App lifecycle phase runs as the package UID. For upstream fixed-UID data directories, currently provide a synology/ startup adapter or writable path without root/chown; replace it with the framework ownership mechanism when available. Preserve licenses and the full source/component inventory.
