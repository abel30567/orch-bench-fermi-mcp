#!/usr/bin/env bash
# Tamper harness for the runner pin (#34): renders the real boot fragment from
# src/lib/runner-pin.ts, serves a fake fermi-daemon tree over file://, and
# asserts the boot installs every pinned file when they all match, and fails
# closed with NOTHING installed when any one file is altered or missing.
# No network: curl reads file:// and a shim drops the CDN retry flags.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../../src/lib/runner-pin.ts"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/boot-pin.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

command -v sha256sum >/dev/null || { echo "boot-pin-harness: sha256sum required" >&2; exit 1; }
REAL_CURL="$(command -v curl)"
mkdir -p "$WORK/bin"
cat >"$WORK/bin/curl" <<EOF
#!/usr/bin/env bash
args=()
while [ \$# -gt 0 ]; do
	case "\$1" in
		--retry|--retry-delay) shift 2 ;;
		--retry-all-errors) shift ;;
		*) args+=("\$1"); shift ;;
	esac
done
exec "$REAL_CURL" "\${args[@]}"
EOF
chmod +x "$WORK/bin/curl"
export PATH="$WORK/bin:$PATH"

FILES=(box-runner.mjs harness/claude.mjs lib/queue.mjs)
REF=0123456789abcdef0123456789abcdef01234567
pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
bad() { fail=$((fail + 1)); echo "FAIL - $1"; }

# Fresh served tree with known content; prints nothing.
seed_tree() {
	rm -rf "$WORK/srv" && mkdir -p "$WORK/srv/harness" "$WORK/srv/lib"
	local f
	for f in "${FILES[@]}"; do printf 'export const file = %s\n' "'$f'" >"$WORK/srv/$f"; done
}
sha() { sha256sum "$1" | cut -d' ' -f1; }

# render <config-json> → boot fragment on stdout (exit 3 when the pin is invalid)
render() {
	bun -e "
		const { runnerPinFromConfig, runnerFetchScript } = await import(process.argv[1])
		const pin = runnerPinFromConfig(JSON.parse(process.argv[2]))
		if (!pin) process.exit(3)
		process.stdout.write(runnerFetchScript(pin, { baseUrl: 'file://$WORK/srv', root: '$WORK/root' }))
	" "$SRC" "$1"
}

# boot <config-json> → exit status of the rendered fragment under set -euo pipefail
boot() {
	rm -rf "$WORK/root" && mkdir -p "$WORK/root"
	render "$1" >"$WORK/boot.sh" || return 99
	bash -c "set -euo pipefail; source '$WORK/boot.sh'" >/dev/null 2>&1
}

nothing_installed() {
	local f
	for f in "${FILES[@]}"; do [ ! -e "$WORK/root/$f" ] || return 1; done
}

manifest_json() {
	local json='{' sep=''
	local f
	for f in "${FILES[@]}"; do json+="$sep\"$f\":\"$(sha "$WORK/srv/$f")\""; sep=','; done
	printf '{"runner_ref":"%s","runner_sha256":"%s","runner_files":%s}}' \
		"$REF" "$(sha "$WORK/srv/box-runner.mjs")" "$json"
}

# 1. Untampered manifest boots and installs the same relative layout.
seed_tree
CFG="$(manifest_json)"
if boot "$CFG"; then
	all=1
	for f in "${FILES[@]}"; do cmp -s "$WORK/srv/$f" "$WORK/root/$f" || all=0; done
	[ ! -e "$WORK/root/.runner-new" ] || all=0
	[ $all = 1 ] && ok "manifest boots, every file installed in layout" || bad "manifest layout"
else
	bad "untampered manifest refused to boot"
fi

# 2. Altering any one file refuses boot with nothing installed.
for f in "${FILES[@]}"; do
	seed_tree
	CFG="$(manifest_json)"
	echo '// injected' >>"$WORK/srv/$f"
	if ! boot "$CFG" && nothing_installed; then ok "tampered $f refuses boot"; else bad "tampered $f booted"; fi
done

# 3. Omitting any one file from the served tree refuses boot with nothing installed.
for f in "${FILES[@]}"; do
	seed_tree
	CFG="$(manifest_json)"
	rm "$WORK/srv/$f"
	if ! boot "$CFG" && nothing_installed; then ok "missing $f refuses boot"; else bad "missing $f booted"; fi
done

# 4. A legacy single-file pin still boots.
seed_tree
LEGACY="{\"runner_ref\":\"$REF\",\"runner_sha256\":\"$(sha "$WORK/srv/box-runner.mjs")\"}"
if boot "$LEGACY" && cmp -s "$WORK/srv/box-runner.mjs" "$WORK/root/box-runner.mjs"; then
	ok "legacy single-file pin boots"
else
	bad "legacy single-file pin refused"
fi

# 5. A tampered legacy runner refuses boot.
echo '// injected' >>"$WORK/srv/box-runner.mjs"
if ! boot "$LEGACY" && nothing_installed; then ok "tampered legacy runner refuses boot"; else bad "tampered legacy booted"; fi

# 6. A manifest that omits box-runner.mjs, or has an unsafe path, never renders.
seed_tree
NO_ENTRY="{\"runner_ref\":\"$REF\",\"runner_files\":{\"lib/queue.mjs\":\"$(sha "$WORK/srv/lib/queue.mjs")\"}}"
if ! render "$NO_ENTRY" >/dev/null 2>&1; then ok "manifest without box-runner.mjs refused"; else bad "manifest without box-runner.mjs rendered"; fi
UNSAFE="{\"runner_ref\":\"$REF\",\"runner_files\":{\"box-runner.mjs\":\"$(sha "$WORK/srv/box-runner.mjs")\",\"../etc/x\":\"$(sha "$WORK/srv/lib/queue.mjs")\"}}"
if ! render "$UNSAFE" >/dev/null 2>&1; then ok "unsafe path refused"; else bad "unsafe path rendered"; fi

echo "boot-pin-harness: $pass passed, $fail failed"
[ "$fail" = 0 ]
