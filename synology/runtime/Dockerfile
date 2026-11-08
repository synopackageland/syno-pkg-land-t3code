# T3 Code runtime image for DSM.
#
# Only the runtime base and the t3 server: no AI agent CLI is installed here.
# Users install agents from T3 Code's own wizard or terminal into $HOME, a
# persistent volume, so they can upgrade them as fast as the agents release.
#
# Build with build-source.sh, which supplies the "release" build context.
FROM public.ecr.aws/docker/library/node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client ripgrep python3 python3-venv \
      bash less procps unzip xz-utils jq file tini libnss-wrapper \
 && rm -rf /var/lib/apt/lists/*

# The npm "t3" package is only a launcher that downloads the release archive
# into $T3CODE_HOME at first run. Bake the pinned archive in instead, so the
# package version alone decides the server version and startup needs no network.
# The "release" context holds t3-<version>-linux-<arch>.tar.gz from upstream's
# GitHub release; the SHA-256 pins are upstream's SHA256SUMS lines.
ARG T3_VERSION=0.1.7
ARG T3_SHA256_X64=c089892bf7922e2e73c6f44a5d1ea125c99f70e378c18361cbbed2fba1920e6c
ARG T3_SHA256_ARM64=5a528e23af394cc6f359036d3cb8441fda14129d477630fc6c53e4f4a1025bc8
ARG TARGETARCH
RUN --mount=type=bind,from=release,target=/release set -eu; \
    case "$TARGETARCH" in \
      amd64) key=linux-x64; sum=$T3_SHA256_X64;; \
      arm64) key=linux-arm64; sum=$T3_SHA256_ARM64;; \
      *) exit 1;; esac; \
    archive="/release/t3-${T3_VERSION}-${key}.tar.gz"; \
    echo "$sum  $archive" | sha256sum -c -; \
    mkdir -p /opt/t3; tar --no-same-owner -xzf "$archive" -C /opt/t3 --strip-components=1; \
    /opt/t3/t3 --version

# Persistent per-package home. Everything user-installed lands under it.
ENV HOME=/data/home \
    T3CODE_HOME=/data/home/.t3 \
    NPM_CONFIG_PREFIX=/data/home/.local \
    NPM_CONFIG_CACHE=/data/home/.cache/npm \
    XDG_CONFIG_HOME=/data/home/.config \
    XDG_DATA_HOME=/data/home/.local/share \
    XDG_CACHE_HOME=/data/home/.cache \
    PATH=/data/home/.local/bin:/data/home/.opencode/bin:/data/home/.bun/bin:/opt/t3:/usr/local/bin:/usr/bin:/bin \
    SHELL=/bin/bash \
    T3CODE_NO_BROWSER=1 \
    T3CODE_TELEMETRY_ENABLED=false

# Repositories in the Shared Folder belong to DSM users, not the package UID.
RUN git config --system safe.directory '*'

# Package Center owns the T3 version; no T3 Connect, telemetry or network pairing.
COPY policy.json /etc/t3code/policy.json
COPY profile-path.sh /etc/profile.d/synology-t3-path.sh
COPY t3-launch /usr/local/bin/t3-launch
COPY t3-gate.mjs /opt/synology/t3-gate.mjs
COPY LICENSE-wrapper.txt /usr/share/doc/syno-pkg-land-t3code/LICENSE
# A fresh named volume copies this directory and its mode, so the fixed but
# build-time-unknown package UID can create its home inside it.
RUN mkdir -m 1777 /data
WORKDIR /data
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/t3-launch"]
