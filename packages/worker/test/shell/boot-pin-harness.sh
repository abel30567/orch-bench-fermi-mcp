#!/usr/bin/env bash
# Tamper harness for #34 / pr-55: the runner-fetch fragment must install every
# file in the pin manifest when each sha256 matches, and must fail closed
# (non-zero, nothing installed) when ANY one file is tampered or missing. A
# legacy single-file pin (runner_ref + runner_sha256) must still boot.
# Run from anywhere:
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

SRC="$WORK/src"   # what the "CDN" serves, in the repo's relative layout
FILES=("box-runner.mjs" "harness/index.mjs" "lib/util.mjs")

serve_pristine() {
	rm -rf "$SRC"
	mkdir -p "$SRC/harness" "$SRC/lib"
	echo 'console.log("runner ok")' > "$SRC/box-runner.mjs"
	echo 'export const harness = "claude"' > "$SRC/harness/index.mjs"
	echo 'export const util = 1' > "$SRC/lib/util.mjs"
}

sha_of() { sha256sum "$1" | cut -d' ' -f1; }

# Emit the real fragment from the TS module (node >=23 strips types natively).
# $1 = JSON config object (fleet:config shape), $2 = output fragment, $3 = dest dir.
gen_fragment() {
	CONFIG_JSON="$1" BASE="file://$SRC" DEST="$3" node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig(JSON.parse(process.env.CONFIG_JSON))
  if (!pin) { console.error('pin invalid'); process.exit(1) }
  console.log(m.runnerFetchScript(pin, { baseUrl: process.env.BASE, destDir: process.env.DEST }))
})" > "$2" || { echo "FRAGMENT GENERATION FAILED"; exit 1; }
}

fail=0
installed_any() { [ -n "$(find "$1" -type f 2>/dev/null | head -1)" ]; }

# Expect the fragment to refuse: non-zero exit AND nothing installed.
expect_refuse() { # $1 label, $2 fragment, $3 dest
	rm -rf "$3"; mkdir -p "$3"
	if bash -euo pipefail "$2" 2>/dev/null; then
		echo "FAIL: $1 accepted (exit 0)"; fail=1
	elif [ -n "$(find "$3" -type f ! -name '*.new' | head -1)" ]; then
		echo "FAIL: $1 installed files despite non-zero exit"; fail=1
	else
		echo "ok: $1 refused, nothing installed"
	fi
}

# ---- Manifest pin -----------------------------------------------------------
serve_pristine
MANIFEST="{\"runner_ref\":\"testref\",\"runner_sha256\":\"$(sha_of "$SRC/box-runner.mjs")\",\"runner_files\":{"
sep=""
for f in "${FILES[@]}"; do
	MANIFEST="$MANIFEST$sep\"$f\":\"$(sha_of "$SRC/$f")\""; sep=","
done
MANIFEST="$MANIFEST}}"
DEST="$WORK/opt"
gen_fragment "$MANIFEST" "$WORK/manifest.sh" "$DEST"

# Case A: pristine manifest -> every file installed in the same layout, exit 0.
rm -rf "$DEST"; mkdir -p "$DEST"
if bash -euo pipefail "$WORK/manifest.sh"; then
	ok=1
	for f in "${FILES[@]}"; do
		cmp -s "$SRC/$f" "$DEST/$f" || { echo "FAIL: $f not installed intact"; ok=0; fail=1; }
	done
	[ $ok -eq 1 ] && echo "ok: pristine manifest installed (${#FILES[@]} files)"
else
	echo "FAIL: pristine manifest was not installed"; fail=1
fi

# Case B: tamper each file in turn -> refuse.
for f in "${FILES[@]}"; do
	serve_pristine
	echo '// evil' >> "$SRC/$f"
	expect_refuse "tampered $f" "$WORK/manifest.sh" "$DEST"
done

# Case C: omit each file in turn (CDN 404) -> refuse.
for f in "${FILES[@]}"; do
	serve_pristine
	rm -f "$SRC/$f"
	expect_refuse "missing $f" "$WORK/manifest.sh" "$DEST"
done

# Case D: invalid manifests are rejected before any fragment is emitted.
for bad in \
	'{"runner_ref":"testref","runner_files":{"lib/util.mjs":"'"$(printf 'a%.0s' {1..64})"'"}}' \
	'{"runner_ref":"testref","runner_files":{"box-runner.mjs":"'"$(printf 'a%.0s' {1..64})"'","../evil.mjs":"'"$(printf 'a%.0s' {1..64})"'"}}'; do
	if CONFIG_JSON="$bad" node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => process.exit(m.runnerPinFromConfig(JSON.parse(process.env.CONFIG_JSON)) ? 0 : 1))"; then
		echo "FAIL: invalid manifest accepted: $bad"; fail=1
	else
		echo "ok: invalid manifest rejected"
	fi
done

# ---- Legacy single-file pin -------------------------------------------------
serve_pristine
LEGACY="{\"runner_ref\":\"testref\",\"runner_sha256\":\"$(sha_of "$SRC/box-runner.mjs")\"}"
LDEST="$WORK/legacy"
gen_fragment "$LEGACY" "$WORK/legacy.sh" "$LDEST"

# Case E: legacy pin, pristine -> box-runner.mjs installed, exit 0.
rm -rf "$LDEST"; mkdir -p "$LDEST"
if bash -euo pipefail "$WORK/legacy.sh" && cmp -s "$SRC/box-runner.mjs" "$LDEST/box-runner.mjs"; then
	echo "ok: legacy single-file pin installed"
else
	echo "FAIL: legacy single-file pin was not installed"; fail=1
fi

# Case F: legacy pin, tampered runner -> refuse.
echo 'console.log("evil")' > "$SRC/box-runner.mjs"
expect_refuse "legacy tampered box-runner.mjs" "$WORK/legacy.sh" "$LDEST"

[ $fail -eq 0 ] && echo "ALL BOOT-PIN CASES PASSED"
exit $fail
