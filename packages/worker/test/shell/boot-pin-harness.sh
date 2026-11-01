#!/usr/bin/env bash
# Tamper harness for #34: the runner-fetch fragment must install every manifest
# file whose sha256 matches the pin, into the same relative layout, and must
# fail closed (non-zero, nothing installed) when any one served file is
# tampered or missing. A legacy single-file pin must still boot. Run from
# packages/worker:
#   bash test/shell/boot-pin-harness.sh
set -u
cd "$(dirname "$0")/../.."

WORK=$(mktemp -d "${TMPDIR:-/tmp}/boot-pin.XXXXXX") || { echo "mktemp failed"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

# macOS lacks sha256sum; shim it onto shasum.
if ! command -v sha256sum >/dev/null 2>&1; then
	mkdir -p "$WORK/bin"
	printf '#!/bin/sh\nexec shasum -a 256 "$@"\n' > "$WORK/bin/sha256sum"
	chmod +x "$WORK/bin/sha256sum"
	export PATH="$WORK/bin:$PATH"
fi

SRV="$WORK/srv"
DEST="$WORK/install"
FILES="box-runner.mjs harness/index.mjs lib/util.mjs"

serve_pristine() {
	rm -rf "$SRV"
	mkdir -p "$SRV/harness" "$SRV/lib"
	echo 'import "./harness/index.mjs"; console.log("runner ok")' > "$SRV/box-runner.mjs"
	echo 'export const harness = "ok"' > "$SRV/harness/index.mjs"
	echo 'export const util = "ok"' > "$SRV/lib/util.mjs"
}

serve_pristine
sha() { sha256sum "$SRV/$1" | cut -d' ' -f1; }
SHA_RUNNER=$(sha box-runner.mjs)
SHA_HARNESS=$(sha harness/index.mjs)
SHA_UTIL=$(sha lib/util.mjs)

# Emit the real fragments from the TS module (node >=23 strips types natively),
# going through runnerPinFromConfig exactly as the provisioner does.
gen() { # $1 = fleet:config JSON, $2 = output file
	node --experimental-strip-types --no-warnings -e "
import('./src/lib/runner-pin.ts').then(m => {
  const pin = m.runnerPinFromConfig($1)
  if (!pin) { console.error('pin rejected'); process.exit(1) }
  console.log(m.runnerFetchScript(pin, { baseUrl: 'file://$SRV', dir: '$DEST' }))
})" > "$2" || { echo "FRAGMENT GENERATION FAILED"; exit 1; }
}
gen "{ runner_ref: 'testref', runner_sha256: '$SHA_RUNNER', runner_files: {
  'box-runner.mjs': '$SHA_RUNNER', 'harness/index.mjs': '$SHA_HARNESS', 'lib/util.mjs': '$SHA_UTIL' } }" \
	"$WORK/manifest.sh"
gen "{ runner_ref: 'testref', runner_sha256: '$SHA_RUNNER' }" "$WORK/legacy.sh"

fail=0

nothing_installed() {
	[ ! -e "$DEST" ] || [ -z "$(find "$DEST" -type f)" ]
}

expect_refused() { # $1 = label
	if bash -euo pipefail "$WORK/manifest.sh" 2>/dev/null; then
		echo "FAIL: $1 accepted (exit 0)"; fail=1
	elif ! nothing_installed; then
		echo "FAIL: $1 left files installed despite non-zero exit"; fail=1
	else
		echo "ok: $1 rejected, nothing installed"
	fi
}

# Case A: pristine manifest -> every file installed in the same layout, exit 0.
rm -rf "$DEST"
if ! bash -euo pipefail "$WORK/manifest.sh"; then
	echo "FAIL: pristine manifest did not boot"; fail=1
else
	for f in $FILES; do
		if ! cmp -s "$SRV/$f" "$DEST/$f"; then echo "FAIL: $f not installed at $DEST/$f"; fail=1; fi
	done
	[ $fail -eq 0 ] && echo "ok: pristine manifest installed ($FILES)"
fi

# Case B: altering any one file -> refuse.
for f in $FILES; do
	serve_pristine; rm -rf "$DEST"
	echo '// evil' >> "$SRV/$f"
	expect_refused "tampered $f"
done

# Case C: omitting any one file -> refuse.
for f in $FILES; do
	serve_pristine; rm -rf "$DEST"
	rm -f "$SRV/$f"
	expect_refused "missing $f"
done

# Case D: legacy single-file pin still boots.
serve_pristine; rm -rf "$DEST"
if bash -euo pipefail "$WORK/legacy.sh" && cmp -s "$SRV/box-runner.mjs" "$DEST/box-runner.mjs"; then
	echo "ok: legacy single-file pin installed box-runner.mjs"
else
	echo "FAIL: legacy single-file pin did not boot"; fail=1
fi

# Case E: legacy pin, tampered runner -> refuse.
rm -rf "$DEST"
echo '// evil' >> "$SRV/box-runner.mjs"
if bash -euo pipefail "$WORK/legacy.sh" 2>/dev/null || ! nothing_installed; then
	echo "FAIL: legacy pin accepted a tampered runner"; fail=1
else
	echo "ok: legacy pin rejected tampered runner, nothing installed"
fi

exit $fail
