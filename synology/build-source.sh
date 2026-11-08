#!/usr/bin/env bash
# Source hook: build what this package ships, from upstream's release.
#
# upgrade.sh runs it from synology/ with SPL_UPSTREAM_TAG; it also runs alone
# for the version in runtime/Dockerfile. It never edits upstream files and
# never pushes anything.
#
#   .build/helpers/<arch>/t3-key   gateway token adapter (helper/), per NAS arch
#   .build/runtime.oci.tar         multi-arch runtime image (runtime/), OCI layout
#   compose.image.yaml             runtime image pinned by that archive's index digest
#
# Publishing is a separate, explicit step (README.md, "Release"): copy the OCI
# archive with `skopeo copy --all --preserve-digests` so the registry serves the
# exact digest pinned here.
set -euo pipefail

packaging=$(cd -- "$(dirname -- "$0")" && pwd)
cd "$packaging"
repository=ghcr.io/synopackageland/syno-pkg-land-t3code-runtime
release_base=https://github.com/pingdotgg/t3code/releases/download

dockerfile_version=$(sed -n 's/^ARG T3_VERSION=//p' runtime/Dockerfile)
version=${SPL_UPSTREAM_TAG:-v$dockerfile_version}
version=${version#v}
build=$(sed -n 's/^build: *//p' dsm-package.yaml)
tag=$version-$(printf %04d "$build")
mkdir -p .build/release .build/helpers

# 1. Upstream release archives, verified against upstream's SHA256SUMS.
fetch() {
  local name=$1 out=.build/release/$1
  [[ -s $out ]] && return 0
  if ! curl -fsSL --retry 3 -o "$out.part" "$release_base/v$version/$name"; then
    # Some networks cannot reach GitHub's release CDN; the API path still works.
    command -v gh >/dev/null || return 1
    gh release download "v$version" -R pingdotgg/t3code -p "$name" -O "$out.part" --clobber
  fi
  mv "$out.part" "$out"
}
rm -f .build/release/SHA256SUMS
fetch SHA256SUMS
sum() { sed -n "s/^\([0-9a-f]\{64\}\)  *\*\{0,1\}t3-$version-$1\.tar\.gz$/\1/p" .build/release/SHA256SUMS; }
x64=$(sum linux-x64)
arm64=$(sum linux-arm64)
[[ ${#x64} == 64 && ${#arm64} == 64 ]] || { echo "SHA256SUMS lacks Linux archives for $version" >&2; exit 1; }
if [[ $version != "$dockerfile_version" ]]; then
  # A new upstream release: record its pins in the Dockerfile.
  sed -i -e "s/^ARG T3_VERSION=.*/ARG T3_VERSION=$version/" \
    -e "s/^ARG T3_SHA256_X64=.*/ARG T3_SHA256_X64=$x64/" \
    -e "s/^ARG T3_SHA256_ARM64=.*/ARG T3_SHA256_ARM64=$arm64/" runtime/Dockerfile
fi
grep -q "^ARG T3_SHA256_X64=$x64$" runtime/Dockerfile && grep -q "^ARG T3_SHA256_ARM64=$arm64$" runtime/Dockerfile || {
  echo "runtime/Dockerfile pins differ from upstream SHA256SUMS for $version" >&2; exit 1;
}
for key in linux-x64 linux-arm64; do
  fetch "t3-$version-$key.tar.gz"
done
(cd .build/release && sha256sum -c --ignore-missing SHA256SUMS)

# 2. Gateway token adapter, one static binary per NAS architecture.
(cd helper && go test ./...)
for arch in x86_64:amd64 aarch64:arm64; do
  mkdir -p ".build/helpers/${arch%%:*}"
  (cd helper && CGO_ENABLED=0 GOOS=linux GOARCH=${arch##*:} \
    go build -trimpath -buildvcs=false -ldflags='-s -w' -o "../.build/helpers/${arch%%:*}/t3-key" .)
done

# 3. Runtime image for both architectures, as one OCI archive.
epoch=$(git log -1 --format=%ct -- . 2>/dev/null || true)
export SOURCE_DATE_EPOCH=${epoch:-0}
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-context release=.build/release \
  --label org.opencontainers.image.source=https://github.com/synopackageland/syno-pkg-land-t3code \
  --label org.opencontainers.image.version="$tag" \
  --label org.opencontainers.image.licenses=MIT \
  --output "type=oci,dest=.build/runtime.oci.tar,name=$repository:$tag,rewrite-timestamp=true" \
  runtime
digest=$(tar -xOf .build/runtime.oci.tar index.json | node -e '
  const index = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (index.manifests.length !== 1) throw new Error("expected one image index");
  process.stdout.write(index.manifests[0].digest);')
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]]
printf '{\n  "services": {\n    "t3code": {\n      "image": "%s:%s@%s"\n    }\n  }\n}\n' \
  "$repository" "$tag" "$digest" > compose.image.yaml
echo "runtime image $repository:$tag@$digest"
