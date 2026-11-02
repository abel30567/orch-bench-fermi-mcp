#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every file of
# the pinned manifest into the same relative layout when all sha256s match, and
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
	rm -rf "$SRC" && mkdir -p "$SRC/harness" "$SRC/lib"
	echo 'console.log("runner ok")' > "$SRC/box-runner.mjs"
	echo 'export const harness = "claude"' > "$SRC/harness/claude.mjs"
	echo 'export const util = 1' > "$SRC/lib/util.mjs"
}

sha_of() { sha256sum "$1" | cut -d' ' -f1; }

serve_pristine
MANIFEST="{"
for f in $FILES; do MANIFEST="$MANIFEST\"$f\":\"$(sha_of "$SRC/$f")\","; done
MANIFEST="${MANIFEST%,}}"
ENTRY_SHA=$(sha_of "$SRC/box-runner.mjs")

# Emit the real fragment from the TS module (node >=23 strips types natively).
# $1 = JS expression for the fleet:config object.
fragment() {
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig($1)
  if (!pin) { console.error('PIN INVALID'); process.exit(3) }
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SRC', destDir: '$DEST' }))
})"
}

fragment "{ runner_ref: 'testref', runner_sha256: '$ENTRY_SHA', runner_files: $MANIFEST }" \
	> "$WORK/manifest.sh" || { echo "FRAGMENT GENERATION FAILED (manifest)"; exit 1; }
fragment "{ runner_ref: 'testref', runner_sha256: '$ENTRY_SHA' }" \
	> "$WORK/legacy.sh" || { echo "FRAGMENT GENERATION FAILED (legacy)"; exit 1; }

fail=0
# Files installed outside the staging dir (unverified downloads stay staged, never installed).
installed_count() {
	[ -d "$DEST" ] || { echo 0; return; }
	find "$DEST" -path "$DEST/.runner.new" -prune -o -type f -print | wc -l | tr -d ' '
}

# Case A: pristine manifest -> every file installed in the same layout, exit 0.
rm -rf "$DEST"
if ! bash -euo pipefail "$WORK/manifest.sh"; then
	echo "FAIL: pristine manifest refused"; fail=1
else
	ok=1
	for f in $FILES; do cmp -s "$SRC/$f" "$DEST/$f" || { echo "FAIL: $f not installed"; ok=0; fail=1; }; done
	[ -e "$DEST/.runner.new" ] && { echo "FAIL: staging dir left behind"; ok=0; fail=1; }
	[ $ok -eq 1 ] && echo "ok: pristine manifest installed ($FILES)"
fi

# Case B: tamper any one file -> refuse, nothing installed.
for f in $FILES; do
	serve_pristine; rm -rf "$DEST"
	echo '// evil' >> "$SRC/$f"
	if bash -euo pipefail "$WORK/manifest.sh" 2>/dev/null; then
		echo "FAIL: tampered $f accepted (exit 0)"; fail=1
	elif [ "$(installed_count)" != 0 ]; then
		echo "FAIL: tampered $f refused but files were installed"; fail=1
	else
		echo "ok: tampered $f rejected, nothing installed"
	fi
done

# Case C: omit any one file from what is served -> refuse, nothing installed.
for f in $FILES; do
	serve_pristine; rm -rf "$DEST"
	rm -f "$SRC/$f"
	if bash -euo pipefail "$WORK/manifest.sh" 2>/dev/null; then
		echo "FAIL: missing $f accepted (exit 0)"; fail=1
	elif [ "$(installed_count)" != 0 ]; then
		echo "FAIL: missing $f refused but files were installed"; fail=1
	else
		echo "ok: missing $f rejected, nothing installed"
	fi
done

# Case D: legacy single-file pin still boots; a tampered entry is still refused.
serve_pristine; rm -rf "$DEST"
if bash -euo pipefail "$WORK/legacy.sh" && cmp -s "$SRC/box-runner.mjs" "$DEST/box-runner.mjs"; then
	echo "ok: legacy single-file pin installed box-runner.mjs"
else
	echo "FAIL: legacy single-file pin did not boot"; fail=1
fi
rm -rf "$DEST"; echo '// evil' >> "$SRC/box-runner.mjs"
if bash -euo pipefail "$WORK/legacy.sh" 2>/dev/null || [ "$(installed_count)" != 0 ]; then
	echo "FAIL: legacy pin accepted a tampered runner"; fail=1
else
	echo "ok: legacy pin rejected a tampered runner"
fi

# Case E: a manifest that omits box-runner.mjs, or names an unsafe path, never
# yields a boot fragment.
NO_ENTRY="{\"lib/util.mjs\":\"$ENTRY_SHA\"}"
UNSAFE="{\"box-runner.mjs\":\"$ENTRY_SHA\",\"../etc/evil\":\"$ENTRY_SHA\"}"
for m in "$NO_ENTRY" "$UNSAFE"; do
	if fragment "{ runner_ref: 'testref', runner_sha256: '$ENTRY_SHA', runner_files: $m }" >/dev/null 2>&1; then
		echo "FAIL: invalid manifest produced a fragment: $m"; fail=1
	else
		echo "ok: invalid manifest refused: $m"
	fi
done

exit $fail
