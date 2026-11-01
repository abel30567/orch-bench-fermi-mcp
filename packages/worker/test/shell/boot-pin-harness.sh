#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every file of
# the pinned manifest (same relative layout) when all hashes match, and must
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

FILES="box-runner.mjs lib/util.mjs harness/claude/adapter.mjs"
SRC="$WORK/src"     # pristine copy: what the manifest was hashed from
SERVE="$WORK/serve" # what the "CDN" serves; mutated per case
DEST="$WORK/dest"

for f in $FILES; do
	mkdir -p "$SRC/$(dirname "$f")"
	echo "console.log('$f ok')" > "$SRC/$f"
done
sha() { sha256sum "$1" | cut -d' ' -f1; }
MANIFEST="{"
for f in $FILES; do MANIFEST="$MANIFEST\"$f\":\"$(sha "$SRC/$f")\","; done
MANIFEST="${MANIFEST%,}}"
LEGACY_SHA=$(sha "$SRC/box-runner.mjs")

# Emit the real fragments from the TS module (node >=23 strips types natively).
# Both pins go through runnerPinFromConfig, exactly as the provisioner does.
node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const opts = { baseUrl: 'file://$SERVE', destDir: '$DEST' }
  const emit = (cfg, file) => {
    const pin = m.runnerPinFromConfig(cfg)
    if (!pin) throw new Error('pin rejected: ' + JSON.stringify(cfg))
    require('node:fs').writeFileSync(file, m.runnerFetchScript(pin, opts))
  }
  emit({ runner_ref: 'testref', runner_sha256: null, runner_files: $MANIFEST }, '$WORK/manifest.sh')
  emit({ runner_ref: 'testref', runner_sha256: '$LEGACY_SHA' }, '$WORK/legacy.sh')
  for (const files of [{ 'lib/util.mjs': '$LEGACY_SHA' }, { 'box-runner.mjs': '$LEGACY_SHA', '../evil.mjs': '$LEGACY_SHA' }]) {
    if (m.runnerPinFromConfig({ runner_ref: 'testref', runner_files: files }) !== null) throw new Error('invalid manifest accepted')
    let threw = false
    try { m.runnerFetchScript({ ref: 'testref', files }, opts) } catch { threw = true }
    if (!threw) throw new Error('runnerFetchScript accepted an invalid manifest')
  }
})" || { echo "FRAGMENT GENERATION FAILED"; exit 1; }

fail=0
reset() {
	rm -rf "$SERVE" "$DEST"
	cp -R "$SRC" "$SERVE"
	mkdir -p "$DEST"
}
nothing_installed() { [ -z "$(find "$DEST" -mindepth 1 -print -quit)" ]; }
expect_refused() { # $1 = label
	if bash -euo pipefail "$WORK/manifest.sh" 2>/dev/null; then
		echo "FAIL: $1 accepted (exit 0)"; fail=1
	elif ! nothing_installed; then
		echo "FAIL: $1 left files installed despite non-zero exit"; fail=1
	else
		echo "ok: $1 rejected, nothing installed"
	fi
}

# Case A: pristine manifest -> every file installed in the same layout, exit 0.
reset
if bash -euo pipefail "$WORK/manifest.sh"; then
	for f in $FILES; do
		if ! cmp -s "$SRC/$f" "$DEST/$f"; then echo "FAIL: $f not installed"; fail=1; fi
	done
	[ -e "$DEST/.runner-staging" ] && { echo "FAIL: staging dir left behind"; fail=1; }
	echo "ok: pristine manifest installed"
else
	echo "FAIL: pristine manifest was not installed"; fail=1
fi

# Case B: any one file tampered -> refuse.
for f in $FILES; do
	reset
	echo "console.log('evil')" >> "$SERVE/$f"
	expect_refused "tampered $f"
done

# Case C: any one file missing from the served ref -> refuse.
for f in $FILES; do
	reset
	rm -f "$SERVE/$f"
	expect_refused "missing $f"
done

# Case D: legacy single-file pin still boots, and still refuses a tampered runner.
reset
if bash -euo pipefail "$WORK/legacy.sh" && cmp -s "$SRC/box-runner.mjs" "$DEST/box-runner.mjs"; then
	echo "ok: legacy single-file pin installed"
else
	echo "FAIL: legacy single-file pin was not installed"; fail=1
fi
reset
echo "console.log('evil')" > "$SERVE/box-runner.mjs"
if bash -euo pipefail "$WORK/legacy.sh" 2>/dev/null || ! nothing_installed; then
	echo "FAIL: legacy pin accepted a tampered runner"; fail=1
else
	echo "ok: legacy pin rejected tampered runner, nothing installed"
fi

exit $fail
