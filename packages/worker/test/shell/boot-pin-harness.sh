#!/usr/bin/env bash
# Tamper harness for #34 / multi-file pins: the runner-fetch fragment must
# install every manifest file whose sha256 matches the pin into the same
# relative layout, and must fail closed (non-zero, nothing installed) when ANY
# served file is tampered or missing. A legacy single-file pin must still boot.
# Run from packages/worker:
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

SRC="$WORK/src"
DEST="$WORK/opt"
FILES="box-runner.mjs harness/index.mjs lib/util.mjs"

seed() {
	rm -rf "$SRC"
	mkdir -p "$SRC/harness" "$SRC/lib"
	echo 'import "./harness/index.mjs"; console.log("runner ok")' > "$SRC/box-runner.mjs"
	echo 'export const harness = "claude"' > "$SRC/harness/index.mjs"
	echo 'export const util = 1' > "$SRC/lib/util.mjs"
}
sha() { sha256sum "$1" | cut -d' ' -f1; }

seed
MANIFEST="{"
for f in $FILES; do MANIFEST="$MANIFEST\"$f\":\"$(sha "$SRC/$f")\","; done
MANIFEST="${MANIFEST%,}}"
LEGACY_SHA=$(sha "$SRC/box-runner.mjs")

# Emit the real fragments from the TS module (node >=23 strips types natively).
gen() { # $1 = files JSON, $2 = output
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig($1)
  if (!pin) throw new Error('pin invalid')
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SRC', destDir: '$DEST' }))
})" > "$2" || { echo "FRAGMENT GENERATION FAILED"; exit 1; }
}
gen "{ runner_ref: 'testref', runner_files: $MANIFEST }" "$WORK/manifest.sh"
gen "{ runner_ref: 'testref', runner_sha256: '$LEGACY_SHA' }" "$WORK/legacy.sh"

fail=0
installed_any() {
	for f in $FILES; do [ -e "$DEST/$f" ] && return 0; done
	return 1
}
expect_boot() { # $1 = fragment, $2 = label, $3.. = files that must be installed
	local frag=$1 label=$2; shift 2
	rm -rf "$DEST"; mkdir -p "$DEST"
	if ! bash -euo pipefail "$frag"; then
		echo "FAIL: $label did not boot"; fail=1; return
	fi
	for f in "$@"; do
		if ! cmp -s "$SRC/$f" "$DEST/$f"; then echo "FAIL: $label missing/wrong $f"; fail=1; return; fi
	done
	echo "ok: $label installed"
}
expect_refuse() { # $1 = label
	rm -rf "$DEST"; mkdir -p "$DEST"
	if bash -euo pipefail "$WORK/manifest.sh" 2>/dev/null; then
		echo "FAIL: $1 accepted (exit 0)"; fail=1
	elif installed_any; then
		echo "FAIL: $1 installed files despite non-zero exit"; fail=1
	else
		echo "ok: $1 rejected, nothing installed"
	fi
}

# Case A: pristine manifest -> every file installed in the same layout.
expect_boot "$WORK/manifest.sh" "pristine manifest" $FILES

# Case B: tampering ANY one file -> refuse.
for f in $FILES; do
	seed
	echo '// evil' >> "$SRC/$f"
	expect_refuse "tampered $f"
done

# Case C: omitting ANY one file -> refuse.
for f in $FILES; do
	seed
	rm -f "$SRC/$f"
	expect_refuse "missing $f"
done

# Case D: legacy single-file pin still boots.
seed
expect_boot "$WORK/legacy.sh" "legacy single-file pin" box-runner.mjs

# Case E: legacy pin with a tampered runner -> refuse.
echo '// evil' >> "$SRC/box-runner.mjs"
rm -rf "$DEST"; mkdir -p "$DEST"
if bash -euo pipefail "$WORK/legacy.sh" 2>/dev/null || [ -e "$DEST/box-runner.mjs" ]; then
	echo "FAIL: tampered legacy runner accepted"; fail=1
else
	echo "ok: tampered legacy runner rejected, nothing installed"
fi

exit $fail
