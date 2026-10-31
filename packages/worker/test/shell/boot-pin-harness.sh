#!/usr/bin/env bash
# Runs the real bootstrapUserData script in a scratch root, with fake curl,
# shutdown and systemctl on PATH, and asserts a boot installs the pinned runner
# only when every pinned file is present and matches. No network, no root.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# Scratch stays in the gitignored node_modules: sandboxed workers can't write $TMPDIR.
work=$(mktemp -d "$here/../../node_modules/.boot-pin.XXXXXX")
trap 'rm -rf "$work"' EXIT
ref=$(printf 'a%.0s' {1..40})
failures=0

pass() { echo "ok   - $1"; }
fail() {
	echo "FAIL - $1"
	failures=$((failures + 1))
}

mkdir -p "$work/bin"
cat >"$work/bin/curl" <<'FAKE'
#!/usr/bin/env bash
# Serves $FAKE_ORIGIN like raw.githubusercontent.com: -f semantics, no retries.
while [ $# -gt 0 ]; do
	case "$1" in
	-o) out=$2; shift ;;
	https://*) url=$1 ;;
	esac
	shift
done
file=$FAKE_ORIGIN/${url#https://raw.githubusercontent.com/abel30567/fermi-daemon/}
[ -f "$file" ] || exit 22
cp "$file" "$out"
FAKE
printf '#!/bin/sh\nexit 0\n' >"$work/bin/shutdown"
printf '#!/bin/sh\ntouch "$FAKE_ROOT/runner-started"\n' >"$work/bin/systemctl"
if ! command -v sha256sum >/dev/null; then
	printf '#!/bin/sh\nexec shasum -a 256 "$@"\n' >"$work/bin/sha256sum"
fi
chmod +x "$work"/bin/*
export PATH="$work/bin:$PATH"

# Prints the user-data for the fleet:config JSON in $1.
render() {
	PIN_CONFIG=$1 bun -e "
		import { bootstrapUserData } from '$here/../../src/lib/provisioner.ts'
		import { runnerPinFromConfig } from '$here/../../src/lib/runner-pin.ts'
		const runnerPin = runnerPinFromConfig(JSON.parse(process.env.PIN_CONFIG))
		if (!runnerPin) throw new Error('pin rejected')
		console.log(bootstrapUserData({
			boxId: 'box-test', agentId: 'ca_test', queue: 'agent:ca_test', route: 'claude',
			ttlSeconds: 600, mcpBaseUrl: null, boxToken: 'box-test.secret',
			claudeModel: null, runnerPin,
		}))"
}

sha() { sha256sum "$1" | cut -d' ' -f1; }

# boot <name> <config>: runs the user-data for <config> against origin/ in its own root.
boot() {
	root=$work/$1
	mkdir -p "$root"
	render "$2" | sed "s#/opt/fermi#$root/opt/fermi#g; s#/etc/fermi#$root/etc/fermi#g" >"$root/user-data"
	FAKE_ORIGIN=$work/origin FAKE_ROOT=$root bash "$root/user-data" >"$root/log" 2>&1
}

new_origin() {
	rm -rf "$work/origin"
	mkdir -p "$work/origin/$ref/lib" "$work/origin/$ref/harness"
	echo 'console.log("runner")' >"$work/origin/$ref/box-runner.mjs"
	echo 'export const lib = 1' >"$work/origin/$ref/lib/shared.mjs"
	echo 'export const harness = 1' >"$work/origin/$ref/harness/claude.mjs"
}

new_origin
files=(box-runner.mjs lib/shared.mjs harness/claude.mjs)
manifest=$(
	cd "$work/origin/$ref"
	for f in "${files[@]}"; do printf '"%s":"%s",' "$f" "$(sha "$f")"; done
)
manifest_config="{\"runner_ref\":\"$ref\",\"runner_files\":{${manifest%,}}}"
legacy_config="{\"runner_ref\":\"$ref\",\"runner_sha256\":\"$(sha "$work/origin/$ref/box-runner.mjs")\"}"

booted() {
	[ -f "$root/runner-started" ] && grep -q '^FERMI_BOX_TOKEN=' "$root/etc/fermi/box.env"
}

# Refusal: no credentials, runner not started, and nothing under /opt/fermi
# beyond $1, the listing of what the box already had.
refused() {
	[ ! -e "$root/etc/fermi/box.env" ] && [ ! -e "$root/runner-started" ] &&
		[ "$(cd "$root/opt/fermi" && find . -mindepth 1 | sort)" = "${1:-}" ]
}

if boot manifest "$manifest_config" && booted &&
	diff -r "$work/origin/$ref" "$root/opt/fermi" >/dev/null; then
	pass 'manifest boots with every file in its relative layout'
else
	fail 'manifest boots with every file in its relative layout'
	cat "$root/log"
fi

if boot legacy "$legacy_config" && booted &&
	[ "$(cd "$root/opt/fermi" && find . -type f)" = './box-runner.mjs' ]; then
	pass 'legacy single-file pin boots'
else
	fail 'legacy single-file pin boots'
	cat "$root/log"
fi

n=0
for f in "${files[@]}"; do
	n=$((n + 1))

	new_origin
	echo '// tampered' >>"$work/origin/$ref/$f"
	if ! boot "tamper-$n" "$manifest_config" && refused; then
		pass "tampered $f refuses boot"
	else
		fail "tampered $f refuses boot"
	fi

	new_origin
	rm "$work/origin/$ref/$f"
	if ! boot "omit-$n" "$manifest_config" && refused; then
		pass "omitted $f refuses boot"
	else
		fail "omitted $f refuses boot"
	fi
done

new_origin
echo '// tampered' >>"$work/origin/$ref/box-runner.mjs"
if ! boot legacy-tamper "$legacy_config" && refused; then
	pass 'tampered legacy pin refuses boot'
else
	fail 'tampered legacy pin refuses boot'
fi

# A baked runner must not be mixed with freshly fetched modules.
new_origin
echo '// tampered' >>"$work/origin/$ref/harness/claude.mjs"
mkdir -p "$work/baked/opt/fermi"
echo 'baked' >"$work/baked/opt/fermi/box-runner.mjs"
if ! boot baked "$manifest_config" && refused './box-runner.mjs' &&
	[ "$(cat "$root/opt/fermi/box-runner.mjs")" = 'baked' ]; then
	pass 'refused boot leaves a baked runner untouched'
else
	fail 'refused boot leaves a baked runner untouched'
fi

[ "$failures" -eq 0 ] || {
	echo "$failures boot-pin check(s) failed"
	exit 1
}
echo 'boot-pin harness passed'
