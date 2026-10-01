#!/usr/bin/env bash
# Runs the offline test suite on any machine with Node >= 20 (24 recommended). It needs only the ical.js library, which is
# installed into .test-deps/ on first use (a few MB; no n8n, no 3 GB runtime), verified against the integrity hash in
# package-lock.json. That first install needs the network; the tests themselves make no network calls and use no real services.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v node >/dev/null || { echo "Node.js is required (version 20 or newer)." >&2; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node $(node -v) is too old; use 20 or newer." >&2; exit 1; }
if [ ! -d "$ROOT/.test-deps/node_modules/ical.js" ]; then
  echo "Installing the test dependency (ical.js) into .test-deps/ ..."
  mkdir -p "$ROOT/.test-deps"
  # a one-package lock file built from OUR package-lock.json, so `npm ci` refuses a download whose hash differs
  node -e '
    const lock = require(process.argv[1] + "/package-lock.json").packages["node_modules/ical.js"];
    const v = lock.version;
    const out = { name: "brief-test-deps", lockfileVersion: 3, requires: true, packages: { "": { dependencies: { "ical.js": v } }, "node_modules/ical.js": { version: v, resolved: `https://registry.npmjs.org/ical.js/-/ical.js-${v}.tgz`, integrity: lock.integrity } } };
    require("fs").writeFileSync(process.argv[1] + "/.test-deps/package-lock.json", JSON.stringify(out, null, 2));
    require("fs").writeFileSync(process.argv[1] + "/.test-deps/package.json", JSON.stringify({ private: true, dependencies: { "ical.js": v } }));' "$ROOT"
  (cd "$ROOT/.test-deps" && npm ci --no-audit --no-fund >/dev/null)
fi
cd "$ROOT"
exec node --test "$@" "test/*.test.mjs"
