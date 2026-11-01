#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every pinned
# file whose sha256 matches the manifest, into the same relative layout, and
# must fail closed (non-zero, nothing installed) when any one served file is
# tampered or missing. A legacy single-file pin must still boot. Run from
# packages/worker:
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

SRC="$WORK/src"
DEST="$WORK/dest"
FILES="box-runner.mjs lib/util.mjs harness/claude.mjs"

serve_pristine() {
	rm -rf "$SRC" && mkdir -p "$SRC/lib" "$SRC/harness"
	echo 'console.log("runner ok")' > "$SRC/box-runner.mjs"
	echo 'export const util = 1' > "$SRC/lib/util.mjs"
	echo 'export const harness = "claude"' > "$SRC/harness/claude.mjs"
}

sha() { sha256sum "$1" | cut -d' ' -f1; }

serve_pristine
MANIFEST="{"
for f in $FILES; do MANIFEST="$MANIFEST\"$f\":\"$(sha "$SRC/$f")\","; done
MANIFEST="${MANIFEST%,}}"

# Emit the real fragments from the TS module (node >=23 strips types natively),
# resolving the pin exactly as the provisioner does (runnerPinFromConfig).
gen() {
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig($1)
  if (!pin) throw new Error('pin rejected')
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SRC', destDir: '$DEST' }))
})"
}
gen "{ runner_ref: 'testref', runner_sha256: '$(sha "$SRC/box-runner.mjs")' }" > "$WORK/legacy.sh" \
	|| { echo "LEGACY FRAGMENT GENERATION FAILED"; exit 1; }
gen "{ runner_ref: 'testref', runner_sha256: null, runner_files: $MANIFEST }" > "$WORK/manifest.sh" \
	|| { echo "MANIFEST FRAGMENT GENERATION FAILED"; exit 1; }
# Missing-file cases: same fragment minus curl's retry backoff (a missing
# file:// would otherwise retry for ~12s). Verification logic is untouched.
sed 's/ --retry 4 --retry-delay 3 --retry-all-errors//' "$WORK/manifest.sh" > "$WORK/manifest-noretry.sh"

fail=0
reset_dest() { rm -rf "$DEST" && mkdir -p "$DEST"; }
installed_count() { find "$DEST" -type f -not -path '*/.runner-stage/*' | wc -l | tr -d ' '; }

expect_refused() { # $1 = label, $2 = fragment
	if bash -euo pipefail "$2" 2>/dev/null; then
		echo "FAIL: $1 accepted (exit 0)"; fail=1
	elif [ "$(installed_count)" != 0 ]; then
		echo "FAIL: $1 refused but files were installed"; fail=1
	else
		echo "ok: $1 refused, nothing installed"
	fi
}

# Case A: legacy single-file pin, pristine -> installs box-runner.mjs.
reset_dest
if bash -euo pipefail "$WORK/legacy.sh" && [ -f "$DEST/box-runner.mjs" ]; then
	echo "ok: legacy single-file pin installed"
else
	echo "FAIL: legacy single-file pin was not installed"; fail=1
fi

# Case B: legacy pin, tampered runner -> refuses.
reset_dest
echo 'console.log("evil")' > "$SRC/box-runner.mjs"
expect_refused "legacy tampered runner" "$WORK/legacy.sh"
serve_pristine

# Case C: manifest, pristine -> every file installed in the same layout.
reset_dest
if bash -euo pipefail "$WORK/manifest.sh"; then
	for f in $FILES; do
		if ! cmp -s "$SRC/$f" "$DEST/$f"; then echo "FAIL: $f not installed at $DEST/$f"; fail=1; fi
	done
	[ -e "$DEST/.runner-stage" ] && { echo "FAIL: staging dir left behind"; fail=1; }
	echo "ok: manifest installed ($(installed_count) files)"
else
	echo "FAIL: pristine manifest was not installed"; fail=1
fi

# Case D: tamper any one file -> refuses, nothing installed.
for f in $FILES; do
	serve_pristine; reset_dest
	echo '// evil' >> "$SRC/$f"
	expect_refused "manifest with tampered $f" "$WORK/manifest.sh"
done

# Case E: omit any one file -> refuses, nothing installed.
for f in $FILES; do
	serve_pristine; reset_dest
	rm -f "$SRC/$f"
	expect_refused "manifest with missing $f" "$WORK/manifest-noretry.sh"
done

exit $fail
