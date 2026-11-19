#!/usr/bin/env bash
#
# Deploys the `beta` branch to the beta site, on purpose and only on purpose.
#
#   npm run deploy:beta
#
# The beta site is a second sign-in address, for trying changes before they
# reach the one people's accounts depend on. Production (`main`) deploys
# itself when something is merged; beta never does. It goes out when someone
# runs this, from a clean `beta` checkout that matches GitHub, so what is live
# on beta is always a commit anyone can look up.
#
# Needs the Vercel CLI, logged in.
set -euo pipefail
cd "$(dirname "$0")/.."

refuse() { printf 'REFUSING TO DEPLOY BETA: %s\n' "$1" >&2; exit 1; }

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "beta" ] || refuse "on branch '$branch', not beta."
[ -z "$(git status --porcelain)" ] || refuse "the working tree has uncommitted changes."
git fetch --quiet origin beta
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/beta)" ] || refuse "local beta differs from origin/beta. Push or pull first."

commit="$(git rev-parse --short HEAD)"
org="$(node -p "require('./scripts/beta-project.json').orgId")"
project="$(node -p "require('./scripts/beta-project.json').projectId")"
url="$(node -p "require('./scripts/beta-project.json').url.replace(/\/$/, '')")"

echo "→ building $commit locally, to know what the live files should be"
BITLOGIN_CHANNEL=beta npm run build:demo >/dev/null
want="$(sha256sum packages/demo/dist/vendor/bitlogin/bitlogin.js | cut -d' ' -f1)"

echo "→ deploying $commit to $url"
log="$(mktemp)"
if ! VERCEL_ORG_ID="$org" VERCEL_PROJECT_ID="$project" \
  vercel deploy --prod --yes --build-env BITLOGIN_CHANNEL=beta >"$log" 2>&1; then
  tail -n 15 "$log" >&2
  refuse "Vercel did not take the deployment (see above)."
fi

echo "→ checking the live site"
got=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  got="$(curl -fsSL -m 20 "$url/vendor/bitlogin/bitlogin.js" | sha256sum | cut -d' ' -f1 || true)"
  [ "$got" = "$want" ] && break
  sleep 6
done
[ "$got" = "$want" ] || refuse "deployed, but $url serves a different widget than $commit builds (got ${got:0:12}, want ${want:0:12})."
for page in / /account.html /connect/; do
  curl -fsSL -m 20 "$url$page" | grep -q 'data-channel="beta"' || refuse "deployed, but $url$page is not marked as beta."
done
curl -fsSI -m 20 "$url/signer/" | grep -qi '^content-security-policy:.*frame-ancestors' || refuse "deployed, but $url/signer/ lacks its frame-ancestors policy."
curl -fsSI -m 20 "$url/connect/" | grep -qi '^x-frame-options: *DENY' || refuse "deployed, but $url/connect/ can be framed."

echo "BETA IS LIVE: $url is running $commit"
