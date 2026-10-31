#!/usr/bin/env bash
# Tamper harness for the runner pin (#34, pr-55). Generates the real boot
# fragment from src/lib/runner-pin.ts, serves fixture files over file:// (no
# network), and asserts the boot either installs every pinned file or fails
# closed: non-zero exit, nothing installed, credentials never written.
#
#   bash packages/worker/test/shell/boot-pin-harness.sh
#
# Needs bash, bun, curl and sha256sum (a shasum shim is used when missing).
# A missing-file case takes ~12s each: the fragment's curl --retry is real.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIN_MODULE="$HERE/../../src/lib/runner-pin.ts"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/boot-pin.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

if ! command -v sha256sum >/dev/null; then
	mkdir -p "$WORK/bin"
	printf '#!/bin/sh\nexec shasum -a 256 "$@"\n' >"$WORK/bin/sha256sum"
	chmod +x "$WORK/bin/sha256sum"
	export PATH="$WORK/bin:$PATH"
fi

REF="$(printf 'a%.0s' {1..40})"
FILES=(box-runner.mjs harness/claude.mjs lib/queue.mjs)
PASS=0
FAIL=0

sha() { sha256sum "$1" | cut -d' ' -f1; }
ok() { PASS=$((PASS + 1)); echo "ok   - $1"; }
not_ok() { FAIL=$((FAIL + 1)); echo "FAIL - $1"; }

# Pristine served tree: $WORK/origin/<path>.
mkdir -p "$WORK/origin/harness" "$WORK/origin/lib"
for f in "${FILES[@]}"; do echo "// $f @ $REF" >"$WORK/origin/$f"; done
MANIFEST="{$(for f in "${FILES[@]}"; do printf '"%s":"%s",' "$f" "$(sha "$WORK/origin/$f")"; done | sed 's/,$//')}"
LEGACY_SHA="$(sha "$WORK/origin/box-runner.mjs")"

# gen CONFIG_JSON SERVE_DIR DEST_DIR → boot fragment on stdout; exit 3 if the pin is invalid.
gen() {
	CONFIG="$1" BASE="file://$2" DEST="$3" PIN_MODULE="$PIN_MODULE" bun -e '
		const { runnerPinFromConfig, runnerFetchScript } = await import(process.env.PIN_MODULE)
		const pin = runnerPinFromConfig(JSON.parse(process.env.CONFIG))
		if (!pin) process.exit(3)
		process.stdout.write(runnerFetchScript(pin, { baseUrl: process.env.BASE, destDir: process.env.DEST }))'
}

# boot CONFIG_JSON SERVE_DIR → runs the fragment like bootstrapUserData does
# (set -euo pipefail, credentials written only after the fetch). Sets $DEST.
CASE=0
boot() {
	CASE=$((CASE + 1))
	DEST="$WORK/box$CASE/opt/fermi"
	mkdir -p "$DEST"
	local script
	script="$(gen "$1" "$2" "$DEST")" || return 3
	bash -c "set -euo pipefail
$script
echo FERMI_BOX_TOKEN=secret > '$DEST/box.env'" >"$WORK/box$CASE.log" 2>&1
}

# serve_variant NAME → copy of the pristine tree at $WORK/<NAME>.
serve_variant() {
	rm -rf "${WORK:?}/$1"
	cp -R "$WORK/origin" "$WORK/$1"
	echo "$WORK/$1"
}

assert_refused() {
	local label="$1" rc="$2" leaked
	leaked="$(find "$DEST" -type f | head -1)"
	if [ "$rc" -ne 0 ] && [ -z "$leaked" ] && [ ! -e "$DEST/box.env" ]; then
		ok "$label: boot refused, nothing installed"
	else
		not_ok "$label: rc=$rc leaked=${leaked:-none}"
	fi
}

assert_booted() {
	local label="$1" rc="$2" serve="$3"
	shift 3
	local f bad=""
	for f in "$@"; do cmp -s "$serve/$f" "$DEST/$f" || bad="$bad $f"; done
	if [ "$rc" -eq 0 ] && [ -z "$bad" ] && [ -e "$DEST/box.env" ] && [ ! -e "$DEST.runner-new" ]; then
		ok "$label: booted, all pinned files installed"
	else
		not_ok "$label: rc=$rc missing/wrong:${bad:- none} (log: $(cat "$WORK/box$CASE.log"))"
	fi
}

MANIFEST_CFG="{\"runner_ref\":\"$REF\",\"runner_files\":$MANIFEST}"

# 1. Intact manifest boots and lays files out in the same relative layout.
rc=0
boot "$MANIFEST_CFG" "$WORK/origin" || rc=$?
assert_booted "manifest intact" "$rc" "$WORK/origin" "${FILES[@]}"

# 2. Altering any one file refuses the boot.
for f in "${FILES[@]}"; do
	serve="$(serve_variant tampered)"
	echo 'process.exit(0) // tampered' >>"$serve/$f"
	rc=0
	boot "$MANIFEST_CFG" "$serve" || rc=$?
	assert_refused "manifest, $f tampered" "$rc"
done

# 3. Omitting any one file refuses the boot.
for f in "${FILES[@]}"; do
	serve="$(serve_variant missing)"
	rm "$serve/$f"
	rc=0
	boot "$MANIFEST_CFG" "$serve" || rc=$?
	assert_refused "manifest, $f missing" "$rc"
done

# 4. A served file the manifest does not pin is never installed.
serve="$(serve_variant extra)"
echo 'evil' >"$serve/lib/extra.mjs"
rc=0
boot "$MANIFEST_CFG" "$serve" || rc=$?
if [ "$rc" -eq 0 ] && [ ! -e "$DEST/lib/extra.mjs" ]; then
	ok "manifest, unpinned extra file not installed"
else
	not_ok "manifest, unpinned extra file: rc=$rc"
fi

# 5. Legacy single-file pin (runner_ref + runner_sha256) still boots.
LEGACY_CFG="{\"runner_ref\":\"$REF\",\"runner_sha256\":\"$LEGACY_SHA\"}"
rc=0
boot "$LEGACY_CFG" "$WORK/origin" || rc=$?
assert_booted "legacy pin intact" "$rc" "$WORK/origin" box-runner.mjs

# 6. Legacy pin with a tampered runner refuses.
serve="$(serve_variant legacy-tampered)"
echo '// tampered' >>"$serve/box-runner.mjs"
rc=0
boot "$LEGACY_CFG" "$serve" || rc=$?
assert_refused "legacy pin, box-runner.mjs tampered" "$rc"

# 7. Invalid manifests never produce a boot fragment.
H="$(sha "$WORK/origin/lib/queue.mjs")"
for files in "{\"lib/queue.mjs\":\"$H\"}" "{\"box-runner.mjs\":\"$LEGACY_SHA\",\"../evil.mjs\":\"$H\"}" \
	"{\"box-runner.mjs\":\"$LEGACY_SHA\",\"/etc/evil\":\"$H\"}" "{\"box-runner.mjs\":\"nothex\"}"; do
	rc=0
	boot "{\"runner_ref\":\"$REF\",\"runner_files\":$files}" "$WORK/origin" || rc=$?
	if [ "$rc" -eq 3 ] && [ -z "$(find "$DEST" -type f | head -1)" ]; then
		ok "invalid manifest rejected: $files"
	else
		not_ok "invalid manifest accepted: $files (rc=$rc)"
	fi
done

echo "# pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
