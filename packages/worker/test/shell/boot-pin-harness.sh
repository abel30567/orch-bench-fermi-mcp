#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install a manifest only
# when every file matches its pinned sha256, and must fail closed (non-zero,
# nothing installed) when any one file is tampered with or missing. Run from
# packages/worker:
#   bash test/shell/boot-pin-harness.sh
set -u
cd "$(dirname "$0")/../.."

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# macOS lacks sha256sum; shim it onto shasum.
if ! command -v sha256sum >/dev/null 2>&1; then
	mkdir -p "$WORK/bin"
	printf '#!/bin/sh\nexec shasum -a 256 "$@"\n' > "$WORK/bin/sha256sum"
	chmod +x "$WORK/bin/sha256sum"
	export PATH="$WORK/bin:$PATH"
fi

PATHS="box-runner.mjs harness/claude.mjs lib/util.mjs"
sha() { sha256sum "$1" | cut -d' ' -f1; }

serve_pristine() {
	local p
	rm -rf "$WORK/served"
	mkdir -p "$WORK/served/harness" "$WORK/served/lib"
	for p in $PATHS; do echo "console.log('ok $p')" > "$WORK/served/$p"; done
}
serve_pristine

# Emit the real fragment from the TS module (node >=23 strips types natively).
# $1 = output file, $2 = fleet:config JSON.
fragment() {
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  console.log(m.runnerFetchScript(
    m.runnerPinFromConfig($2),
    { baseUrl: 'file://$WORK/served', destDir: '$WORK/installed' },
  ))
})" > "$1" || { echo "FRAGMENT GENERATION FAILED"; exit 1; }
}

manifest="{"
for p in $PATHS; do manifest="$manifest\"$p\":\"$(sha "$WORK/served/$p")\","; done
manifest="${manifest%,}}"
fragment "$WORK/manifest.sh" "{ runner_ref: 'testref', runner_files: $manifest }"
fragment "$WORK/legacy.sh" \
	"{ runner_ref: 'testref', runner_sha256: '$(sha "$WORK/served/box-runner.mjs")' }"

fail=0

# Boot must exit non-zero and leave nothing installed. $1 = case label.
expect_refused() {
	rm -rf "$WORK/installed"
	mkdir -p "$WORK/installed"
	if bash -euo pipefail "$WORK/manifest.sh" 2>/dev/null; then
		echo "FAIL: $1 accepted (exit 0)"; fail=1
	elif [ -n "$(find "$WORK/installed" -type f ! -path '*/.pin-staging/*')" ]; then
		echo "FAIL: $1 installed files despite non-zero exit"; fail=1
	else
		echo "ok: $1 refused, nothing installed"
	fi
}

# Case A: pristine manifest -> every file installs at its relative path, exit 0.
mkdir -p "$WORK/installed"
if ! bash -euo pipefail "$WORK/manifest.sh"; then
	echo "FAIL: pristine manifest was refused"; fail=1
else
	for p in $PATHS; do
		if cmp -s "$WORK/served/$p" "$WORK/installed/$p"; then
			echo "ok: pristine $p installed"
		else
			echo "FAIL: pristine $p was not installed"; fail=1
		fi
	done
	if [ -e "$WORK/installed/.pin-staging" ]; then
		echo "FAIL: staging directory left behind"; fail=1
	fi
fi

# Case B: each file tampered with in turn -> refused.
for p in $PATHS; do
	serve_pristine
	echo 'console.log("evil")' > "$WORK/served/$p"
	expect_refused "tampered $p"
done

# Case C: each file omitted in turn -> refused.
for p in $PATHS; do
	serve_pristine
	rm "$WORK/served/$p"
	expect_refused "omitted $p"
done

# Case D: legacy single-file pin -> boots.
serve_pristine
rm -rf "$WORK/installed"
mkdir -p "$WORK/installed"
if bash -euo pipefail "$WORK/legacy.sh" && [ -f "$WORK/installed/box-runner.mjs" ]; then
	echo "ok: legacy single-file pin installed"
else
	echo "FAIL: legacy single-file pin was not installed"; fail=1
fi

# Case E: legacy pin with a tampered runner -> refused.
rm -rf "$WORK/installed"
mkdir -p "$WORK/installed"
echo 'console.log("evil")' > "$WORK/served/box-runner.mjs"
if bash -euo pipefail "$WORK/legacy.sh" 2>/dev/null; then
	echo "FAIL: tampered legacy runner accepted (exit 0)"; fail=1
elif [ -f "$WORK/installed/box-runner.mjs" ]; then
	echo "FAIL: tampered legacy runner installed despite non-zero exit"; fail=1
else
	echo "ok: tampered legacy runner refused, nothing installed"
fi

exit $fail
