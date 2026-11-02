#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every file in
# the pinned manifest into the same relative layout when all sha256s match,
# and must fail closed (non-zero, nothing installed) when any one file is
# tampered or missing. Also covers a legacy single-file pin. Run from
# packages/worker:
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

FILES="box-runner.mjs harness/claude.mjs lib/util.mjs"
SRC="$WORK/src"   # the "served" tree (stands in for raw.githubusercontent.com/<ref>/)
DEST="$WORK/opt"  # install dir (stands in for /opt/fermi)

serve_pristine() {
	rm -rf "$SRC"
	mkdir -p "$SRC/harness" "$SRC/lib"
	echo 'console.log("runner ok")' > "$SRC/box-runner.mjs"
	echo 'export const harness = "claude"' > "$SRC/harness/claude.mjs"
	echo 'export const util = 1' > "$SRC/lib/util.mjs"
}

serve_pristine
MANIFEST="{"
for f in $FILES; do
	MANIFEST="$MANIFEST\"$f\": \"$(sha256sum "$SRC/$f" | cut -d' ' -f1)\","
done
MANIFEST="${MANIFEST%,}}"
RUNNER_SHA=$(sha256sum "$SRC/box-runner.mjs" | cut -d' ' -f1)

# Emit the real fragment from the TS module (node >=23 strips types natively).
# The harness turns curl retries off (file:// errors are permanent) so a
# missing-file case doesn't sit through the production backoff.
gen() { # $1 = JS expression for the fleet:config pin fields, $2 = output
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig($1)
  if (!pin) throw new Error('pin invalid')
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SRC', dir: '$DEST' }))
})" > "$2.raw" || { echo "FRAGMENT GENERATION FAILED"; exit 1; }
	sed 's/--retry 4 /--retry 0 /' "$2.raw" > "$2"
}
gen "{ runner_ref: 'testref', runner_sha256: '$RUNNER_SHA', runner_files: $MANIFEST }" "$WORK/manifest.sh"
gen "{ runner_ref: 'testref', runner_sha256: '$RUNNER_SHA' }" "$WORK/legacy.sh"

fail=0
nothing_installed() {
	[ -z "$(find "$DEST" -name '*.mjs' -not -path '*/.runner-stage/*' 2>/dev/null)" ]
}
expect_refused() { # $1 = fragment, $2 = label
	if bash -euo pipefail "$1" 2>/dev/null; then
		echo "FAIL: $2 accepted (exit 0)"; fail=1
	elif ! nothing_installed; then
		echo "FAIL: $2 installed files despite non-zero exit"; fail=1
	else
		echo "ok: $2 rejected, nothing installed"
	fi
}

# Case A: pristine manifest -> every file installed in the same layout, exit 0.
rm -rf "$DEST"
if ! bash -euo pipefail "$WORK/manifest.sh"; then
	echo "FAIL: pristine manifest was not installed"; fail=1
else
	a_ok=1
	for f in $FILES; do
		if ! cmp -s "$SRC/$f" "$DEST/$f"; then echo "FAIL: $f not installed at $DEST/$f"; a_ok=0; fi
	done
	if [ -d "$DEST/.runner-stage" ]; then echo "FAIL: staging dir left behind"; a_ok=0; fi
	if [ $a_ok -eq 1 ]; then echo "ok: pristine manifest installed ($FILES)"; else fail=1; fi
fi

# Case B: tamper any one file -> refuse, nothing installed.
for f in $FILES; do
	serve_pristine; rm -rf "$DEST"
	echo '// evil' >> "$SRC/$f"
	expect_refused "$WORK/manifest.sh" "tampered $f"
done

# Case C: omit any one file -> refuse, nothing installed.
for f in $FILES; do
	serve_pristine; rm -rf "$DEST"
	rm -f "$SRC/$f"
	expect_refused "$WORK/manifest.sh" "missing $f"
done

# Case D: legacy single-file pin (runner_ref + runner_sha256) still boots.
serve_pristine; rm -rf "$DEST"
if bash -euo pipefail "$WORK/legacy.sh" && cmp -s "$SRC/box-runner.mjs" "$DEST/box-runner.mjs"; then
	echo "ok: legacy single-file pin installed box-runner.mjs"
else
	echo "FAIL: legacy single-file pin did not boot"; fail=1
fi

# Case E: legacy pin with a tampered runner -> refuse, nothing installed.
rm -rf "$DEST"
echo '// evil' >> "$SRC/box-runner.mjs"
expect_refused "$WORK/legacy.sh" "legacy pin, tampered box-runner.mjs"

exit $fail
