#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every file of
# the pinned manifest only when each sha256 matches, and must fail closed
# (non-zero, nothing installed) when any one file is tampered or missing. A
# legacy single-file pin must still boot. Run from packages/worker:
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

FILES="box-runner.mjs harness/index.mjs lib/util.mjs"
SERVED="$WORK/served"
DEST="$WORK/opt"

serve_pristine() {
	rm -rf "$SERVED"
	mkdir -p "$SERVED/harness" "$SERVED/lib"
	echo 'console.log("runner ok")' > "$SERVED/box-runner.mjs"
	echo 'export const harness = "ok"' > "$SERVED/harness/index.mjs"
	echo 'export const util = "ok"' > "$SERVED/lib/util.mjs"
}

sha() { sha256sum "$1" | cut -d' ' -f1; }

# Emit the real fragment from the TS module (node >=23 strips types natively).
# $1 = JS expression for the fleet:config pin fields.
fragment() {
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig($1)
  if (!pin) { console.error('pin rejected'); process.exit(1) }
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SERVED', dir: '$DEST' }))
})"
}

none_installed() {
	local g
	for g in $FILES; do [ -e "$DEST/$g" ] && return 1; done
	return 0
}

# Run the fragment against a fresh install dir; succeeds iff boot proceeds.
boot() {
	rm -rf "$DEST"
	mkdir -p "$DEST"
	bash -euo pipefail "$1" 2>/dev/null
}

fail=0
serve_pristine
MANIFEST="{ runner_ref: 'testref', runner_files: {
  'box-runner.mjs': '$(sha "$SERVED/box-runner.mjs")',
  'harness/index.mjs': '$(sha "$SERVED/harness/index.mjs")',
  'lib/util.mjs': '$(sha "$SERVED/lib/util.mjs")' } }"
fragment "$MANIFEST" > "$WORK/manifest.sh" || { echo "FRAGMENT GENERATION FAILED"; exit 1; }

# Case A: pristine manifest -> every file installed in the same layout, exit 0.
if boot "$WORK/manifest.sh" && cmp -s "$SERVED/box-runner.mjs" "$DEST/box-runner.mjs" &&
	cmp -s "$SERVED/harness/index.mjs" "$DEST/harness/index.mjs" &&
	cmp -s "$SERVED/lib/util.mjs" "$DEST/lib/util.mjs"; then
	echo "ok: pristine manifest installed"
else
	echo "FAIL: pristine manifest was not installed"; fail=1
fi

# Case B: tamper each file in turn -> refuse, nothing installed.
for f in $FILES; do
	serve_pristine
	echo '// evil' >> "$SERVED/$f"
	if boot "$WORK/manifest.sh"; then
		echo "FAIL: tampered $f accepted (exit 0)"; fail=1
	elif ! none_installed; then
		echo "FAIL: tampered $f: files installed despite non-zero exit"; fail=1
	else
		echo "ok: tampered $f rejected, nothing installed"
	fi
done

# Case C: omit each file in turn -> refuse, nothing installed.
for f in $FILES; do
	serve_pristine
	rm -f "$SERVED/$f"
	if boot "$WORK/manifest.sh"; then
		echo "FAIL: missing $f accepted (exit 0)"; fail=1
	elif ! none_installed; then
		echo "FAIL: missing $f: files installed despite non-zero exit"; fail=1
	else
		echo "ok: missing $f rejected, nothing installed"
	fi
done

# Case D: legacy single-file pin (runner_sha256 only) still boots.
serve_pristine
fragment "{ runner_ref: 'testref', runner_sha256: '$(sha "$SERVED/box-runner.mjs")' }" \
	> "$WORK/legacy.sh" || { echo "LEGACY FRAGMENT GENERATION FAILED"; exit 1; }
if boot "$WORK/legacy.sh" && cmp -s "$SERVED/box-runner.mjs" "$DEST/box-runner.mjs"; then
	echo "ok: legacy single-file pin installed"
else
	echo "FAIL: legacy single-file pin did not boot"; fail=1
fi

# Case E: legacy pin, tampered runner -> refuse, nothing installed.
echo '// evil' >> "$SERVED/box-runner.mjs"
if boot "$WORK/legacy.sh"; then
	echo "FAIL: legacy tampered runner accepted (exit 0)"; fail=1
elif [ -e "$DEST/box-runner.mjs" ]; then
	echo "FAIL: legacy tampered runner installed despite non-zero exit"; fail=1
else
	echo "ok: legacy tampered runner rejected, nothing installed"
fi

exit $fail
