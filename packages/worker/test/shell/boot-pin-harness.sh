#!/usr/bin/env bash
# Tamper harness for the runner pin (#34): renders the real boot fetch fragment
# from src/lib/runner-pin.ts, serves a local file:// mirror (no network) and
# asserts that any tampered or missing manifest file refuses to boot with
# nothing installed, while good manifests and a legacy single-file pin boot.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d 2>/dev/null || mktemp -d "$here/.tmp-boot-pin.XXXXXX")"
trap 'rm -rf "$work"' EXIT
fail=0
pass=0

sha() { sha256sum "$1" | cut -d' ' -f1; }

# A fresh mirror of a fake daemon checkout.
make_mirror() {
	rm -rf "$work/mirror"
	mkdir -p "$work/mirror/harness" "$work/mirror/lib"
	echo 'import "./harness/index.mjs"; console.log("runner")' >"$work/mirror/box-runner.mjs"
	echo 'export const harness = "claude"' >"$work/mirror/harness/index.mjs"
	echo 'export const util = 1' >"$work/mirror/lib/util.mjs"
}

manifest_json() {
	local ref=0123456789abcdef0123456789abcdef01234567
	printf '{"ref":"%s","files":{"box-runner.mjs":"%s","harness/index.mjs":"%s","lib/util.mjs":"%s"}}' \
		"$ref" "$(sha "$work/mirror/box-runner.mjs")" "$(sha "$work/mirror/harness/index.mjs")" \
		"$(sha "$work/mirror/lib/util.mjs")"
}

legacy_json() {
	# Shape runnerPinFromConfig produces from a legacy {runner_ref, runner_sha256}.
	printf '{"ref":"0123456789abcdef0123456789abcdef01234567","files":{"box-runner.mjs":"%s"}}' \
		"$(sha "$work/mirror/box-runner.mjs")"
}

# boot <pin json> → runs the fragment under set -euo pipefail, then writes the
# credential marker (as bootstrapUserData does after the fetch).
boot() {
	rm -rf "$work/dest"
	bun "$here/render-fetch.ts" "$1" "file://$work/mirror" "$work/dest" >"$work/boot.sh"
	printf 'touch "%s/dest/box.env"\n' "$work" >>"$work/boot.sh"
	bash -euo pipefail "$work/boot.sh" >/dev/null 2>&1
}

expect_boot() {
	local name="$1"
	shift
	if boot "$1" && [ -f "$work/dest/box.env" ] && cmp -s "$work/mirror/box-runner.mjs" "$work/dest/box-runner.mjs"; then
		local f
		for f in "${@:2}"; do
			cmp -s "$work/mirror/$f" "$work/dest/$f" || {
				echo "FAIL $name: $f not installed"
				fail=$((fail + 1))
				return
			}
		done
		echo "ok   $name"
		pass=$((pass + 1))
	else
		echo "FAIL $name: expected boot to succeed"
		fail=$((fail + 1))
	fi
}

expect_refuse() {
	local name="$1"
	if boot "$2"; then
		echo "FAIL $name: boot should have refused"
		fail=$((fail + 1))
	elif [ -e "$work/dest/box.env" ] || [ -n "$(find "$work/dest" -path '*/.runner-stage.*' -prune -o -name '*.mjs' -print 2>/dev/null)" ]; then
		echo "FAIL $name: refused but left files installed or credentials written"
		fail=$((fail + 1))
	else
		echo "ok   $name"
		pass=$((pass + 1))
	fi
}

files=(box-runner.mjs harness/index.mjs lib/util.mjs)

make_mirror
expect_boot "manifest boots and installs the relative layout" "$(manifest_json)" "${files[@]}"

make_mirror
expect_boot "legacy single-file pin boots" "$(legacy_json)" box-runner.mjs

for f in "${files[@]}"; do
	make_mirror
	pin="$(manifest_json)"
	echo '// tampered' >>"$work/mirror/$f"
	expect_refuse "tampered $f refuses" "$pin"

	make_mirror
	pin="$(manifest_json)"
	rm "$work/mirror/$f"
	expect_refuse "missing $f refuses" "$pin"
done

make_mirror
pin="$(legacy_json)"
echo '// tampered' >>"$work/mirror/box-runner.mjs"
expect_refuse "tampered legacy pin refuses" "$pin"

echo "boot-pin-harness: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
