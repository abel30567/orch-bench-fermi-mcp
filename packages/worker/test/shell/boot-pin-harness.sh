#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every file of
# the pinned manifest whose sha256 matches, and must fail closed (non-zero,
# nothing installed) when any one served file is tampered or missing. A legacy
# single-file pin (runner_ref + runner_sha256) must still boot. Run from
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
# Missing-file cases would otherwise wait out curl's retry backoff.
mkdir -p "$WORK/bin"
REAL_CURL=$(command -v curl)
printf '#!/bin/sh\nexec "%s" "$@" --retry 0\n' "$REAL_CURL" > "$WORK/bin/curl"
chmod +x "$WORK/bin/curl"
export PATH="$WORK/bin:$PATH"

FILES="box-runner.mjs harness/claude.mjs lib/util.mjs"
SRC="$WORK/served"
DEST="$WORK/opt"

serve_pristine() {
	rm -rf "$SRC" && mkdir -p "$SRC/harness" "$SRC/lib"
	echo 'console.log("runner ok")' > "$SRC/box-runner.mjs"
	echo 'export const harness = "claude"' > "$SRC/harness/claude.mjs"
	echo 'export const util = 1' > "$SRC/lib/util.mjs"
}
sha() { sha256sum "$1" | cut -d' ' -f1; }

serve_pristine

# Emit the real fragments from the TS module (node >=23 strips types natively),
# going through runnerPinFromConfig exactly as the provisioner does.
gen() { # $1 = config JSON, $2 = output file
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig($1)
  if (!pin) { console.error('pin rejected'); process.exit(1) }
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SRC', dir: '$DEST' }))
})" > "$2" || { echo "FRAGMENT GENERATION FAILED"; exit 1; }
}

MANIFEST="{"
for f in $FILES; do MANIFEST="$MANIFEST\"$f\": \"$(sha "$SRC/$f")\","; done
MANIFEST="${MANIFEST%,}}"
gen "{ runner_ref: 'testref', runner_sha256: '$(sha "$SRC/box-runner.mjs")', runner_files: $MANIFEST }" "$WORK/manifest.sh"
gen "{ runner_ref: 'testref', runner_sha256: '$(sha "$SRC/box-runner.mjs")' }" "$WORK/legacy.sh"

fail=0

installed_any() {
	local g
	for g in $FILES; do [ -e "$DEST/$g" ] && return 0; done
	return 1
}

# Case A: pristine manifest -> every file installed in the same layout, exit 0.
rm -rf "$DEST"
if bash -euo pipefail "$WORK/manifest.sh"; then
	ok=1
	for f in $FILES; do cmp -s "$SRC/$f" "$DEST/$f" || ok=0; done
	if [ $ok -eq 1 ]; then echo "ok: pristine manifest installed"; else
		echo "FAIL: pristine manifest not installed in layout"; fail=1; fi
else
	echo "FAIL: pristine manifest boot exited non-zero"; fail=1
fi

# Case B: each file tampered in turn -> must NOT install anything, non-zero exit.
for f in $FILES; do
	serve_pristine
	echo 'console.log("evil")' >> "$SRC/$f"
	rm -rf "$DEST"
	if bash -euo pipefail "$WORK/manifest.sh" 2>/dev/null; then
		echo "FAIL: tampered $f accepted (exit 0)"; fail=1
	elif installed_any; then
		echo "FAIL: files installed despite tampered $f"; fail=1
	else
		echo "ok: tampered $f rejected, nothing installed"
	fi
done

# Case C: each file omitted in turn -> must NOT install anything, non-zero exit.
for f in $FILES; do
	serve_pristine
	rm -f "$SRC/$f"
	rm -rf "$DEST"
	if bash -euo pipefail "$WORK/manifest.sh" 2>/dev/null; then
		echo "FAIL: missing $f accepted (exit 0)"; fail=1
	elif installed_any; then
		echo "FAIL: files installed despite missing $f"; fail=1
	else
		echo "ok: missing $f rejected, nothing installed"
	fi
done

# Case D: legacy single-file pin -> box-runner.mjs installed, exit 0.
serve_pristine
rm -rf "$DEST"
if bash -euo pipefail "$WORK/legacy.sh" && cmp -s "$SRC/box-runner.mjs" "$DEST/box-runner.mjs"; then
	echo "ok: legacy single-file pin installed"
else
	echo "FAIL: legacy single-file pin did not boot"; fail=1
fi

# Case E: legacy pin with tampered runner -> rejected, nothing installed.
echo 'console.log("evil")' >> "$SRC/box-runner.mjs"
rm -rf "$DEST"
if bash -euo pipefail "$WORK/legacy.sh" 2>/dev/null; then
	echo "FAIL: tampered legacy runner accepted (exit 0)"; fail=1
elif [ -e "$DEST/box-runner.mjs" ]; then
	echo "FAIL: tampered legacy runner installed"; fail=1
else
	echo "ok: tampered legacy runner rejected, nothing installed"
fi

exit $fail
