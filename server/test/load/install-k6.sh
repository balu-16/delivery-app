#!/usr/bin/env bash
set -euo pipefail
# Grafana's official v1.3.0 release checksums, linux/amd64.
version=1.3.0
sha=84d26fc1f7bc03e02f2e016b3b1b20c032e05dfe461fca82de4e3a6ebe72ddbd
install_dir=${1:-artifacts/load-tools}
mkdir -p "$install_dir"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
archive="k6-v${version}-linux-amd64.tar.gz"
curl -fsSL "https://github.com/grafana/k6/releases/download/v${version}/${archive}" -o "$tmp/$archive"
printf '%s  %s\n' "$sha" "$tmp/$archive" | sha256sum -c -
tar -xzf "$tmp/$archive" -C "$tmp"
install -m 0755 "$tmp/k6-v${version}-linux-amd64/k6" "$install_dir/k6-v${version}"
"$install_dir/k6-v${version}" version
