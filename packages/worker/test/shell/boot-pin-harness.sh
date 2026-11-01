#!/usr/bin/env bash
# Tamper harness for #34 / pr-55: the runner-fetch fragment must install every
# manifest file whose sha256 matches the pin into the same relative layout, and
# must fail closed (non-zero, nothing installed) when any one file is tampered
# or missing. A legacy single-file pin must still boot. Run from packages/worker:
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
FILES="box-runner.mjs harness/claude.mjs lib/util.mjs"
SRC="$WORK/src"
DEST="$WORK/opt"

serve_pristine() {
	rm -rf "$SRC"
	mkdir -p "$SRC/harness" "$SRC/lib"
	echo 'import "./lib/util.mjs"; console.log("runner ok")' > "$SRC/box-runner.mjs"
	echo 'export const harness = "claude"' > "$SRC/harness/claude.mjs"
	echo 'export const util = 1' > "$SRC/lib/util.mjs"
}

# Emit the real fragment from the TS module (node >=23 strips types natively).
# $1 = JSON pin passed to runnerFetchScript.
fragment() {
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  console.log(m.runnerFetchScript($1, { baseUrl: 'file://$SRC', dir: '$DEST' }))
})"
}

serve_pristine
MANIFEST="{"
for f in $FILES; do
	MANIFEST="$MANIFEST\"$f\":\"$(sha256sum "$SRC/$f" | cut -d' ' -f1)\","
done
MANIFEST="${MANIFEST%,}}"
fragment "{ ref: 'testref', files: $MANIFEST }" > "$WORK/fragment.sh" \
	|| { echo "FRAGMENT GENERATION FAILED"; exit 1; }

fail=0

installed_all() {
	local f
	for f in $FILES; do cmp -s "$SRC/$f" "$DEST/$f" || return 1; done
}

installed_any() {
	local f
	for f in $FILES; do [ -e "$DEST/$f" ] && return 0; done
	return 1
}

# Case A: pristine manifest -> every file installed in the same layout, exit 0.
rm -rf "$DEST"
if bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null \
	&& installed_all; then
	echo "ok: pristine manifest installed (all files, same layout)"
else
	echo "FAIL: pristine manifest was not installed"; fail=1
fi

# Case B: tamper each file in turn -> must NOT install anything, non-zero exit.
for f in $FILES; do
	serve_pristine
	echo 'console.log("evil")' >> "$SRC/$f"
	rm -rf "$DEST"
	if bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null; then
		echo "FAIL: tampered $f accepted (exit 0)"; fail=1
	elif installed_any; then
		echo "FAIL: tampered $f: files installed despite non-zero exit"; fail=1
	else
		echo "ok: tampered $f rejected, nothing installed"
	fi
done

# Case C: omit each file in turn -> must NOT install anything, non-zero exit.
for f in $FILES; do
	serve_pristine
	rm -f "$SRC/$f"
	rm -rf "$DEST"
	if bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null; then
		echo "FAIL: missing $f accepted (exit 0)"; fail=1
	elif installed_any; then
		echo "FAIL: missing $f: files installed despite non-zero exit"; fail=1
	else
		echo "ok: missing $f rejected, nothing installed"
	fi
done

# Case D: a manifest that omits box-runner.mjs, or has an unsafe path, never
# yields a fragment (generation throws).
for bad in "{ 'harness/claude.mjs': '$(printf 'a%.0s' $(seq 64))' }" \
	"{ 'box-runner.mjs': '$(printf 'a%.0s' $(seq 64))', '../etc/passwd': '$(printf 'a%.0s' $(seq 64))' }"; do
	if fragment "{ ref: 'testref', files: $bad }" 2>&1 >/dev/null | grep -q 'invalid runner manifest'; then
		echo "ok: invalid manifest refused: $bad"
	else
		echo "FAIL: invalid manifest produced a fragment: $bad"; fail=1
	fi
done

# Case E: legacy single-file pin (runner_ref + runner_sha256) still boots.
serve_pristine
LEGACY_SHA=$(sha256sum "$SRC/box-runner.mjs" | cut -d' ' -f1)
fragment "m.runnerPinFromConfig({ runner_ref: 'testref', runner_sha256: '$LEGACY_SHA' })" \
	> "$WORK/legacy.sh" || { echo "LEGACY FRAGMENT GENERATION FAILED"; exit 1; }
rm -rf "$DEST"
if bash -euo pipefail "$WORK/legacy.sh" 2>/dev/null && cmp -s "$SRC/box-runner.mjs" "$DEST/box-runner.mjs"; then
	echo "ok: legacy single-file pin installed"
else
	echo "FAIL: legacy single-file pin was not installed"; fail=1
fi
echo 'console.log("evil")' >> "$SRC/box-runner.mjs"
rm -rf "$DEST"
if bash -euo pipefail "$WORK/legacy.sh" 2>/dev/null || [ -e "$DEST/box-runner.mjs" ]; then
	echo "FAIL: legacy pin accepted a tampered runner"; fail=1
else
	echo "ok: legacy pin rejects a tampered runner"
fi

exit $fail
