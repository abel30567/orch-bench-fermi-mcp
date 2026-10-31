#!/usr/bin/env bash
# Boot-pin harness (#34, pr-55): runs the REAL runnerFetchScript() output under
# `set -euo pipefail` against a local file:// "raw GitHub" and asserts that a
# box only boots when every pinned file is present and matches its sha256.
# No network, no credentials. Needs bash, bun, curl and sha256sum.
#
#   bash packages/worker/test/shell/boot-pin-harness.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PIN_TS="$HERE/../../src/lib/runner-pin.ts"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/boot-pin.XXXXXX")" || { echo 'harness setup: mktemp failed' >&2; exit 2; }
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
bad() { fail=$((fail + 1)); echo "FAIL - $1"; }

sha() { sha256sum "$1" | cut -d' ' -f1; }

# Pristine "repo at ref": box-runner.mjs plus shared modules in subdirs. Pins
# hash these; each case serves a fresh copy it may then tamper with.
{
	mkdir -p "$TMP/orig/harness" "$TMP/orig/lib" &&
		echo "import './harness/claude.mjs'; console.log('runner')" >"$TMP/orig/box-runner.mjs" &&
		echo "export const route = 'claude'" >"$TMP/orig/harness/claude.mjs" &&
		echo "export const util = 1" >"$TMP/orig/lib/util.mjs"
} || { echo 'harness setup failed' >&2; exit 2; }
H() { sha "$TMP/orig/$1"; }

make_src() {
	rm -rf "$TMP/src" "$TMP/box"
	cp -R "$TMP/orig" "$TMP/src"
	mkdir -p "$TMP/box"
}

# Emit the boot fragment for a pin (JSON) via the real module.
script_for() {
	PIN="$1" BASE="file://$TMP/src" DIR="$TMP/box" bun -e "
		const { runnerFetchScript } = await import(process.argv[1])
		process.stdout.write(runnerFetchScript(JSON.parse(process.env.PIN), { baseUrl: process.env.BASE, dir: process.env.DIR }))
	" "$PIN_TS"
}

# Run the fragment like user-data does; return its exit code. A pin that
# cannot even produce a script aborts the harness (never a false "refused").
boot() {
	{ echo 'set -euo pipefail' && script_for "$1"; } >"$TMP/boot.sh" ||
		{ echo "harness: no boot script for $1" >&2; exit 2; }
	bash "$TMP/boot.sh" >/dev/null 2>&1
}

# Files at install paths; the unverified staging dir does not count.
installed_count() { find "$TMP/box" -path "$TMP/box/.runner.new" -prune -o -type f -print | wc -l | tr -d ' '; }

REF=0123456789abcdef0123456789abcdef01234567
MANIFEST_PATHS=(box-runner.mjs harness/claude.mjs lib/util.mjs)

manifest_pin() {
	printf '{"ref":"%s","files":{' "$REF"
	local sep=''
	for p in "${MANIFEST_PATHS[@]}"; do
		printf '%s"%s":"%s"' "$sep" "$p" "$(H "$p")"
		sep=','
	done
	printf '}}'
}

# 1. Legacy single-file pin boots.
make_src
if boot "{\"ref\":\"$REF\",\"files\":{\"box-runner.mjs\":\"$(H box-runner.mjs)\"}}" &&
	cmp -s "$TMP/src/box-runner.mjs" "$TMP/box/box-runner.mjs" && [ "$(installed_count)" = 1 ]; then
	ok 'legacy single-file pin boots and installs box-runner.mjs'
else
	bad 'legacy single-file pin boots and installs box-runner.mjs'
fi

# 2. Legacy pin with a tampered runner refuses.
make_src
echo 'evil()' >>"$TMP/src/box-runner.mjs"
if ! boot "{\"ref\":\"$REF\",\"files\":{\"box-runner.mjs\":\"$(H box-runner.mjs)\"}}" &&
	[ "$(installed_count)" = 0 ]; then
	ok 'legacy pin: tampered box-runner.mjs refuses, nothing installed'
else
	bad 'legacy pin: tampered box-runner.mjs refuses, nothing installed'
fi

# 3. Full manifest boots into the same relative layout.
make_src
if boot "$(manifest_pin)"; then
	all=1
	for p in "${MANIFEST_PATHS[@]}"; do cmp -s "$TMP/src/$p" "$TMP/box/$p" || all=0; done
	if [ "$all" = 1 ] && [ "$(installed_count)" = "${#MANIFEST_PATHS[@]}" ]; then
		ok 'manifest pin boots with every file in its relative path'
	else
		bad 'manifest pin boots with every file in its relative path (layout wrong)'
	fi
else
	bad 'manifest pin boots with every file in its relative path (boot failed)'
fi

# 4. Altering any one file refuses.
for p in "${MANIFEST_PATHS[@]}"; do
	make_src
	echo '// tampered' >>"$TMP/src/$p"
	if ! boot "$(manifest_pin)" && [ "$(installed_count)" = 0 ]; then
		ok "manifest: tampered $p refuses, nothing installed"
	else
		bad "manifest: tampered $p refuses, nothing installed"
	fi
done

# 5. Omitting any one file (missing at the ref) refuses.
for p in "${MANIFEST_PATHS[@]}"; do
	make_src
	rm "$TMP/src/$p"
	if ! boot "$(manifest_pin)" && [ "$(installed_count)" = 0 ]; then
		ok "manifest: missing $p refuses, nothing installed"
	else
		bad "manifest: missing $p refuses, nothing installed"
	fi
done

# 6. Invalid manifests never produce a boot script.
make_src
for pin in \
	"{\"ref\":\"$REF\",\"files\":{\"lib/util.mjs\":\"$(H lib/util.mjs)\"}}" \
	"{\"ref\":\"$REF\",\"files\":{\"box-runner.mjs\":\"$(H box-runner.mjs)\",\"../etc/x\":\"$(H lib/util.mjs)\"}}" \
	"{\"ref\":\"$REF\",\"files\":{\"box-runner.mjs\":\"$(H box-runner.mjs)\",\"a'b\":\"$(H lib/util.mjs)\"}}"; do
	if ! script_for "$pin" >/dev/null 2>&1; then
		ok "invalid manifest rejected: $pin"
	else
		bad "invalid manifest rejected: $pin"
	fi
done

echo "# pass $pass, fail $fail"
[ "$fail" = 0 ]
