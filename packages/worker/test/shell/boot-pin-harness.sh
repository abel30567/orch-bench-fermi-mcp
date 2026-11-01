#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every pinned
# file whose sha256 matches the manifest, and must fail closed (non-zero,
# nothing installed) when ANY served file is tampered with or missing. Covers
# both a legacy single-file pin and a multi-file manifest. Run from
# packages/worker:
#   bash test/shell/boot-pin-harness.sh
set -u
cd "$(dirname "$0")/../.."

WORK=$(mktemp -d "${TMPDIR:-/tmp}/boot-pin.XXXXXX") || { echo "MKTEMP FAILED"; exit 1; }
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

# macOS lacks sha256sum; shim it onto shasum.
if ! command -v sha256sum >/dev/null 2>&1; then
	printf '#!/bin/sh\nexec shasum -a 256 "$@"\n' > "$WORK/bin/sha256sum"
	chmod +x "$WORK/bin/sha256sum"
fi
# Drop curl's retry flags so missing-file cases fail fast (retries only cover
# CDN throttling; the hash gate under test is unaffected).
REAL_CURL=$(command -v curl)
cat > "$WORK/bin/curl" <<SHIM
#!/usr/bin/env bash
args=()
skip=0
for a in "\$@"; do
	if [ \$skip -eq 1 ]; then skip=0; continue; fi
	case "\$a" in
		--retry|--retry-delay) skip=1 ;;
		--retry-all-errors) ;;
		*) args+=("\$a") ;;
	esac
done
exec "$REAL_CURL" "\${args[@]}"
SHIM
chmod +x "$WORK/bin/curl"
export PATH="$WORK/bin:$PATH"

sha() { sha256sum "$1" | cut -d' ' -f1; }

# fragment <manifest-json> <out>: emit the real fragment from the TS module
# (node >=23 strips types natively).
fragment() {
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  console.log(m.runnerFetchScript(
    { ref: 'testref', files: $1 },
    { baseUrl: 'file://$WORK/srv', dir: '$WORK/inst' },
  ))
})" > "$2" || { echo "FRAGMENT GENERATION FAILED"; exit 1; }
}

fail=0
FILES=(box-runner.mjs harness/claude.mjs lib/util.mjs)

serve_pristine() {
	rm -rf "$WORK/srv" && mkdir -p "$WORK/srv/harness" "$WORK/srv/lib"
	echo 'console.log("runner ok")' > "$WORK/srv/box-runner.mjs"
	echo 'export const harness = "claude"' > "$WORK/srv/harness/claude.mjs"
	echo 'export const util = 1' > "$WORK/srv/lib/util.mjs"
}

nothing_installed() {
	for f in "${FILES[@]}"; do [ -f "$WORK/inst/$f" ] && return 1; done
	return 0
}

# expect_refused <label>: run the fragment, it must exit non-zero and install nothing.
expect_refused() {
	rm -rf "$WORK/inst" && mkdir -p "$WORK/inst"
	if bash -euo pipefail "$WORK/fragment.sh" 2>/dev/null; then
		echo "FAIL: $1 accepted (exit 0)"; fail=1
	elif ! nothing_installed; then
		echo "FAIL: $1 installed files despite non-zero exit"; fail=1
	else
		echo "ok: $1 rejected, nothing installed"
	fi
}

# --- Legacy single-file pin -------------------------------------------------
serve_pristine
fragment "{ 'box-runner.mjs': '$(sha "$WORK/srv/box-runner.mjs")' }" "$WORK/fragment.sh"

rm -rf "$WORK/inst" && mkdir -p "$WORK/inst"
if bash -euo pipefail "$WORK/fragment.sh" && [ -f "$WORK/inst/box-runner.mjs" ]; then
	echo "ok: legacy pin — pristine runner installed"
else
	echo "FAIL: legacy pin — pristine runner was not installed"; fail=1
fi

echo 'console.log("evil")' > "$WORK/srv/box-runner.mjs"
expect_refused "legacy pin — tampered runner"

# --- Multi-file manifest ----------------------------------------------------
serve_pristine
MANIFEST="{ 'box-runner.mjs': '$(sha "$WORK/srv/box-runner.mjs")', 'harness/claude.mjs': '$(sha "$WORK/srv/harness/claude.mjs")', 'lib/util.mjs': '$(sha "$WORK/srv/lib/util.mjs")' }"
fragment "$MANIFEST" "$WORK/fragment.sh"

rm -rf "$WORK/inst" && mkdir -p "$WORK/inst"
if bash -euo pipefail "$WORK/fragment.sh"; then
	ok=1
	for f in "${FILES[@]}"; do
		cmp -s "$WORK/srv/$f" "$WORK/inst/$f" || { echo "FAIL: manifest — $f not installed at same relative path"; ok=0; fail=1; }
	done
	[ $ok -eq 1 ] && echo "ok: manifest — all files installed in the same layout"
else
	echo "FAIL: manifest — pristine files rejected"; fail=1
fi

for f in "${FILES[@]}"; do
	serve_pristine
	echo '// evil' >> "$WORK/srv/$f"
	expect_refused "manifest — tampered $f"
done

for f in "${FILES[@]}"; do
	serve_pristine
	rm -f "$WORK/srv/$f"
	expect_refused "manifest — missing $f"
done

# --- Invalid manifests never render a boot script ---------------------------
for bad in \
	"{ 'harness/claude.mjs': '$(printf 'a%.0s' {1..64})' }" \
	"{ 'box-runner.mjs': '$(printf 'a%.0s' {1..64})', '../etc/passwd': '$(printf 'a%.0s' {1..64})' }" \
	"{ 'box-runner.mjs': '$(printf 'a%.0s' {1..64})', '/etc/x': '$(printf 'a%.0s' {1..64})' }" \
	"{ 'box-runner.mjs': 'not-a-hash' }"; do
	if node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  try { m.runnerFetchScript({ ref: 'testref', files: $bad }); process.exit(0) } catch { process.exit(3) }
})"; then
		echo "FAIL: invalid manifest rendered a script: $bad"; fail=1
	else
		echo "ok: invalid manifest refused: $bad"
	fi
done

exit $fail
