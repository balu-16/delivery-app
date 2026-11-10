#!/usr/bin/env bash
set -euo pipefail
: "${LOAD_PROFILE:?local, staging or smoke}"
: "${BASE_URL:?required}" "${CUSTOMER_TOKEN:?required}" "${ADDRESS_ID:?required}"
k6_bin=${K6_BIN:-artifacts/load-tools/k6-v1.3.0}
output_dir=${LOAD_OUTPUT_DIR:-artifacts/p13-load}
mkdir -p "$output_dir"
run_dir=$(mktemp -d "$output_dir/catalog-${LOAD_PROFILE}-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
export SUMMARY_PATH="$run_dir/summary.json"
start=$(date -u +%FT%TZ)
set +e
/usr/bin/time -q -f '{"elapsedSeconds":%e,"userCpuSeconds":%U,"systemCpuSeconds":%S,"maxRssKiB":%M}' -o "$run_dir/resources.json" "$k6_bin" run test/load/catalog.js >"$run_dir/console.log" 2>&1
status=$?
set -e
# Failure metadata is written even when k6 fails before handleSummary.
LOAD_EXIT="$status" LOAD_START="$start" LOAD_RUN_DIR="$run_dir" node --input-type=module <<'NODE'
import { writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
const e = process.env;
let usage = null;
try { usage = JSON.parse(readFileSync(`${e.LOAD_RUN_DIR}/resources.json`, 'utf8')); } catch {}
let summary = null;
try { summary = JSON.parse(readFileSync(`${e.LOAD_RUN_DIR}/summary.json`, 'utf8')); } catch {}
const report = { profile: e.LOAD_PROFILE, startedAt: e.LOAD_START, endedAt: new Date().toISOString(), exitCode: Number(e.LOAD_EXIT), target: e.BASE_URL, dataset: { addressId: e.ADDRESS_ID }, resourceUsage: usage, resources: { host: os.hostname(), cpus: os.cpus().length, memoryBytes: os.totalmem(), platform: os.platform(), arch: os.arch() }, rateLimitSettings: { defaultPerMinute: e.RATE_LIMIT_DEFAULT_PER_MIN ?? null, searchPerMinute: e.RATE_LIMIT_SEARCH_PER_MIN ?? null }, summary };
writeFileSync(`${e.LOAD_RUN_DIR}/report.json`, JSON.stringify(report, null, 2));
NODE
printf 'Report: %s/report.json\n' "$run_dir"
exit "$status"
