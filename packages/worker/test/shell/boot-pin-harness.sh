#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every manifest
# file whose sha256 matches the pin, into the same relative layout, and must
# fail closed (non-zero, nothing installed) when ANY served file is tampered or
# missing. A legacy single-file pin must still boot. Run from packages/worker:
#   bash test/shell/boot-pin-harness.sh
set -u
cd "$(dirname "$0")/../.."

WORK=$(mktemp -d "${TMPDIR:-/tmp}/boot-pin.XXXXXX") || { echo "MKTEMP FAILED"; exit 1; }
trap 'rm -rf "$WORK"' EXIT
# The fragment stages downloads under $TMPDIR; keep them inside $WORK.
export TMPDIR="$WORK"

# macOS lacks sha256sum; shim it onto shasum.
if ! command -v sha256sum >/dev/null 2>&1; then
	mkdir -p "$WORK/bin"
	printf '#!/bin/sh\nexec shasum -a 256 "$@"\n' > "$WORK/bin/sha256sum"
	chmod +x "$WORK/bin/sha256sum"
	export PATH="$WORK/bin:$PATH"
fi

SRC="$WORK/src"
DEST="$WORK/dest"
FILES="box-runner.mjs harness/claude.mjs lib/util.mjs"

# Serve a pristine copy of every manifest file from $SRC.
reset_src() {
	rm -rf "$SRC" "$DEST"
	mkdir -p "$SRC/harness" "$SRC/lib" "$DEST"
	echo 'console.log("runner ok")' > "$SRC/box-runner.mjs"
	echo 'export const harness = "claude"' > "$SRC/harness/claude.mjs"
	echo 'export const util = 1' > "$SRC/lib/util.mjs"
}

sha() { sha256sum "$1" | cut -d' ' -f1; }

# Emit the real fragment from the TS module (node >=23 strips types natively).
# $1 = JSON files manifest.
fragment() {
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  console.log(m.runnerFetchScript(
    { ref: 'testref', files: $1 },
    { baseUrl: 'file://$SRC', destDir: '$DEST' },
  ))
})" > "$WORK/fragment.sh" || { echo "FRAGMENT GENERATION FAILED"; exit 1; }
}

installed_any() { [ -n "$(find "$DEST" -type f 2>/dev/null)" ]; }

fail=0

reset_src
MANIFEST="{\"box-runner.mjs\":\"$(sha "$SRC/box-runner.mjs")\",\"harness/claude.mjs\":\"$(sha "$SRC/harness/claude.mjs")\",\"lib/util.mjs\":\"$(sha "$SRC/lib/util.mjs")\"}"
fragment "$MANIFEST"

# Case A: pristine manifest -> every file installed in the same layout, exit 0.
if ! bash -euo pipefail "$WORK/fragment.sh"; then
	echo "FAIL: pristine manifest did not boot"; fail=1
else
	ok=1
	for f in $FILES; do
		cmp -s "$SRC/$f" "$DEST/$f" || { echo "FAIL: $f not installed at $DEST/$f"; ok=0; fail=1; }
	done
	[ $ok -eq 1 ] && echo "ok: pristine manifest installed (box-runner.mjs, harness/, lib/)"
fi

# Case B: tamper each file in turn -> must refuse, nothing installed.
for f in $FILES; do
	reset_src
	echo '// evil' >> "$SRC/$f"
	if bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null; then
		echo "FAIL: tampered $f accepted (exit 0)"; fail=1
	elif installed_any; then
		echo "FAIL: tampered $f refused but files were installed"; fail=1
	else
		echo "ok: tampered $f rejected, nothing installed"
	fi
done

# Case C: omit each file in turn -> must refuse, nothing installed.
for f in $FILES; do
	reset_src
	rm -f "$SRC/$f"
	if bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null; then
		echo "FAIL: missing $f accepted (exit 0)"; fail=1
	elif installed_any; then
		echo "FAIL: missing $f refused but files were installed"; fail=1
	else
		echo "ok: missing $f rejected, nothing installed"
	fi
done

# Case D: legacy single-file pin -> box-runner.mjs installed, exit 0.
reset_src
fragment "{\"box-runner.mjs\":\"$(sha "$SRC/box-runner.mjs")\"}"
if bash -euo pipefail "$WORK/fragment.sh" && cmp -s "$SRC/box-runner.mjs" "$DEST/box-runner.mjs"; then
	echo "ok: legacy single-file pin installed"
else
	echo "FAIL: legacy single-file pin did not boot"; fail=1
fi

# Case E: legacy single-file pin, tampered -> refused.
rm -rf "$DEST"; mkdir -p "$DEST"
echo 'console.log("evil")' > "$SRC/box-runner.mjs"
if bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null || installed_any; then
	echo "FAIL: tampered legacy runner accepted or installed"; fail=1
else
	echo "ok: tampered legacy runner rejected, nothing installed"
fi

exit $fail
