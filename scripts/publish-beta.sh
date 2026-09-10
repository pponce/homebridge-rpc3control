#!/usr/bin/env bash
# Run with: bash scripts/publish-beta.sh
set -e
set -o pipefail

rpc_registry="https://registry.npmjs.org/"
for rpc_tool in git node npm tar; do
  command -v "$rpc_tool" >/dev/null
done
cd "$(git rev-parse --show-toplevel)"
if [ "$(git branch --show-current)" != "main" ]; then
  echo "STOP: Switch to main before publishing."
  false
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "STOP: The working checkout has uncommitted files. Commit or move them before publishing."
  false
fi
case "$(git remote get-url origin)" in
  git@github.com:pponce/homebridge-rpc3control.git|https://github.com/pponce/homebridge-rpc3control.git|https://github.com/pponce/homebridge-rpc3control|ssh://git@github.com/pponce/homebridge-rpc3control.git) ;;
  *) echo "STOP: origin must point to pponce/homebridge-rpc3control."; false ;;
esac
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "STOP: Pull and synchronize main with origin/main before publishing."
  false
fi
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (!((major === 22 && minor >= 13) || major === 24)) throw new Error("Use Node 22.13+ within 22, or Node 24.");'

rpc_release="$(mktemp -d "${TMPDIR:-/tmp}/rpc3control-beta.XXXXXX")"
echo "Release directory: $rpc_release"
echo "Source commit: $(git rev-parse HEAD)"
git archive HEAD | tar -x -C "$rpc_release"
cd "$rpc_release"
node -e 'const p = require("./package.json"); if (p.name !== "homebridge-rpc3control" || !/^\d+\.\d+\.\d+-beta\.\d+$/.test(p.version) || p.private || p.publishConfig?.tag !== "beta" || p.publishConfig?.access !== "public" || p.publishConfig?.registry !== "https://registry.npmjs.org/") throw new Error("Expected a public homebridge-rpc3control beta with beta publication defaults.");'
rpc_name="$(node -p 'require("./package.json").name')"
rpc_version="$(node -p 'require("./package.json").version')"
echo "Preparing $rpc_name@$rpc_version for the npm beta tag."

# Fetch all existing versions: registry failures stop the release rather than
# being mistaken for proof that this version has not been published.
npm view "$rpc_name" versions --json --registry="$rpc_registry" > "$rpc_release/published-versions.json"
node -e 'const p = require("./package.json"); const result = require("./published-versions.json"); const versions = Array.isArray(result) ? result : [result]; if (!versions.length || !versions.every(v => typeof v === "string")) throw new Error("Unexpected npm registry response."); if (versions.includes(p.version)) throw new Error(`${p.name}@${p.version} is already published. Commit and push a new beta version before trying again.`);'

rpc_login="$(npm whoami --registry="$rpc_registry" 2>/dev/null || true)"
if [ "$rpc_login" != "klidec" ]; then
  echo "Log in to npm as klidec. Open the displayed URL in your browser if requested."
  npm login --auth-type=web --browser=false --registry="$rpc_registry"
fi
rpc_login="$(npm whoami --registry="$rpc_registry")"
echo "npm account: $rpc_login"
if [ "$rpc_login" != "klidec" ]; then
  echo "STOP: Expected npm account klidec."
  false
fi

echo "===== BUILD AND VERIFY BETA ====="
npm install --include=dev --registry="$rpc_registry"
npm run lint
npm test
npm pack --ignore-scripts
node scripts/check-package.mjs
rpc_archive="$rpc_name-$rpc_version.tgz"
test -s "$rpc_archive"

echo "===== PUBLISH BETA TO NPM ====="
# Build and tests already ran above; publish the checked archive, not the folder.
npm publish "$rpc_archive" --ignore-scripts --tag beta --access public --registry="$rpc_registry"
echo "Published $rpc_name@$rpc_version under the beta tag as $rpc_login."
echo "Package archive: $rpc_release/$rpc_archive"
echo "Homebridge installation is unchanged. Install/update through Homebridge UI when ready."
