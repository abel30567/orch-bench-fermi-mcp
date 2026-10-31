#!/usr/bin/env bash
# Tamper harness for the runner pin: runs the real runnerFetchScript output under
# `set -euo pipefail` against a fake curl (no network) and asserts that any
# altered or missing file refuses boot before credentials land, with nothing
# installed.
set -euo pipefail

command -v sha256sum >/dev/null || { echo 'boot-pin-harness: sha256sum is required' >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
export PIN_MODULE="$HERE/../../src/lib/runner-pin.ts"
REF=0123456789abcdef0123456789abcdef01234567
BAD_HASH=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FILES=(box-runner.mjs harness/claude.mjs lib/util.mjs)

# Beside the script, not under $TMPDIR: sandboxed workers may only write their worktree.
WORK="$(mktemp -d "$HERE/.work.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/pristine/harness" "$WORK/pristine/lib"
for f in "${FILES[@]}"; do echo "// $f" >"$WORK/pristine/$f"; done

# Serves $ORIGIN/<path> for the pinned raw.githubusercontent.com URL; 22 is curl -f's 404.
{
	echo '#!/usr/bin/env bash'
	echo 'while [ $# -gt 0 ]; do'
	echo '	case "$1" in'
	echo '		-o) dest="$2"; shift ;;'
	echo '		https://raw.githubusercontent.com/*) url="$1" ;;'
	echo '	esac'
	echo '	shift'
	echo 'done'
	echo 'src="$ORIGIN/${url#https://raw.githubusercontent.com/abel30567/fermi-daemon/*/}"'
	echo '[ -f "$src" ] || exit 22'
	echo 'cp "$src" "$dest"'
} >"$WORK/bin/curl"
chmod +x "$WORK/bin/curl"
export PATH="$WORK/bin:$PATH"

hash_of() { sha256sum "$1" | cut -d' ' -f1; }

# Prints the fetch script for a fleet:config JSON; fails when it has no valid pin.
fetch_script() {
	CONFIG="$1" DIR="$WORK/opt/fermi" bun -e '
		const { runnerFetchScript, runnerPinFromConfig } = await import(process.env.PIN_MODULE)
		const pin = runnerPinFromConfig(JSON.parse(process.env.CONFIG))
		if (!pin) throw new Error("no valid pin")
		console.log(runnerFetchScript(pin, { dir: process.env.DIR }))
	' 2>/dev/null
}

manifest_config() {
	local entries=() f
	for f in "${FILES[@]}"; do entries+=("\"$f\":\"$(hash_of "$WORK/pristine/$f")\""); done
	local IFS=,
	echo "{\"runner_ref\":\"$REF\",\"runner_files\":{${entries[*]}}}"
}

legacy_config() {
	echo "{\"runner_ref\":\"$REF\",\"runner_sha256\":\"$(hash_of "$WORK/pristine/box-runner.mjs")\"}"
}

# Boot with the origin at $ORIGIN: the box token lands only after the pinned fetch.
boot() {
	rm -rf "$WORK/opt" "$WORK/token"
	mkdir -p "$WORK/opt/fermi"
	{
		echo 'set -euo pipefail'
		echo "$1"
		echo "touch '$WORK/token'"
	} >"$WORK/boot.sh"
	bash "$WORK/boot.sh" >/dev/null 2>&1
}

failures=0
pass() { echo "ok   - $1"; }
fail() {
	echo "FAIL - $1"
	failures=$((failures + 1))
}

expect_refused() {
	local name="$1" script="$2"
	if boot "$script"; then
		fail "$name: boot was not refused"
	elif [ -e "$WORK/token" ]; then
		fail "$name: credentials landed"
	elif [ -n "$(find "$WORK/opt/fermi" -type f)" ]; then
		fail "$name: files were installed"
	else
		pass "$name"
	fi
}

expect_booted() {
	local name="$1" script="$2" before="$failures" f
	shift 2
	if ! boot "$script"; then
		fail "$name: boot refused"
		return
	fi
	[ -e "$WORK/token" ] || fail "$name: credentials missing"
	[ ! -e "$WORK/opt/fermi.new" ] || fail "$name: staging dir left behind"
	for f in "$@"; do
		cmp -s "$WORK/pristine/$f" "$WORK/opt/fermi/$f" || fail "$name: $f not installed intact"
	done
	[ "$(find "$WORK/opt/fermi" -type f | wc -l | tr -d ' ')" = "$#" ] || fail "$name: unexpected files"
	[ "$failures" != "$before" ] || pass "$name"
}

export ORIGIN="$WORK/pristine"
MANIFEST="$(fetch_script "$(manifest_config)")"
LEGACY="$(fetch_script "$(legacy_config)")"

expect_booted 'manifest pin boots' "$MANIFEST" "${FILES[@]}"
expect_booted 'legacy single-file pin boots' "$LEGACY" box-runner.mjs

export ORIGIN="$WORK/tampered"
for f in "${FILES[@]}"; do
	rm -rf "$ORIGIN"
	cp -R "$WORK/pristine" "$ORIGIN"
	echo '// tampered' >>"$ORIGIN/$f"
	expect_refused "tampered $f refuses boot" "$MANIFEST"
	rm "$ORIGIN/$f"
	expect_refused "omitted $f refuses boot" "$MANIFEST"
done

rm -rf "$ORIGIN"
cp -R "$WORK/pristine" "$ORIGIN"
echo '// tampered' >>"$ORIGIN/box-runner.mjs"
expect_refused 'tampered legacy runner refuses boot' "$LEGACY"
rm "$ORIGIN/box-runner.mjs"
expect_refused 'omitted legacy runner refuses boot' "$LEGACY"

for bad in '../box-runner.mjs' 'lib/util.mjs'; do
	config="{\"runner_ref\":\"$REF\",\"runner_files\":{\"$bad\":\"$BAD_HASH\"}}"
	if fetch_script "$config" >/dev/null; then
		fail "invalid manifest produced a script: $bad"
	else
		pass "invalid manifest yields no boot script: $bad"
	fi
done

if [ "$failures" -gt 0 ]; then
	echo "boot-pin-harness: $failures failure(s)" >&2
	exit 1
fi
echo 'boot-pin-harness: all passed'
