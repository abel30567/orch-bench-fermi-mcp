#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every file of
# the pinned manifest (same relative layout) when all hashes match, and must
# fail closed (non-zero, nothing installed) when any one file is tampered or
# missing. A legacy single-file pin must still install. Run from packages/worker:
#   bash test/shell/boot-pin-harness.sh
set -u
cd "$(dirname "$0")/../.."

WORK=$(mktemp -d)
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
DEST="$WORK/dest"

# Serve a pristine tree: every file gets distinct content.
serve_pristine() {
	local p
	rm -rf "$SRC"
	mkdir -p "$SRC/harness" "$SRC/lib"
	for p in $FILES; do echo "console.log('pristine $p')" > "$SRC/$p"; done
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
})"
}

nothing_installed() {
	local p
	for p in $FILES; do [ -e "$DEST/$p" ] && return 1; done
	return 0
}

fail=0

serve_pristine
MANIFEST="{"
for f in $FILES; do MANIFEST="$MANIFEST\"$f\": \"$(sha "$SRC/$f")\","; done
MANIFEST="${MANIFEST%,}}"
fragment "$MANIFEST" > "$WORK/fragment.sh" || { echo "FRAGMENT GENERATION FAILED"; exit 1; }

# Case A: pristine manifest -> every file installed in its relative layout, exit 0.
rm -rf "$DEST"
if bash -euo pipefail "$WORK/fragment.sh"; then
	ok=1
	for f in $FILES; do cmp -s "$SRC/$f" "$DEST/$f" || ok=0; done
	if [ $ok -eq 1 ]; then echo "ok: pristine manifest installed"; else
		echo "FAIL: pristine manifest exited 0 but files are missing or wrong"; fail=1
	fi
else
	echo "FAIL: pristine manifest was not installed"; fail=1
fi

# Case B: tamper each file in turn -> must NOT install anything, non-zero exit.
for f in $FILES; do
	serve_pristine
	echo "console.log('evil')" > "$SRC/$f"
	rm -rf "$DEST"
	if bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null; then
		echo "FAIL: tampered $f accepted (exit 0)"; fail=1
	elif ! nothing_installed; then
		echo "FAIL: tampered $f: files installed despite non-zero exit"; fail=1
	else
		echo "ok: tampered $f rejected, nothing installed"
	fi
done

# Case C: omit each file in turn from the served tree -> refuse, nothing installed.
for f in $FILES; do
	serve_pristine
	rm -f "$SRC/$f"
	rm -rf "$DEST"
	if bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null; then
		echo "FAIL: missing $f accepted (exit 0)"; fail=1
	elif ! nothing_installed; then
		echo "FAIL: missing $f: files installed despite non-zero exit"; fail=1
	else
		echo "ok: missing $f rejected, nothing installed"
	fi
done

# Case D: a manifest that omits box-runner.mjs is refused at generation time.
serve_pristine
if fragment "{\"lib/util.mjs\": \"$(sha "$SRC/lib/util.mjs")\"}" > /dev/null 2>&1; then
	echo "FAIL: manifest without box-runner.mjs produced a fragment"; fail=1
else
	echo "ok: manifest without box-runner.mjs refused"
fi

# Case E: legacy single-file pin (runner_ref + runner_sha256) still boots.
serve_pristine
rm -rf "$DEST"
node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig({ runner_ref: 'testref', runner_sha256: '$(sha "$SRC/box-runner.mjs")' })
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SRC', destDir: '$DEST' }))
})" > "$WORK/legacy.sh" || { echo "LEGACY FRAGMENT GENERATION FAILED"; exit 1; }
if bash -euo pipefail "$WORK/legacy.sh" && cmp -s "$SRC/box-runner.mjs" "$DEST/box-runner.mjs"; then
	echo "ok: legacy single-file pin installed"
else
	echo "FAIL: legacy single-file pin did not install"; fail=1
fi

exit $fail
