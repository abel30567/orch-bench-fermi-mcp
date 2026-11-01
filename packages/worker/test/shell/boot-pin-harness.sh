#!/usr/bin/env bash
# Tamper harness for #34 / pr-55: the runner-fetch fragment must install every
# manifest file whose sha256 matches the pin, in the same relative layout, and
# must fail closed (non-zero, nothing installed) when ANY served file is
# tampered or missing. A legacy single-file pin must still install. Run from
# packages/worker:
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

seed() {
	local s
	rm -rf "$SRC"
	mkdir -p "$SRC/harness" "$SRC/lib"
	for s in $FILES; do echo "console.log('ok $s')" > "$SRC/$s"; done
}
seed

sha_of() { sha256sum "$SRC/$1" | cut -d' ' -f1; }
FILES_JSON="{$(for f in $FILES; do printf '"%s":"%s",' "$f" "$(sha_of "$f")"; done | sed 's/,$//')}"

# Emit the real fragment from the TS module (node >=23 strips types natively).
# $1 = config object literal fed to runnerPinFromConfig.
fragment() {
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig($1)
  if (!pin) { console.error('pin invalid'); process.exit(3) }
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SRC', dir: '$DEST' }))
})"
}

fragment "{ runner_ref: 'testref', runner_files: $FILES_JSON }" > "$WORK/manifest.sh" ||
	{ echo "FRAGMENT GENERATION FAILED (manifest)"; exit 1; }
fragment "{ runner_ref: 'testref', runner_sha256: '$(sha_of box-runner.mjs)' }" > "$WORK/legacy.sh" ||
	{ echo "FRAGMENT GENERATION FAILED (legacy)"; exit 1; }

fail=0
# The staging dir may hold partial downloads after a refusal; it is not an install.
installed_any() { [ -n "$(find "$DEST" -path "$DEST/.runner-stage" -prune -o -type f -print 2>/dev/null)" ]; }

# Case A: pristine manifest -> every file installed in the same layout, exit 0.
rm -rf "$DEST"
if bash -euo pipefail "$WORK/manifest.sh"; then
	ok=1
	for f in $FILES; do cmp -s "$SRC/$f" "$DEST/$f" || { echo "FAIL: $f not installed"; ok=0; }; done
	[ -e "$DEST/.runner-stage" ] && { echo "FAIL: staging dir left behind"; ok=0; }
	[ $ok -eq 1 ] && echo "ok: pristine manifest installed ($FILES)" || fail=1
else
	echo "FAIL: pristine manifest refused"; fail=1
fi

# Case B: tamper each file in turn -> refuse, nothing installed.
for f in $FILES; do
	seed; rm -rf "$DEST"
	echo 'console.log("evil")' >> "$SRC/$f"
	if bash -euo pipefail "$WORK/manifest.sh" 2>/dev/null; then
		echo "FAIL: tampered $f accepted (exit 0)"; fail=1
	elif installed_any; then
		echo "FAIL: tampered $f refused but files were installed"; fail=1
	else
		echo "ok: tampered $f rejected, nothing installed"
	fi
done

# Case C: omit each file in turn from the served tree -> refuse, nothing installed.
for f in $FILES; do
	seed; rm -rf "$DEST"
	rm -f "$SRC/$f"
	if bash -euo pipefail "$WORK/manifest.sh" 2>/dev/null; then
		echo "FAIL: missing $f accepted (exit 0)"; fail=1
	elif installed_any; then
		echo "FAIL: missing $f refused but files were installed"; fail=1
	else
		echo "ok: missing $f rejected, nothing installed"
	fi
done

# Case D: a manifest without box-runner.mjs is not a pin at all.
seed
if fragment "{ runner_ref: 'testref', runner_files: { 'lib/util.mjs': '$(sha_of lib/util.mjs)' } }" >/dev/null 2>&1; then
	echo "FAIL: manifest without box-runner.mjs produced a fragment"; fail=1
else
	echo "ok: manifest without box-runner.mjs refused"
fi

# Case E: legacy single-file pin -> box-runner.mjs installed, exit 0.
seed; rm -rf "$DEST"
if bash -euo pipefail "$WORK/legacy.sh" && cmp -s "$SRC/box-runner.mjs" "$DEST/box-runner.mjs"; then
	echo "ok: legacy single-file pin installed box-runner.mjs"
else
	echo "FAIL: legacy single-file pin did not install"; fail=1
fi

# Case F: legacy pin with a tampered runner -> refuse, nothing installed.
seed; rm -rf "$DEST"
echo 'console.log("evil")' > "$SRC/box-runner.mjs"
if bash -euo pipefail "$WORK/legacy.sh" 2>/dev/null; then
	echo "FAIL: tampered legacy runner accepted (exit 0)"; fail=1
elif installed_any; then
	echo "FAIL: tampered legacy runner refused but installed"; fail=1
else
	echo "ok: tampered legacy runner rejected, nothing installed"
fi

exit $fail
