#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every pinned
# file whose sha256 matches the manifest, into the same relative layout, and
# must fail closed (non-zero, nothing installed) when any one file is tampered
# or missing. A legacy single-file pin must still install. Run from
# packages/worker:
#   bash test/shell/boot-pin-harness.sh
set -u
cd "$(dirname "$0")/../.."

WORK=$(mktemp -d) || { echo "MKTEMP FAILED"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

# macOS lacks sha256sum; shim it onto shasum.
if ! command -v sha256sum >/dev/null 2>&1; then
	mkdir -p "$WORK/bin"
	printf '#!/bin/sh\nexec shasum -a 256 "$@"\n' > "$WORK/bin/sha256sum"
	chmod +x "$WORK/bin/sha256sum"
	export PATH="$WORK/bin:$PATH"
fi

SRV="$WORK/srv"
DEST="$WORK/opt"
FILES="box-runner.mjs harness/claude.mjs lib/util.mjs"

serve_pristine() {
	rm -rf "$SRV"
	mkdir -p "$SRV/harness" "$SRV/lib"
	echo 'console.log("runner ok")' > "$SRV/box-runner.mjs"
	echo 'export const harness = "claude"' > "$SRV/harness/claude.mjs"
	echo 'export const util = 1' > "$SRV/lib/util.mjs"
}

sha_of() { sha256sum "$1" | cut -d' ' -f1; }

# Emit the real fragment from the TS module (node >=23 strips types natively).
# $1 = JSON of the pin's config fields (runner_ref / runner_sha256 / runner_files).
gen_fragment() {
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig($1)
  if (!pin) { console.error('pin rejected'); process.exit(3) }
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SRV', destDir: '$DEST' }))
})"
}

none_installed() {
	local g
	for g in $FILES; do [ -e "$DEST/$g" ] && return 1; done
	return 0
}

fail=0
pass() { echo "ok: $1"; }
flunk() { echo "FAIL: $1"; fail=1; }

serve_pristine
MANIFEST="{ runner_ref: 'testref', runner_files: {
  'box-runner.mjs': '$(sha_of "$SRV/box-runner.mjs")',
  'harness/claude.mjs': '$(sha_of "$SRV/harness/claude.mjs")',
  'lib/util.mjs': '$(sha_of "$SRV/lib/util.mjs")' } }"
gen_fragment "$MANIFEST" > "$WORK/fragment.sh" || { echo "FRAGMENT GENERATION FAILED"; exit 1; }

# Case A: pristine manifest -> every file installed in the same layout, exit 0.
rm -rf "$DEST"
if bash -euo pipefail "$WORK/fragment.sh" &&
	cmp -s "$SRV/box-runner.mjs" "$DEST/box-runner.mjs" &&
	cmp -s "$SRV/harness/claude.mjs" "$DEST/harness/claude.mjs" &&
	cmp -s "$SRV/lib/util.mjs" "$DEST/lib/util.mjs"; then
	pass "pristine manifest installed in the same relative layout"
else
	flunk "pristine manifest was not installed"
fi

# Case B: tampering with any one file -> refuse, nothing installed.
for f in $FILES; do
	serve_pristine
	rm -rf "$DEST"
	echo 'console.log("evil")' >> "$SRV/$f"
	if bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null; then
		flunk "tampered $f accepted (exit 0)"
	elif ! none_installed; then
		flunk "tampered $f: files installed despite non-zero exit"
	else
		pass "tampered $f rejected, nothing installed"
	fi
done

# Case C: any one file missing upstream -> refuse, nothing installed.
for f in $FILES; do
	serve_pristine
	rm -rf "$DEST"
	rm -f "$SRV/$f"
	if bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null; then
		flunk "missing $f accepted (exit 0)"
	elif ! none_installed; then
		flunk "missing $f: files installed despite non-zero exit"
	else
		pass "missing $f rejected, nothing installed"
	fi
done

# Case D: a manifest that omits box-runner.mjs or has an unsafe path -> no fragment, no boot.
serve_pristine
for bad in \
	"{ runner_ref: 'testref', runner_files: { 'lib/util.mjs': '$(sha_of "$SRV/lib/util.mjs")' } }" \
	"{ runner_ref: 'testref', runner_files: { 'box-runner.mjs': '$(sha_of "$SRV/box-runner.mjs")', '../etc/x': '$(sha_of "$SRV/lib/util.mjs")' } }"; do
	if gen_fragment "$bad" >/dev/null 2>&1; then
		flunk "invalid manifest produced a boot fragment: $bad"
	else
		pass "invalid manifest refused"
	fi
done

# Case E: legacy single-file pin still boots; tampering it still refuses.
serve_pristine
gen_fragment "{ runner_ref: 'testref', runner_sha256: '$(sha_of "$SRV/box-runner.mjs")' }" \
	> "$WORK/legacy.sh" || { echo "LEGACY FRAGMENT GENERATION FAILED"; exit 1; }
rm -rf "$DEST"
if bash -euo pipefail "$WORK/legacy.sh" && cmp -s "$SRV/box-runner.mjs" "$DEST/box-runner.mjs"; then
	pass "legacy single-file pin installed"
else
	flunk "legacy single-file pin was not installed"
fi
rm -rf "$DEST"
echo 'console.log("evil")' >> "$SRV/box-runner.mjs"
if bash -euo pipefail "$WORK/legacy.sh" 2>/dev/null || [ -e "$DEST/box-runner.mjs" ]; then
	flunk "tampered legacy runner accepted"
else
	pass "tampered legacy runner rejected"
fi

exit $fail
