#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every file of
# the pinned manifest (same relative layout) when all sha256s match, and must
# fail closed (non-zero, nothing installed) when any one file is tampered or
# missing. A legacy single-file pin must still boot. Run from packages/worker:
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

SERVED="$WORK/served"
DEST="$WORK/opt"
FILES="box-runner.mjs harness/claude.mjs lib/util.mjs"

serve_pristine() {
	rm -rf "$SERVED"
	mkdir -p "$SERVED/harness" "$SERVED/lib"
	local p
	for p in $FILES; do echo "console.log('$p ok')" > "$SERVED/$p"; done
}

sha() { sha256sum "$1" | cut -d' ' -f1; }

# Emit the real fragment from the TS module (node >=23 strips types natively).
# $1 = JS expression for the pin, evaluated with the module bound to `m`.
gen() {
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = $1
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SERVED', dir: '$DEST' }))
})" > "$WORK/fragment.sh"
}

# Files under the install dir, excluding the fragment's staging area.
installed_count() {
	find "$DEST" -path "$DEST/.runner-staging" -prune -o -type f -print 2>/dev/null | wc -l | tr -d ' '
}

fail=0
pass() { echo "ok: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

# Boot must refuse (non-zero) and leave nothing installed.
expect_refused() {
	rm -rf "$DEST"
	if bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null; then
		bad "$1 accepted (exit 0)"
	elif [ "$(installed_count)" != "0" ]; then
		bad "$1 installed files despite non-zero exit"
	else
		pass "$1 rejected, nothing installed"
	fi
}

serve_pristine
MANIFEST="{"
for f in $FILES; do MANIFEST="$MANIFEST\"$f\": \"$(sha "$SERVED/$f")\","; done
MANIFEST="${MANIFEST%,}}"
gen "({ ref: 'testref', files: $MANIFEST })" || { echo "FRAGMENT GENERATION FAILED"; exit 1; }
cp "$WORK/fragment.sh" "$WORK/manifest-fragment.sh"

# Case A: pristine manifest -> every file installed in the same layout, exit 0.
rm -rf "$DEST"
if bash -euo pipefail "$WORK/fragment.sh"; then
	ok=1
	for f in $FILES; do cmp -s "$SERVED/$f" "$DEST/$f" || ok=0; done
	[ "$(installed_count)" = "3" ] || ok=0
	if [ $ok = 1 ]; then pass "pristine manifest installed (3 files, same layout)"; else bad "pristine manifest layout wrong"; fi
else
	bad "pristine manifest was refused"
fi

# Case B: tamper each file in turn -> refuse.
for f in $FILES; do
	serve_pristine
	echo 'console.log("evil")' > "$SERVED/$f"
	expect_refused "tampered $f"
done

# Case C: omit each file in turn from what is served -> refuse.
for f in $FILES; do
	serve_pristine
	rm -f "$SERVED/$f"
	expect_refused "missing $f"
done

# Case D: legacy single-file pin (runner_sha256 only) still boots.
serve_pristine
gen "m.runnerPinFromConfig({ runner_ref: 'testref', runner_sha256: '$(sha "$SERVED/box-runner.mjs")' })" \
	|| { echo "LEGACY FRAGMENT GENERATION FAILED"; exit 1; }
rm -rf "$DEST"
if bash -euo pipefail "$WORK/fragment.sh" && cmp -s "$SERVED/box-runner.mjs" "$DEST/box-runner.mjs" \
	&& [ "$(installed_count)" = "1" ]; then
	pass "legacy single-file pin installed"
else
	bad "legacy single-file pin did not boot"
fi
echo 'console.log("evil")' > "$SERVED/box-runner.mjs"
expect_refused "legacy pin with tampered box-runner.mjs"

# Case E: a manifest without box-runner.mjs, or with an unsafe path, never
# yields a boot script.
for pin in \
	"({ ref: 'testref', files: { 'lib/util.mjs': '$(printf 'a%.0s' {1..64})' } })" \
	"({ ref: 'testref', files: { 'box-runner.mjs': '$(printf 'a%.0s' {1..64})', '../etc/x': '$(printf 'a%.0s' {1..64})' } })"; do
	if gen "$pin" 2>/dev/null; then bad "invalid manifest produced a fragment: $pin"; else pass "invalid manifest refused"; fi
done

exit $fail
