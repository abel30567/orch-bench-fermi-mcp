#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every file of
# the pinned manifest into the same relative layout when all hashes match, and
# must fail closed (non-zero, nothing installed) when any one served file is
# tampered or missing. A legacy single-file pin (runner_ref + runner_sha256)
# must still boot. Run from packages/worker:
#   bash test/shell/boot-pin-harness.sh
set -u
cd "$(dirname "$0")/../.."

WORK=$(mktemp -d "${TMPDIR:-/tmp}/boot-pin.XXXXXX")
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
FILES="box-runner.mjs harness/claude.mjs lib/util.mjs"

# Serve a pristine daemon tree at $SRC.
seed() {
	rm -rf "$SRC"
	mkdir -p "$SRC/harness" "$SRC/lib"
	echo 'import "./lib/util.mjs"; console.log("runner ok")' > "$SRC/box-runner.mjs"
	echo 'export const harness = "claude"' > "$SRC/harness/claude.mjs"
	echo 'export const util = 1' > "$SRC/lib/util.mjs"
}
sha() { sha256sum "$SRC/$1" | cut -d' ' -f1; }

# Emit the real fragment from the TS module (node >=23 strips types natively).
# $1 is a fleet:config JSON; the pin goes through runnerPinFromConfig exactly as
# the provisioner reads it. Prints NULL_PIN / THROWS for rejected pins.
fragment() {
	CONFIG="$1" node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig(JSON.parse(process.env.CONFIG))
  if (!pin) { console.log('NULL_PIN'); return }
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SRC', destDir: '$DEST' }))
})"
}

fail=0
ok() { echo "ok: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

# Nothing from the manifest may be installed after a refused boot.
nothing_installed() {
	local f
	for f in $FILES; do [ -e "$DEST/$f" ] && return 1; done
	return 0
}

boot() { rm -rf "$DEST"; mkdir -p "$DEST"; bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null; }

expect_refused() {
	if boot; then
		bad "$1 accepted (exit 0)"
	elif ! nothing_installed; then
		bad "$1 refused but files were installed"
	else
		ok "$1 refused, nothing installed"
	fi
}

# --- Legacy single-file pin ------------------------------------------------
seed
fragment "{\"runner_ref\":\"testref\",\"runner_sha256\":\"$(sha box-runner.mjs)\"}" > "$WORK/fragment.sh" \
	|| { echo "FRAGMENT GENERATION FAILED"; exit 1; }
if boot && [ -f "$DEST/box-runner.mjs" ] && cmp -s "$SRC/box-runner.mjs" "$DEST/box-runner.mjs"; then
	ok "legacy single-file pin boots"
else
	bad "legacy single-file pin did not install box-runner.mjs"
fi
echo 'console.log("evil")' > "$SRC/box-runner.mjs"
expect_refused "legacy pin with tampered box-runner.mjs"

# --- Multi-file manifest ---------------------------------------------------
seed
MANIFEST="{\"box-runner.mjs\":\"$(sha box-runner.mjs)\",\"harness/claude.mjs\":\"$(sha harness/claude.mjs)\",\"lib/util.mjs\":\"$(sha lib/util.mjs)\"}"
fragment "{\"runner_ref\":\"testref\",\"runner_sha256\":\"$(sha box-runner.mjs)\",\"runner_files\":$MANIFEST}" > "$WORK/fragment.sh" \
	|| { echo "FRAGMENT GENERATION FAILED"; exit 1; }
if boot; then
	all=1
	for f in $FILES; do cmp -s "$SRC/$f" "$DEST/$f" || all=0; done
	[ $all -eq 1 ] && ok "pristine manifest installs every file in layout" \
		|| bad "pristine manifest boot did not install every file"
else
	bad "pristine manifest refused"
fi

for f in $FILES; do
	seed
	echo '// tampered' >> "$SRC/$f"
	expect_refused "manifest with tampered $f"

	seed
	rm -f "$SRC/$f"
	expect_refused "manifest with missing $f"
done

# --- Invalid manifests never yield a pin -----------------------------------
seed
for cfg in \
	"{\"runner_ref\":\"testref\",\"runner_files\":{\"lib/util.mjs\":\"$(sha lib/util.mjs)\"}}" \
	"{\"runner_ref\":\"testref\",\"runner_files\":{\"box-runner.mjs\":\"$(sha box-runner.mjs)\",\"../etc/x\":\"$(sha lib/util.mjs)\"}}"; do
	out=$(fragment "$cfg")
	[ "$out" = "NULL_PIN" ] && ok "invalid manifest yields no pin" || bad "invalid manifest produced a fragment: $cfg"
done

exit $fail
