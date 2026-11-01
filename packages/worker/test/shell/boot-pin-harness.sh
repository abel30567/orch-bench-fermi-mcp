#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every pinned
# file whose sha256 matches the manifest, and must fail closed (non-zero,
# nothing installed) when any one file is tampered or missing. Covers both a
# legacy single-file pin and a multi-file manifest. Run from packages/worker:
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

SERVE="$WORK/serve"
DEST="$WORK/opt/fermi"
MANIFEST_FILES=(box-runner.mjs harness/claude.mjs lib/proof.mjs)

fail=0
pass() { echo "ok: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

# Fresh pristine served tree + empty install dir.
reset() {
	rm -rf "$SERVE" "$DEST" "$DEST.new"
	mkdir -p "$SERVE/harness" "$SERVE/lib"
	echo 'console.log("runner ok")' > "$SERVE/box-runner.mjs"
	echo 'export const harness = "claude"' > "$SERVE/harness/claude.mjs"
	echo 'export const proof = 1' > "$SERVE/lib/proof.mjs"
}

sha() { sha256sum "$SERVE/$1" | cut -d' ' -f1; }

# Emit the real fragment from the TS module (node >=23 strips types natively),
# going through runnerPinFromConfig exactly as the provisioner does.
fragment() { # $1 = fleet:config JSON, $2 = output file
	CONFIG="$1" node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig(JSON.parse(process.env.CONFIG))
  if (!pin) { console.error('pin refused'); process.exit(3) }
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SERVE', destDir: '$DEST' }))
})" > "$2"
}

nothing_installed() {
	local f
	for f in "${MANIFEST_FILES[@]}"; do
		[ -e "$DEST/$f" ] && return 1
	done
	return 0
}

# expect_refused NAME FRAGMENT
expect_refused() {
	if bash -euo pipefail "$2" 2>/dev/null; then
		bad "$1: accepted (exit 0)"
	elif ! nothing_installed; then
		bad "$1: file installed despite non-zero exit"
	else
		pass "$1: refused, nothing installed"
	fi
}

# ---- Legacy single-file pin (runner_sha256 only) ----
reset
fragment "{\"runner_ref\":\"testref\",\"runner_sha256\":\"$(sha box-runner.mjs)\"}" "$WORK/legacy.sh" ||
	{ echo "LEGACY FRAGMENT GENERATION FAILED"; exit 1; }

if bash -euo pipefail "$WORK/legacy.sh" && cmp -s "$SERVE/box-runner.mjs" "$DEST/box-runner.mjs"; then
	pass "legacy pin: pristine runner installed"
else
	bad "legacy pin: pristine runner was not installed"
fi

reset
echo 'console.log("evil")' > "$SERVE/box-runner.mjs"
expect_refused "legacy pin: tampered runner" "$WORK/legacy.sh"

reset
rm "$SERVE/box-runner.mjs"
expect_refused "legacy pin: missing runner" "$WORK/legacy.sh"

# ---- Multi-file manifest ----
reset
MANIFEST_JSON=$(printf '"%s":"%s",' \
	box-runner.mjs "$(sha box-runner.mjs)" \
	harness/claude.mjs "$(sha harness/claude.mjs)" \
	lib/proof.mjs "$(sha lib/proof.mjs)")
CONFIG="{\"runner_ref\":\"testref\",\"runner_sha256\":\"$(sha box-runner.mjs)\",\"runner_files\":{${MANIFEST_JSON%,}}}"
fragment "$CONFIG" "$WORK/manifest.sh" || { echo "MANIFEST FRAGMENT GENERATION FAILED"; exit 1; }

ok=1
bash -euo pipefail "$WORK/manifest.sh" || ok=0
for f in "${MANIFEST_FILES[@]}"; do
	cmp -s "$SERVE/$f" "$DEST/$f" || ok=0
done
if [ $ok -eq 1 ]; then
	pass "manifest: every file installed in its relative layout"
else
	bad "manifest: pristine files were not all installed"
fi

for f in "${MANIFEST_FILES[@]}"; do
	reset
	echo '// tampered' >> "$SERVE/$f"
	expect_refused "manifest: tampered $f" "$WORK/manifest.sh"

	reset
	rm "$SERVE/$f"
	expect_refused "manifest: missing $f" "$WORK/manifest.sh"
done

# A manifest that omits box-runner.mjs is not a pin at all: no fragment.
reset
NO_ENTRY="{\"runner_ref\":\"testref\",\"runner_files\":{\"lib/proof.mjs\":\"$(sha lib/proof.mjs)\"}}"
if fragment "$NO_ENTRY" "$WORK/no-entry.sh" 2>/dev/null; then
	bad "manifest without box-runner.mjs produced a boot fragment"
else
	pass "manifest without box-runner.mjs: refused"
fi

exit $fail
