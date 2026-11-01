#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every file of
# the pinned manifest (same relative layout) only when every sha256 matches,
# and must fail closed (non-zero, nothing installed) when any one file is
# tampered or missing. A legacy single-file pin must still boot. Run from
# packages/worker:
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

SERVED="$WORK/served"
DEST="$WORK/opt"
FILES="box-runner.mjs harness/claude.mjs lib/report.mjs"

serve_pristine() {
	rm -rf "$SERVED"
	mkdir -p "$SERVED/harness" "$SERVED/lib"
	echo 'console.log("runner ok")' > "$SERVED/box-runner.mjs"
	echo 'export const route = "claude"' > "$SERVED/harness/claude.mjs"
	echo 'export function report() {}' > "$SERVED/lib/report.mjs"
}

sha_of() { sha256sum "$SERVED/$1" | cut -d' ' -f1; }

# Emit the real fragment from the TS module (node >=23 strips types natively).
# $1 = JS object literal for the pin; $2 = output file.
gen_fragment() {
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  console.log(m.runnerFetchScript($1, { baseUrl: 'file://$SERVED', destDir: '$DEST' }))
})" > "$2"
}

installed_any() {
	local g; for g in $FILES; do [ -e "$DEST/$g" ] && return 0; done
	return 1
}

serve_pristine
MANIFEST="{ ref: 'testref', files: {"
for f in $FILES; do MANIFEST="$MANIFEST '$f': '$(sha_of "$f")',"; done
MANIFEST="$MANIFEST } }"
gen_fragment "$MANIFEST" "$WORK/fragment.sh" || { echo "FRAGMENT GENERATION FAILED"; exit 1; }

fail=0

# Case A: pristine manifest -> every file installed in the same layout, exit 0.
rm -rf "$DEST"
if ! bash -euo pipefail "$WORK/fragment.sh"; then
	echo "FAIL: pristine manifest was rejected"; fail=1
else
	for f in $FILES; do
		if ! cmp -s "$SERVED/$f" "$DEST/$f"; then echo "FAIL: $f not installed"; fail=1; fi
	done
	[ $fail -eq 0 ] && echo "ok: pristine manifest installed ($FILES)"
fi

# Case B: tamper each file in turn -> must NOT boot, nothing installed.
for f in $FILES; do
	serve_pristine
	rm -rf "$DEST"
	echo '// evil' >> "$SERVED/$f"
	if bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null; then
		echo "FAIL: tampered $f accepted (exit 0)"; fail=1
	elif installed_any; then
		echo "FAIL: files installed despite tampered $f"; fail=1
	else
		echo "ok: tampered $f rejected, nothing installed"
	fi
done

# Case C: omit each file in turn from what is served -> must NOT boot.
for f in $FILES; do
	serve_pristine
	rm -rf "$DEST"
	rm -f "$SERVED/$f"
	if bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null; then
		echo "FAIL: missing $f accepted (exit 0)"; fail=1
	elif installed_any; then
		echo "FAIL: files installed despite missing $f"; fail=1
	else
		echo "ok: missing $f rejected, nothing installed"
	fi
done

# Case D: a manifest that omits box-runner.mjs (or has an unsafe path) never
# yields a boot script at all.
serve_pristine
for bad in "{ ref: 'testref', files: { 'lib/report.mjs': '$(sha_of lib/report.mjs)' } }" \
	"{ ref: 'testref', files: { 'box-runner.mjs': '$(sha_of box-runner.mjs)', '../etc/x': '$(sha_of lib/report.mjs)' } }"; do
	if gen_fragment "$bad" "$WORK/bad.sh" 2>/dev/null; then
		echo "FAIL: invalid manifest produced a boot script: $bad"; fail=1
	else
		echo "ok: invalid manifest refused"
	fi
done

# Case E: legacy single-file pin (runner_ref + runner_sha256 only) still boots.
serve_pristine
rm -rf "$DEST"
gen_fragment "m.runnerPinFromConfig({ runner_ref: 'testref', runner_sha256: '$(sha_of box-runner.mjs)' })" \
	"$WORK/legacy.sh" || { echo "FAIL: legacy fragment generation failed"; exit 1; }
if bash -euo pipefail "$WORK/legacy.sh" && cmp -s "$SERVED/box-runner.mjs" "$DEST/box-runner.mjs"; then
	echo "ok: legacy single-file pin boots"
else
	echo "FAIL: legacy single-file pin did not boot"; fail=1
fi
echo '// evil' >> "$SERVED/box-runner.mjs"
rm -rf "$DEST"
if bash -euo pipefail "$WORK/legacy.sh" 2>/dev/null || installed_any; then
	echo "FAIL: tampered legacy runner accepted"; fail=1
else
	echo "ok: tampered legacy runner rejected"
fi

exit $fail
