#!/usr/bin/env bash
# Tamper harness for the runner pin (#34, pr-55). Generates the real boot
# fragment from src/lib/runner-pin.ts, serves a fake fermi-daemon tree over
# file:// and runs the fragment under `set -euo pipefail`. Asserts that an
# intact manifest (and a legacy single-file pin) boots, and that altering or
# omitting ANY one manifest file refuses to boot with nothing installed and no
# box token written. No network: every URL is file://.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIN_TS="$HERE/../../src/lib/runner-pin.ts"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/boot-pin.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# macOS without coreutils: shim sha256sum (the boot script targets Linux).
if ! command -v sha256sum >/dev/null; then
	mkdir -p "$WORK/bin"
	printf '#!/bin/sh\nexec shasum -a 256 "$@"\n' >"$WORK/bin/sha256sum"
	chmod +x "$WORK/bin/sha256sum"
	export PATH="$WORK/bin:$PATH"
fi

REF=0123456789abcdef0123456789abcdef01234567
FILES=(box-runner.mjs harness/claude.mjs lib/util.mjs)
REPO="$WORK/repo"
mkdir -p "$REPO/harness" "$REPO/lib"
echo 'import "./harness/claude.mjs"; console.log("runner")' >"$REPO/box-runner.mjs"
echo 'export const harness = "claude"' >"$REPO/harness/claude.mjs"
echo 'export const util = 1' >"$REPO/lib/util.mjs"

hash() { sha256sum "$1" | cut -d' ' -f1; }
MANIFEST="{$(for f in "${FILES[@]}"; do printf '"%s":"%s",' "$f" "$(hash "$REPO/$f")"; done | sed 's/,$//')}"
LEGACY_SHA="$(hash "$REPO/box-runner.mjs")"

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
not_ok() { fail=$((fail + 1)); echo "FAIL - $1"; }

# gen CONFIG_JSON SERVED_DIR DEST_DIR → boot fragment (exit 99 if the pin is invalid)
gen() {
	CONFIG="$1" BASE="file://$2" DEST="$3" PIN_TS="$PIN_TS" bun --eval '
		const { runnerPinFromConfig, runnerFetchScript } = await import(process.env.PIN_TS)
		const pin = runnerPinFromConfig(JSON.parse(process.env.CONFIG))
		if (!pin) process.exit(99)
		console.log(runnerFetchScript(pin, { baseUrl: process.env.BASE, destDir: process.env.DEST }))
	'
}

# boot NAME CONFIG_JSON → runs fragment then writes the token, like user-data.
# Sets BOOT_DEST; returns the fragment's exit status, or 99 if gen refused the pin.
boot() {
	local name="$1" config="$2"
	BOOT_DEST="$WORK/opt-$name"
	mkdir -p "$BOOT_DEST"
	local script
	script="$(gen "$config" "$WORK/served-$name" "$BOOT_DEST")" || return 99
	bash -euo pipefail -c "$script
echo FERMI_BOX_TOKEN=secret > '$BOOT_DEST/box.env'" >/dev/null 2>&1
}

serve() { rm -rf "$WORK/served-$1" && cp -R "$REPO" "$WORK/served-$1"; }

# Refused = the boot fragment ran and exited non-zero (99 = no fragment was
# generated, which would make the case vacuous), no token, no file installed.
assert_refused() {
	local name="$1" rc="$2" leaked=""
	for f in "${FILES[@]}"; do [[ -e "$BOOT_DEST/$f" ]] && leaked="$leaked $f"; done
	if [[ "$rc" -ne 0 && "$rc" -ne 99 && ! -e "$BOOT_DEST/box.env" && -z "$leaked" ]]; then
		ok "$name refuses to boot"
	else
		not_ok "$name: rc=$rc token=$([[ -e $BOOT_DEST/box.env ]] && echo yes || echo no) installed:${leaked:- none}"
	fi
}

assert_booted() {
	local name="$1" rc="$2"
	shift 2
	local bad=""
	for f in "$@"; do
		[[ "$(hash "$BOOT_DEST/$f" 2>/dev/null)" == "$(hash "$REPO/$f")" ]] || bad="$bad $f"
	done
	if [[ "$rc" -eq 0 && -e "$BOOT_DEST/box.env" && -z "$bad" && ! -e "$BOOT_DEST/.runner-staging" ]]; then
		ok "$name boots with every file in place"
	else
		not_ok "$name: rc=$rc missing/mismatched:${bad:- none}"
	fi
}

MANIFEST_CFG="{\"runner_ref\":\"$REF\",\"runner_sha256\":\"$LEGACY_SHA\",\"runner_files\":$MANIFEST}"
LEGACY_CFG="{\"runner_ref\":\"$REF\",\"runner_sha256\":\"$LEGACY_SHA\"}"

# 1. Intact manifest boots into the same relative layout.
serve intact
rc=0; boot intact "$MANIFEST_CFG" || rc=$?
assert_booted "intact manifest" "$rc" "${FILES[@]}"

# 2. Altering any one file refuses.
for f in "${FILES[@]}"; do
	n="tamper-${f//\//_}"
	serve "$n"
	echo '// injected' >>"$WORK/served-$n/$f"
	rc=0; boot "$n" "$MANIFEST_CFG" || rc=$?
	assert_refused "tampered $f" "$rc"
done

# 3. Omitting any one file refuses.
for f in "${FILES[@]}"; do
	n="omit-${f//\//_}"
	serve "$n"
	rm "$WORK/served-$n/$f"
	rc=0; boot "$n" "$MANIFEST_CFG" || rc=$?
	assert_refused "missing $f" "$rc"
done

# 4. Legacy single-file pin still boots; tampering it still refuses.
serve legacy
rc=0; boot legacy "$LEGACY_CFG" || rc=$?
assert_booted "legacy single-file pin" "$rc" box-runner.mjs
serve legacy-tamper
echo '// injected' >>"$WORK/served-legacy-tamper/box-runner.mjs"
rc=0; boot legacy-tamper "$LEGACY_CFG" || rc=$?
assert_refused "tampered legacy box-runner.mjs" "$rc"

# 5. Invalid manifests never produce a boot script.
NO_ENTRY="{\"runner_ref\":\"$REF\",\"runner_files\":{\"lib/util.mjs\":\"$(hash "$REPO/lib/util.mjs")\"}}"
UNSAFE="{\"runner_ref\":\"$REF\",\"runner_files\":{\"box-runner.mjs\":\"$LEGACY_SHA\",\"../evil.mjs\":\"$LEGACY_SHA\"}}"
for c in no-entry unsafe; do
	cfg="$NO_ENTRY"; [[ $c == unsafe ]] && cfg="$UNSAFE"
	serve "$c"
	rc=0; boot "$c" "$cfg" || rc=$?
	if [[ "$rc" -eq 99 ]]; then ok "$c manifest is rejected"; else not_ok "$c manifest: rc=$rc"; fi
done
if PIN_TS="$PIN_TS" bun --eval '
	const { runnerFetchScript } = await import(process.env.PIN_TS)
	try { runnerFetchScript({ ref: "abcdef0", files: { "lib/x.mjs": "a".repeat(64) } }); process.exit(1) } catch {}
' >/dev/null 2>&1; then ok "runnerFetchScript throws on a manifest without box-runner.mjs"; else not_ok "runnerFetchScript accepted a manifest without box-runner.mjs"; fi

echo "boot-pin-harness: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
