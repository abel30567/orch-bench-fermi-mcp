#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every pinned
# runner file whose sha256 matches the manifest, and must fail closed (non-zero,
# nothing installed) when any one served file is tampered or missing. A legacy
# single-file pin (runner_ref + runner_sha256) must still boot. Run from
# packages/worker:
#   bash test/shell/boot-pin-harness.sh
set -u
cd "$(dirname "$0")/../.."

WORK=$(mktemp -d "${TMPDIR:-/tmp}/boot-pin.XXXXXX") || { echo "mktemp failed"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

# macOS lacks sha256sum; shim it onto shasum.
if ! command -v sha256sum >/dev/null 2>&1; then
	mkdir -p "$WORK/bin"
	printf '#!/bin/sh\nexec shasum -a 256 "$@"\n' > "$WORK/bin/sha256sum"
	chmod +x "$WORK/bin/sha256sum"
	export PATH="$WORK/bin:$PATH"
fi

SRV="$WORK/srv"      # what the "CDN" serves
DEST="$WORK/opt"     # install root (/opt/fermi on a box)
FILES="box-runner.mjs harness/claude.mjs lib/report.mjs"

serve_pristine() {
	rm -rf "$SRV" && mkdir -p "$SRV/harness" "$SRV/lib"
	echo 'console.log("runner ok")' > "$SRV/box-runner.mjs"
	echo 'export const harness = "claude"' > "$SRV/harness/claude.mjs"
	echo 'export const report = () => 1' > "$SRV/lib/report.mjs"
}
sha() { sha256sum "$1" | cut -d' ' -f1; }

serve_pristine
MANIFEST="{\"box-runner.mjs\":\"$(sha "$SRV/box-runner.mjs")\",\"harness/claude.mjs\":\"$(sha "$SRV/harness/claude.mjs")\",\"lib/report.mjs\":\"$(sha "$SRV/lib/report.mjs")\"}"
RUNNER_SHA=$(sha "$SRV/box-runner.mjs")

# Emit the real fragment from the TS module (node >=23 strips types natively),
# going through runnerPinFromConfig exactly as the provisioner does.
# $1 = fleet:config JSON. Fails if the pin is rejected or the script throws.
fragment() {
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig(JSON.parse(process.argv[1]))
  if (!pin) { console.error('pin rejected'); process.exit(3) }
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SRV', destDir: '$DEST' }))
}).catch(e => { console.error(e.message); process.exit(4) })" "$1"
}

fail=0
pass() { echo "ok: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

installed_none() {
	local p
	for p in $FILES; do [ -e "$DEST/$p" ] && return 1; done
	return 0
}

# expect_boot NAME FRAGMENT FILES...: boots and installs each file byte-identical.
expect_boot() {
	local name=$1 frag=$2; shift 2
	rm -rf "$DEST" && mkdir -p "$DEST"
	if ! bash -euo pipefail "$frag"; then bad "$name: boot refused"; return; fi
	for f in "$@"; do
		cmp -s "$SRV/$f" "$DEST/$f" || { bad "$name: $f not installed intact"; return; }
	done
	[ -e "$DEST/.runner-stage" ] && { bad "$name: staging dir left behind"; return; }
	pass "$name"
}

# expect_refuse NAME FRAGMENT: non-zero exit and nothing installed.
expect_refuse() {
	local name=$1 frag=$2
	rm -rf "$DEST" && mkdir -p "$DEST"
	if bash -euo pipefail "$frag" 2>/dev/null; then
		bad "$name: accepted (exit 0)"
	elif ! installed_none; then
		bad "$name: files installed despite non-zero exit"
	else
		pass "$name"
	fi
}

# --- Legacy single-file pin -------------------------------------------------
fragment "{\"runner_ref\":\"testref\",\"runner_sha256\":\"$RUNNER_SHA\"}" > "$WORK/legacy.sh" \
	|| { echo "LEGACY FRAGMENT GENERATION FAILED"; exit 1; }
expect_boot "legacy single-file pin boots" "$WORK/legacy.sh" box-runner.mjs
echo 'console.log("evil")' > "$SRV/box-runner.mjs"
expect_refuse "legacy pin: tampered runner rejected, nothing installed" "$WORK/legacy.sh"
serve_pristine

# --- Manifest pin -------------------------------------------------------------
fragment "{\"runner_ref\":\"testref\",\"runner_sha256\":\"$RUNNER_SHA\",\"runner_files\":$MANIFEST}" > "$WORK/manifest.sh" \
	|| { echo "MANIFEST FRAGMENT GENERATION FAILED"; exit 1; }
# shellcheck disable=SC2086
expect_boot "manifest pin installs every file in its relative layout" "$WORK/manifest.sh" $FILES

for f in $FILES; do
	serve_pristine
	echo '// evil' >> "$SRV/$f"
	expect_refuse "manifest: tampered $f rejected, nothing installed" "$WORK/manifest.sh"

	serve_pristine
	rm -f "$SRV/$f"
	expect_refuse "manifest: missing $f rejected, nothing installed" "$WORK/manifest.sh"
done
serve_pristine

# --- Invalid manifests never produce a boot script ----------------------------
reject_pin() {
	local name=$1 cfg=$2
	if fragment "$cfg" >/dev/null 2>&1; then bad "$name: produced a boot script"; else pass "$name"; fi
}
reject_pin "manifest without box-runner.mjs rejected" \
	"{\"runner_ref\":\"testref\",\"runner_files\":{\"lib/report.mjs\":\"$RUNNER_SHA\"}}"
reject_pin "manifest with traversal path rejected" \
	"{\"runner_ref\":\"testref\",\"runner_files\":{\"box-runner.mjs\":\"$RUNNER_SHA\",\"../etc/x\":\"$RUNNER_SHA\"}}"
reject_pin "manifest with shell metacharacters rejected" \
	"{\"runner_ref\":\"testref\",\"runner_files\":{\"box-runner.mjs\":\"$RUNNER_SHA\",\"a'b.mjs\":\"$RUNNER_SHA\"}}"
reject_pin "unpinned config rejected" "{\"runner_ref\":\"testref\"}"

# Direct API: runnerFetchScript must throw on an invalid manifest.
if node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  m.runnerFetchScript({ ref: 'testref', files: { 'lib/x.mjs': '$RUNNER_SHA' } })
}).catch(() => process.exit(1))" 2>/dev/null; then
	bad "runnerFetchScript accepted a manifest without box-runner.mjs"
else
	pass "runnerFetchScript throws on an invalid manifest"
fi

exit $fail
