#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install the pinned
# files when every sha256 matches, and must fail closed (non-zero, nothing
# installed) when any one file is tampered or missing. Also covers a legacy
# single-file pin. Run from packages/worker:
#   bash test/shell/boot-pin-harness.sh
set -u
cd "$(dirname "$0")/../.."

WORK=$(mktemp -d "$PWD/.boot-pin.XXXXXX") || { echo "MKTEMP FAILED"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

# macOS lacks sha256sum; shim it onto shasum.
if ! command -v sha256sum >/dev/null 2>&1; then
	mkdir -p "$WORK/bin"
	printf '#!/bin/sh\nexec shasum -a 256 "$@"\n' > "$WORK/bin/sha256sum"
	chmod +x "$WORK/bin/sha256sum"
	export PATH="$WORK/bin:$PATH"
fi

FILES="box-runner.mjs harness/index.mjs lib/util.mjs"

serve_pristine() {
	local f
	rm -rf "$WORK/serve"
	mkdir -p "$WORK/serve/harness" "$WORK/serve/lib"
	for f in $FILES; do echo "console.log('$f ok')" > "$WORK/serve/$f"; done
}

sha_of() { sha256sum "$WORK/serve/$1" | cut -d' ' -f1; }

# Emit the real fragment from the TS module (node >=23 strips types natively).
# $1: fleet:config JSON, $2: output file. Going through runnerPinFromConfig
# proves the stored shapes boot, not just a hand-built pin.
fragment() {
	CONFIG="$1" WORK="$WORK" node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig(JSON.parse(process.env.CONFIG))
  console.log(m.runnerFetchScript(pin, {
    baseUrl: 'file://' + process.env.WORK + '/serve',
    destDir: process.env.WORK + '/opt',
  }))
})" > "$2" || { echo "FRAGMENT GENERATION FAILED"; exit 1; }
}

fail=0

# Expect: boot exits non-zero and nothing at all lands in the install dir.
expect_refused() {
	local label=$1 script=$2
	rm -rf "$WORK/opt"
	mkdir -p "$WORK/opt"
	if bash -euo pipefail "$script" 2>/dev/null; then
		echo "FAIL: $label accepted (exit 0)"; fail=1
	elif [ -n "$(ls -A "$WORK/opt")" ]; then
		echo "FAIL: $label installed files despite non-zero exit"; fail=1
	else
		echo "ok: $label refused, nothing installed"
	fi
}

serve_pristine
MANIFEST='{"runner_ref":"testref","runner_files":{'
sep=''
for f in $FILES; do MANIFEST="$MANIFEST$sep\"$f\":\"$(sha_of "$f")\""; sep=','; done
MANIFEST="$MANIFEST}}"
fragment "$MANIFEST" "$WORK/manifest.sh"
fragment "{\"runner_ref\":\"testref\",\"runner_sha256\":\"$(sha_of box-runner.mjs)\"}" "$WORK/legacy.sh"

# Case A: pristine manifest -> every file installed at its relative path.
rm -rf "$WORK/opt"; mkdir -p "$WORK/opt"
bash -euo pipefail "$WORK/manifest.sh"
status=$?
for f in $FILES; do
	if [ $status -ne 0 ] || ! cmp -s "$WORK/serve/$f" "$WORK/opt/$f"; then
		echo "FAIL: pristine $f was not installed"; fail=1
	else
		echo "ok: pristine $f installed"
	fi
done

# Case B/C: each file in turn tampered, then omitted -> refused.
for f in $FILES; do
	serve_pristine
	echo 'console.log("evil")' > "$WORK/serve/$f"
	expect_refused "tampered $f" "$WORK/manifest.sh"
	serve_pristine
	rm -f "$WORK/serve/$f"
	expect_refused "omitted $f" "$WORK/manifest.sh"
done

# Case D: legacy single-file pin -> installs box-runner.mjs only, still fails closed.
serve_pristine
rm -rf "$WORK/opt"; mkdir -p "$WORK/opt"
bash -euo pipefail "$WORK/legacy.sh"
if [ $? -ne 0 ] || ! cmp -s "$WORK/serve/box-runner.mjs" "$WORK/opt/box-runner.mjs"; then
	echo "FAIL: legacy pin did not install box-runner.mjs"; fail=1
elif [ "$(ls -A "$WORK/opt")" != "box-runner.mjs" ]; then
	echo "FAIL: legacy pin installed extra files"; fail=1
else
	echo "ok: legacy pin installed"
fi
echo 'console.log("evil")' > "$WORK/serve/box-runner.mjs"
expect_refused "tampered legacy runner" "$WORK/legacy.sh"

exit $fail
