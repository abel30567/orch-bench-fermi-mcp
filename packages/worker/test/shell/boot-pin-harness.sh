#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every file in
# the pinned manifest (same relative layout) only when all sha256s match, and
# must fail closed (non-zero, nothing installed) when any one file is tampered
# or missing. A legacy single-file pin must still boot. Run from packages/worker:
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

SRV="$WORK/served"
DEST="$WORK/installed"
FILES="box-runner.mjs harness/claude.mjs lib/util.mjs"

serve_pristine() {
	rm -rf "$SRV"
	mkdir -p "$SRV/harness" "$SRV/lib"
	echo 'console.log("runner ok")' > "$SRV/box-runner.mjs"
	echo 'export const harness = "claude"' > "$SRV/harness/claude.mjs"
	echo 'export const util = 1' > "$SRV/lib/util.mjs"
}

sha() { sha256sum "$1" | cut -d' ' -f1; }

serve_pristine
MANIFEST=$(printf '{"runner_ref":"testref","runner_files":{"box-runner.mjs":"%s","harness/claude.mjs":"%s","lib/util.mjs":"%s"}}' \
	"$(sha "$SRV/box-runner.mjs")" "$(sha "$SRV/harness/claude.mjs")" "$(sha "$SRV/lib/util.mjs")")
LEGACY=$(printf '{"runner_ref":"testref","runner_sha256":"%s"}' "$(sha "$SRV/box-runner.mjs")")

# Emit the real fragment from the TS module (node >=23 strips types natively),
# resolving the pin through the same runnerPinFromConfig the provisioner uses.
fragment() {
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig(JSON.parse(process.argv[1]))
  if (!pin) { console.error('pin rejected'); process.exit(1) }
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SRV', destDir: '$DEST' }))
})" "$1"
}

fragment "$MANIFEST" > "$WORK/manifest.sh" || { echo "FRAGMENT GENERATION FAILED (manifest)"; exit 1; }
fragment "$LEGACY" > "$WORK/legacy.sh" || { echo "FRAGMENT GENERATION FAILED (legacy)"; exit 1; }

fail=0

nothing_installed() {
	local g
	for g in $FILES; do [ -e "$DEST/$g" ] && return 1; done
	return 0
}

# Case A: pristine manifest -> every file installed in the same layout, exit 0.
rm -rf "$DEST"; mkdir -p "$DEST"
if bash -euo pipefail "$WORK/manifest.sh" && for f in $FILES; do cmp -s "$SRV/$f" "$DEST/$f" || exit 1; done; then
	echo "ok: pristine manifest installed ($FILES)"
else
	echo "FAIL: pristine manifest was not installed"; fail=1
fi

# Case B: tamper any one file -> refuse, nothing installed.
for f in $FILES; do
	serve_pristine
	echo '// evil' >> "$SRV/$f"
	rm -rf "$DEST"; mkdir -p "$DEST"
	if bash -euo pipefail "$WORK/manifest.sh" 2>/dev/null; then
		echo "FAIL: tampered $f accepted (exit 0)"; fail=1
	elif ! nothing_installed; then
		echo "FAIL: tampered $f: files installed despite non-zero exit"; fail=1
	else
		echo "ok: tampered $f rejected, nothing installed"
	fi
done

# Case C: omit any one file -> refuse, nothing installed.
for f in $FILES; do
	serve_pristine
	rm -f "$SRV/$f"
	rm -rf "$DEST"; mkdir -p "$DEST"
	if bash -euo pipefail "$WORK/manifest.sh" 2>/dev/null; then
		echo "FAIL: missing $f accepted (exit 0)"; fail=1
	elif ! nothing_installed; then
		echo "FAIL: missing $f: files installed despite non-zero exit"; fail=1
	else
		echo "ok: missing $f rejected, nothing installed"
	fi
done

# Case D: legacy single-file pin still boots.
serve_pristine
rm -rf "$DEST"; mkdir -p "$DEST"
if bash -euo pipefail "$WORK/legacy.sh" && cmp -s "$SRV/box-runner.mjs" "$DEST/box-runner.mjs"; then
	echo "ok: legacy single-file pin installed box-runner.mjs"
else
	echo "FAIL: legacy single-file pin did not boot"; fail=1
fi

# Case E: legacy pin with a tampered runner -> refuse, nothing installed.
echo '// evil' >> "$SRV/box-runner.mjs"
rm -rf "$DEST"; mkdir -p "$DEST"
if bash -euo pipefail "$WORK/legacy.sh" 2>/dev/null; then
	echo "FAIL: legacy tampered runner accepted (exit 0)"; fail=1
elif [ -e "$DEST/box-runner.mjs" ]; then
	echo "FAIL: legacy tampered runner installed despite non-zero exit"; fail=1
else
	echo "ok: legacy tampered runner rejected, nothing installed"
fi

exit $fail
