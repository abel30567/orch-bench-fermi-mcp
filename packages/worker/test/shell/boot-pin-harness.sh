#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every file of
# the pinned manifest into the same relative layout when all sha256s match, and
# must fail closed (non-zero, nothing installed) when any one file is tampered
# or missing. A legacy single-file pin (runner_sha256 only) must still boot.
# Run from packages/worker:
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

SRC="$WORK/src"   # what the "CDN" serves at the ref
DEST="$WORK/opt"  # the box's /opt/fermi
FILES=(box-runner.mjs harness/claude.mjs lib/util.mjs)

serve_pristine() {
	rm -rf "$SRC"
	mkdir -p "$SRC/harness" "$SRC/lib"
	echo 'console.log("runner ok")' > "$SRC/box-runner.mjs"
	echo 'export const harness = "claude"' > "$SRC/harness/claude.mjs"
	echo 'export const util = 1' > "$SRC/lib/util.mjs"
}
sha() { sha256sum "$1" | cut -d' ' -f1; }

serve_pristine
MANIFEST="{"
for f in "${FILES[@]}"; do MANIFEST+="\"$f\":\"$(sha "$SRC/$f")\","; done
MANIFEST="${MANIFEST%,}}"
LEGACY_SHA=$(sha "$SRC/box-runner.mjs")

# Emit the real fragments from the TS module (node >=23 strips types natively).
# Both pins go through runnerPinFromConfig, exactly as the provisioner reads them.
emit() { # $1 = fleet:config JSON
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig($1)
  if (!pin) throw new Error('pin rejected')
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SRC', destDir: '$DEST' }))
})"
}
emit "{ runner_ref: 'testref', runner_sha256: '$LEGACY_SHA', runner_files: $MANIFEST }" \
	> "$WORK/manifest.sh" || { echo "FRAGMENT GENERATION FAILED (manifest)"; exit 1; }
emit "{ runner_ref: 'testref', runner_sha256: '$LEGACY_SHA' }" \
	> "$WORK/legacy.sh" || { echo "FRAGMENT GENERATION FAILED (legacy)"; exit 1; }
# Keep the harness fast: retries are for CDN throttling, not file:// misses.
sed -i.bak 's/--retry 4 --retry-delay 3 --retry-all-errors //' "$WORK/manifest.sh" "$WORK/legacy.sh"

fail=0

nothing_installed() {
	local g
	for g in "${FILES[@]}"; do [ -e "$DEST/$g" ] && return 1; done
	return 0
}

# Case A: pristine manifest -> every file installed in the same layout, exit 0.
rm -rf "$DEST"; mkdir -p "$DEST"
if ! bash -euo pipefail "$WORK/manifest.sh"; then
	echo "FAIL: pristine manifest exited non-zero"; fail=1
else
	ok=1
	for f in "${FILES[@]}"; do cmp -s "$SRC/$f" "$DEST/$f" || ok=0; done
	if [ $ok -eq 1 ] && [ ! -e "$DEST/.runner-staging" ]; then
		echo "ok: pristine manifest installed (${FILES[*]})"
	else
		echo "FAIL: pristine manifest not installed in layout"; fail=1
	fi
fi

# Case B: tamper any one file -> refuse, nothing installed.
for f in "${FILES[@]}"; do
	serve_pristine
	echo '// evil' >> "$SRC/$f"
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
for f in "${FILES[@]}"; do
	serve_pristine
	rm -f "$SRC/$f"
	rm -rf "$DEST"; mkdir -p "$DEST"
	if bash -euo pipefail "$WORK/manifest.sh" 2>/dev/null; then
		echo "FAIL: missing $f accepted (exit 0)"; fail=1
	elif ! nothing_installed; then
		echo "FAIL: missing $f: files installed despite non-zero exit"; fail=1
	else
		echo "ok: missing $f rejected, nothing installed"
	fi
done

# Case D: legacy single-file pin -> boots (installs box-runner.mjs only).
serve_pristine
rm -rf "$DEST"; mkdir -p "$DEST"
if bash -euo pipefail "$WORK/legacy.sh" && cmp -s "$SRC/box-runner.mjs" "$DEST/box-runner.mjs" \
	&& [ ! -e "$DEST/harness" ]; then
	echo "ok: legacy single-file pin installed"
else
	echo "FAIL: legacy single-file pin did not boot"; fail=1
fi

# Case E: legacy pin, tampered runner -> refuse, nothing installed.
echo '// evil' >> "$SRC/box-runner.mjs"
rm -rf "$DEST"; mkdir -p "$DEST"
if bash -euo pipefail "$WORK/legacy.sh" 2>/dev/null || [ -e "$DEST/box-runner.mjs" ]; then
	echo "FAIL: legacy pin accepted a tampered runner"; fail=1
else
	echo "ok: legacy pin rejected tampered runner, nothing installed"
fi

exit $fail
