#!/usr/bin/env bash
# Run with: bash scripts/publish-release.sh
set -e
set -o pipefail

rpc_registry="https://registry.npmjs.org/"
rpc_repo="pponce/homebridge-rpc3control"
export GH_HOST=github.com
for rpc_tool in git node npm tar gh; do
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

rpc_source="$(git rev-parse HEAD)"
if ! gh auth status --hostname github.com; then
  gh auth login --hostname github.com --git-protocol ssh --web --skip-ssh-key
fi
rpc_github_login="$(gh api user --jq .login)"
echo "GitHub account: $rpc_github_login"
if [ "$rpc_github_login" != "pponce" ]; then
  echo "STOP: Expected GitHub account pponce."
  false
fi
if [ "$(gh api "repos/$rpc_repo/git/ref/heads/main" --jq .object.sha)" != "$rpc_source" ]; then
  echo "STOP: The checkout is not at the current GitHub main commit. Pull again."
  false
fi

rpc_release="$(mktemp -d "${TMPDIR:-/tmp}/rpc3control-release.XXXXXX")"
echo "Release directory: $rpc_release"
echo "Source commit: $rpc_source"
git archive "$rpc_source" | tar -x -C "$rpc_release"
# A new release must not reuse an existing remote tag.
# Check before leaving the checkout; git failures stop the release.
git ls-remote --tags origin > "$rpc_release/remote-tags.txt"
cd "$rpc_release"
node -e 'const p = require("./package.json"); if (p.name !== "homebridge-rpc3control" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(p.version) || p.private || p.publishConfig?.tag !== "latest" || p.publishConfig?.access !== "public" || p.publishConfig?.registry !== "https://registry.npmjs.org/") throw new Error("Expected a public homebridge-rpc3control stable version with latest publication defaults.");'
rpc_name="$(node -p 'require("./package.json").name')"
rpc_version="$(node -p 'require("./package.json").version')"
rpc_tag="v$rpc_version"
rpc_notes="releases/$rpc_tag.md"
test -s "$rpc_notes"
node -e 'const fs = require("node:fs"); const p = require("./package.json"); const refs = fs.readFileSync("remote-tags.txt", "utf8").split("\n").map(line => line.split(/\s+/)[1]); if (refs.includes(`refs/tags/v${p.version}`)) throw new Error("Release tag already exists. Review it before proceeding; it will not be moved.");'
gh api "repos/$rpc_repo/releases?per_page=100" --paginate --jq '.[].tag_name' > "$rpc_release/github-releases.txt"
node -e 'const fs = require("node:fs"); const p = require("./package.json"); if (fs.readFileSync("github-releases.txt", "utf8").split("\n").includes(`v${p.version}`)) throw new Error("GitHub release already exists. Review it before proceeding.");'
echo "Preparing $rpc_name@$rpc_version for npm latest and GitHub $rpc_tag."

# Fetch all existing versions: registry failures stop the release rather than
# being mistaken for proof that this version has not been published.
npm view "$rpc_name" versions --json --registry="$rpc_registry" > "$rpc_release/published-versions.json"
node -e 'const p = require("./package.json"); const result = require("./published-versions.json"); const versions = Array.isArray(result) ? result : [result]; if (!versions.length || !versions.every(v => typeof v === "string")) throw new Error("Unexpected npm registry response."); if (versions.includes(p.version)) throw new Error(`${p.name}@${p.version} is already published. Commit and push a new version before trying again. If recovering from a GitHub-only failure, use the recovery command from the previous run instead.`);'

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

echo "===== BUILD AND VERIFY STABLE RELEASE ====="
npm install --include=dev --registry="$rpc_registry"
npm run lint
npm test
npm pack --ignore-scripts
node scripts/check-package.mjs
rpc_archive="$rpc_name-$rpc_version.tgz"
test -s "$rpc_archive"

echo "===== PUBLISH STABLE RELEASE TO NPM ====="
# Build and tests already ran above; publish the checked archive, not the folder.
npm publish "$rpc_archive" --ignore-scripts --tag latest --access public --registry="$rpc_registry"
echo "Published $rpc_name@$rpc_version under the latest tag as $rpc_login."
echo "Package archive: $rpc_release/$rpc_archive"

echo "===== CREATE OFFICIAL GITHUB RELEASE ====="
if gh release create "$rpc_tag" "$rpc_archive" \
  --repo "$rpc_repo" \
  --target "$rpc_source" \
  --title "RPC PDU Control $rpc_version" \
  --notes-file "$rpc_notes" \
  --latest; then
  echo "GitHub release: https://github.com/$rpc_repo/releases/tag/$rpc_tag"
else
  echo "NPM PUBLICATION SUCCEEDED, but GitHub release creation did not finish."
  echo "Inspect GitHub for a partially created release. If no release exists, retry with:"
  printf "gh release create %q %q --repo %q --target %q --title %q --notes-file %q --latest\n" \
    "$rpc_tag" "$rpc_release/$rpc_archive" "$rpc_repo" "$rpc_source" \
    "RPC PDU Control $rpc_version" "$rpc_release/$rpc_notes"
  echo "Do not publish this npm version again. Release files remain at: $rpc_release"
  false
fi
echo "Homebridge installation is unchanged. Install/update through Homebridge UI when ready."
