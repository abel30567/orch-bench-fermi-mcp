#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every manifest
# file whose sha256 matches the pin, and must fail closed (non-zero, nothing
# installed) when any one served file is tampered or missing. Also covers the
# legacy single-file pin. Run from packages/worker:
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

SRC="$WORK/src"
DEST="$WORK/install"
FILES="box-runner.mjs harness/index.mjs lib/util.mjs"

seed() {
	rm -rf "$SRC"
	mkdir -p "$SRC/harness" "$SRC/lib"
	echo 'console.log("runner ok")' > "$SRC/box-runner.mjs"
	echo 'export const harness = "claude"' > "$SRC/harness/index.mjs"
	echo 'export const util = 1' > "$SRC/lib/util.mjs"
}

# Emit the real fragment from the TS module (node >=23 strips types natively).
# $1 = JSON manifest of files.
fragment() {
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig($1)
  if (!pin) { console.error('pin rejected'); process.exit(1) }
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SRC', dest: '$DEST' }))
})" > "$WORK/fragment.sh" || { echo "FRAGMENT GENERATION FAILED"; exit 1; }
}

sha() { sha256sum "$1" | cut -d' ' -f1; }

installed_any() {
	local f
	for f in $FILES; do [ -e "$DEST/$f" ] && return 0; done
	return 1
}

fail=0

seed
MANIFEST="{ runner_ref: 'testref', runner_files: {"
for f in $FILES; do MANIFEST="$MANIFEST '$f': '$(sha "$SRC/$f")',"; done
MANIFEST="$MANIFEST } }"
fragment "$MANIFEST"

# Case A: pristine manifest -> every file installed in the same layout, exit 0.
rm -rf "$DEST"
if ! bash -euo pipefail "$WORK/fragment.sh"; then
	echo "FAIL: pristine manifest was rejected"; fail=1
else
	ok=1
	for f in $FILES; do cmp -s "$SRC/$f" "$DEST/$f" || ok=0; done
	if [ $ok -eq 1 ]; then echo "ok: pristine manifest installed"; else echo "FAIL: pristine files not installed"; fail=1; fi
fi

# Case B: tamper each file in turn -> must NOT install anything, non-zero exit.
for f in $FILES; do
	seed; rm -rf "$DEST"
	echo '// evil' >> "$SRC/$f"
	if bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null; then
		echo "FAIL: tampered $f accepted (exit 0)"; fail=1
	elif installed_any; then
		echo "FAIL: files installed despite tampered $f"; fail=1
	else
		echo "ok: tampered $f rejected, nothing installed"
	fi
done

# Case C: omit each file in turn -> must NOT install anything, non-zero exit.
# (curl's --retry makes each miss take ~12s.)
for f in $FILES; do
	seed; rm -rf "$DEST"
	rm -f "$SRC/$f"
	if bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null; then
		echo "FAIL: missing $f accepted (exit 0)"; fail=1
	elif installed_any; then
		echo "FAIL: files installed despite missing $f"; fail=1
	else
		echo "ok: missing $f rejected, nothing installed"
	fi
done

# Case D: legacy single-file pin (runner_sha256 only) still boots, and still
# refuses a tampered runner.
seed; rm -rf "$DEST"
fragment "{ runner_ref: 'testref', runner_sha256: '$(sha "$SRC/box-runner.mjs")' }"
if bash -euo pipefail "$WORK/fragment.sh" && cmp -s "$SRC/box-runner.mjs" "$DEST/box-runner.mjs"; then
	echo "ok: legacy single-file pin installed"
else
	echo "FAIL: legacy single-file pin did not install"; fail=1
fi
rm -rf "$DEST"
echo '// evil' >> "$SRC/box-runner.mjs"
if bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null || [ -e "$DEST/box-runner.mjs" ]; then
	echo "FAIL: legacy pin accepted a tampered runner"; fail=1
else
	echo "ok: legacy pin rejected tampered runner"
fi

exit $fail
