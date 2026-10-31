#!/usr/bin/env bash
# Tamper harness for the runner pin (#34). Generates the real boot fragment
# from src/lib/runner-pin.ts, serves a fake fermi-daemon tree over file:// (no
# network), and asserts:
#   - an intact manifest boots and installs every file in the same layout;
#   - altering or omitting ANY one manifest file refuses boot, nothing installed;
#   - a legacy single-file pin (runner_ref + runner_sha256) still boots;
#   - an invalid manifest never produces a script.
# Run: bash packages/worker/test/shell/boot-pin-harness.sh  (needs bun, curl, sha256sum)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIN_TS="$HERE/../../src/lib/runner-pin.ts"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/boot-pin.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
not_ok() { fail=$((fail + 1)); echo "FAIL - $1"; }

FILES=(box-runner.mjs harness/claude.mjs lib/log.mjs)
SRC="$WORK/src"
mkdir -p "$SRC/harness" "$SRC/lib"
echo 'import "./harness/claude.mjs"; console.log("runner")' >"$SRC/box-runner.mjs"
echo 'export const harness = "claude"' >"$SRC/harness/claude.mjs"
echo 'export const log = console.log' >"$SRC/lib/log.mjs"

sha() { sha256sum "$1" | cut -d' ' -f1; }

# JSON config object for runnerPinFromConfig: full manifest of the pristine tree.
manifest_config() {
	local json='{"runner_ref":"'"$(printf 'a%.0s' {1..40})"'","runner_files":{'
	local sep=''
	for f in "${FILES[@]}"; do
		json+="$sep\"$f\":\"$(sha "$SRC/$f")\""
		sep=','
	done
	echo "$json}}"
}
legacy_config() {
	echo '{"runner_ref":"'"$(printf 'a%.0s' {1..40})"'","runner_sha256":"'"$(sha "$SRC/box-runner.mjs")"'"}'
}

# gen_script CONFIG_JSON SERVE_DIR INSTALL_DIR → prints the boot fragment (or fails).
gen_script() {
	PIN_TS="$PIN_TS" CONFIG="$1" BASE="file://$2" DIR="$3" bun -e '
		const { runnerPinFromConfig, runnerFetchScript } = await import(process.env.PIN_TS)
		const pin = runnerPinFromConfig(JSON.parse(process.env.CONFIG))
		if (!pin) { console.error("pin invalid"); process.exit(3) }
		console.log(runnerFetchScript(pin, { baseUrl: process.env.BASE, dir: process.env.DIR, retries: 0 }))
	'
}

# boot CONFIG_JSON SERVE_DIR INSTALL_DIR → exit status of the boot fragment.
boot() {
	local script
	script="$(gen_script "$1" "$2" "$3")" || return 99
	mkdir -p "$3"
	bash -euo pipefail -c "$script" >/dev/null 2>&1
}

# Files at their final paths; the aborted staging dir is never executed.
installed_count() { find "$1" -path "$1/.runner.new" -prune -o -type f -print | wc -l | tr -d ' '; }

fresh_serve() {
	local dir="$WORK/serve-$1"
	rm -rf "$dir"
	cp -R "$SRC" "$dir"
	echo "$dir"
}

# 1. Intact manifest boots and installs every file in the same layout.
serve="$(fresh_serve intact)"
dest="$WORK/install-intact"
if boot "$(manifest_config)" "$serve" "$dest"; then
	all=1
	for f in "${FILES[@]}"; do
		[[ -f "$dest/$f" && "$(sha "$dest/$f")" == "$(sha "$SRC/$f")" ]] || all=0
	done
	[[ ! -e "$dest/.runner.new" ]] || all=0
	if [[ $all == 1 ]]; then ok "intact manifest boots, all files installed"; else not_ok "intact manifest: layout wrong"; fi
else
	not_ok "intact manifest refused to boot"
fi

# 2. Tampering any one file refuses, nothing installed.
for f in "${FILES[@]}"; do
	tag="tamper-${f//\//_}"
	serve="$(fresh_serve "$tag")"
	echo '// evil' >>"$serve/$f"
	dest="$WORK/install-$tag"
	if boot "$(manifest_config)" "$serve" "$dest"; then
		not_ok "tampered $f booted"
	elif [[ "$(installed_count "$dest")" != 0 ]]; then
		not_ok "tampered $f refused but left files installed"
	else
		ok "tampered $f refuses boot, nothing installed"
	fi
done

# 3. Omitting any one file refuses, nothing installed.
for f in "${FILES[@]}"; do
	tag="omit-${f//\//_}"
	serve="$(fresh_serve "$tag")"
	rm -f "$serve/$f"
	dest="$WORK/install-$tag"
	if boot "$(manifest_config)" "$serve" "$dest"; then
		not_ok "omitted $f booted"
	elif [[ "$(installed_count "$dest")" != 0 ]]; then
		not_ok "omitted $f refused but left files installed"
	else
		ok "omitted $f refuses boot, nothing installed"
	fi
done

# 4. Legacy single-file pin still boots; a tampered legacy runner does not.
serve="$(fresh_serve legacy)"
dest="$WORK/install-legacy"
if boot "$(legacy_config)" "$serve" "$dest" && [[ "$(sha "$dest/box-runner.mjs")" == "$(sha "$SRC/box-runner.mjs")" ]] && [[ "$(installed_count "$dest")" == 1 ]]; then
	ok "legacy single-file pin boots"
else
	not_ok "legacy single-file pin did not boot"
fi
serve="$(fresh_serve legacy-tamper)"
echo '// evil' >>"$serve/box-runner.mjs"
dest="$WORK/install-legacy-tamper"
if boot "$(legacy_config)" "$serve" "$dest" || [[ "$(installed_count "$dest")" != 0 ]]; then
	not_ok "tampered legacy runner booted or left files"
else
	ok "tampered legacy runner refuses boot"
fi

# 5. Invalid manifests never produce a script.
H="$(sha "$SRC/box-runner.mjs")"
REF="$(printf 'a%.0s' {1..40})"
for bad in \
	'{"runner_ref":"'"$REF"'","runner_files":{"lib/log.mjs":"'"$H"'"}}' \
	'{"runner_ref":"'"$REF"'","runner_files":{"box-runner.mjs":"'"$H"'","../escape.mjs":"'"$H"'"}}' \
	'{"runner_ref":"'"$REF"'","runner_files":{"box-runner.mjs":"'"$H"'","/etc/passwd":"'"$H"'"}}' \
	'{"runner_ref":"'"$REF"'","runner_files":{"box-runner.mjs":"nothex"}}' \
	'{"runner_ref":"x'"'"'; rm -rf /","runner_sha256":"'"$H"'"}'; do
	if gen_script "$bad" "$WORK/src" "$WORK/install-bad" >/dev/null 2>&1; then
		not_ok "invalid pin produced a script: $bad"
	else
		ok "invalid pin rejected: ${bad:0:60}…"
	fi
done
if PIN_TS="$PIN_TS" bun -e '
	const { runnerFetchScript } = await import(process.env.PIN_TS)
	try { runnerFetchScript({ ref: "a".repeat(40), files: { "lib/x.mjs": "0".repeat(64) } }); process.exit(1) } catch {}
' >/dev/null 2>&1; then
	ok "runnerFetchScript throws on a manifest without box-runner.mjs"
else
	not_ok "runnerFetchScript accepted a manifest without box-runner.mjs"
fi

echo "# boot-pin-harness: $pass passed, $fail failed"
[[ $fail == 0 ]]
