#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every file of
# the pinned manifest (same relative layout) when all sha256s match, and must
# fail closed (non-zero, nothing installed) when any one file is tampered or
# missing. A legacy single-file pin (runner_ref + runner_sha256) must still
# boot. Run from packages/worker:
#   bash test/shell/boot-pin-harness.sh
set -u
cd "$(dirname "$0")/../.."

WORK=$(mktemp -d "${TMPDIR:-/tmp}/boot-pin.XXXXXX") || { echo "MKTEMP FAILED"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

# macOS lacks sha256sum; shim it onto shasum.
if ! command -v sha256sum >/dev/null 2>&1; then
	mkdir -p "$WORK/bin"
	printf '#!/bin/sh\nexec shasum -a 256 "$@"\n' > "$WORK/bin/sha256sum"
	chmod +x "$WORK/bin/sha256sum"
	export PATH="$WORK/bin:$PATH"
fi

SRV="$WORK/srv"        # what the "CDN" serves at the pinned ref
DEST="$WORK/opt/fermi" # install dir on the box
FILES="box-runner.mjs harness/claude.mjs lib/util.mjs"

serve_pristine() {
	rm -rf "$SRV"
	mkdir -p "$SRV/harness" "$SRV/lib"
	echo 'import "./harness/claude.mjs"; console.log("runner ok")' > "$SRV/box-runner.mjs"
	echo 'export const harness = "claude"' > "$SRV/harness/claude.mjs"
	echo 'export const util = 1' > "$SRV/lib/util.mjs"
}

serve_pristine
MANIFEST="{"
for f in $FILES; do
	MANIFEST="$MANIFEST\"$f\": \"$(sha256sum "$SRV/$f" | cut -d' ' -f1)\","
done
MANIFEST="${MANIFEST%,}}"
ENTRY_SHA=$(sha256sum "$SRV/box-runner.mjs" | cut -d' ' -f1)

# Emit the real fragment from the TS module (node >=23 strips types natively),
# going through runnerPinFromConfig exactly as the provisioner does.
gen_fragment() { # $1 = fleet:config JSON, $2 = output file
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig($1)
  if (!pin) { console.error('pin rejected'); process.exit(1) }
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SRV', dir: '$DEST' }))
})" > "$2"
}

gen_fragment "{ runner_ref: 'testref', runner_sha256: '$ENTRY_SHA', runner_files: $MANIFEST }" \
	"$WORK/manifest.sh" || { echo "MANIFEST FRAGMENT GENERATION FAILED"; exit 1; }
gen_fragment "{ runner_ref: 'testref', runner_sha256: '$ENTRY_SHA' }" \
	"$WORK/legacy.sh" || { echo "LEGACY FRAGMENT GENERATION FAILED"; exit 1; }

fail=0

nothing_installed() {
	[ -z "$(find "$DEST" -type f 2>/dev/null)" ]
}

expect_boot() { # $1 = fragment, $2 = label, $3.. = files that must be installed intact
	local frag=$1 label=$2
	shift 2
	rm -rf "$DEST"
	if ! bash -euo pipefail "$frag"; then
		echo "FAIL: $label: boot refused"; fail=1; return
	fi
	for f in "$@"; do
		if ! cmp -s "$SRV/$f" "$DEST/$f"; then
			echo "FAIL: $label: $f not installed at $DEST/$f"; fail=1; return
		fi
	done
	echo "ok: $label: booted"
}

expect_refuse() { # $1 = fragment, $2 = label
	rm -rf "$DEST"
	if bash -euo pipefail "$1" 2>/dev/null; then
		echo "FAIL: $2: accepted (exit 0)"; fail=1
	elif ! nothing_installed; then
		echo "FAIL: $2: files installed despite non-zero exit"; fail=1
	else
		echo "ok: $2: refused, nothing installed"
	fi
}

# Case A: pristine manifest -> every file installed in the same layout.
serve_pristine
# shellcheck disable=SC2086
expect_boot "$WORK/manifest.sh" "pristine manifest" $FILES

# Case B: tamper any one file -> refuse.
for f in $FILES; do
	serve_pristine
	echo '// evil' >> "$SRV/$f"
	expect_refuse "$WORK/manifest.sh" "tampered $f"
done

# Case C: omit any one file -> refuse.
for f in $FILES; do
	serve_pristine
	rm -f "$SRV/$f"
	expect_refuse "$WORK/manifest.sh" "missing $f"
done

# Case D: legacy single-file pin still boots, and still refuses a tampered runner.
serve_pristine
expect_boot "$WORK/legacy.sh" "legacy single-file pin" box-runner.mjs
echo 'console.log("evil")' > "$SRV/box-runner.mjs"
expect_refuse "$WORK/legacy.sh" "legacy tampered box-runner.mjs"

# Case E: invalid manifests never produce a fragment.
for bad in \
	"{ runner_ref: 'testref', runner_files: { 'lib/util.mjs': '$ENTRY_SHA' } }" \
	"{ runner_ref: 'testref', runner_files: { 'box-runner.mjs': '$ENTRY_SHA', '../etc/passwd': '$ENTRY_SHA' } }" \
	"{ runner_ref: 'testref', runner_sha256: '$(printf 'f%.0s' $(seq 64))', runner_files: $MANIFEST }"; do
	if gen_fragment "$bad" "$WORK/bad.sh" 2>/dev/null; then
		echo "FAIL: invalid pin produced a fragment: $bad"; fail=1
	else
		echo "ok: invalid pin rejected"
	fi
done
if node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  try { m.runnerFetchScript({ ref: 'testref', files: { 'box-runner.mjs': '$ENTRY_SHA', '/abs.mjs': '$ENTRY_SHA' } }) }
  catch { process.exit(0) }
  process.exit(1)
})"; then
	echo "ok: runnerFetchScript throws on an unsafe path"
else
	echo "FAIL: runnerFetchScript accepted an unsafe path"; fail=1
fi

exit $fail
