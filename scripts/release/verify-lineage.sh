#!/usr/bin/env bash
# Refuse to deploy a commit that would remove what production runs today.
#
# Usage: scripts/release/verify-lineage.sh <candidate-commit> [production-url]
#
# Reads the commit production reports at /api/version and checks that the candidate contains it
# (production commit is an ancestor of the candidate). Also refuses a dirty tree and a candidate
# that is not pushed to origin. Read-only: it changes nothing and deploys nothing.
set -euo pipefail
CANDIDATE="${1:?candidate commit required}"
PROD_URL="${2:-https://backend-production-production-2415eedf.up.railway.app}"

git fetch -q origin --tags
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "REFUSED: working tree has uncommitted changes"; exit 1; fi
CAND_SHA="$(git rev-parse --verify "$CANDIDATE^{commit}")"
if [ -z "$(git branch -r --contains "$CAND_SHA")" ]; then echo "REFUSED: $CAND_SHA is not on any pushed branch"; exit 1; fi

PROD_SHA="$(curl -fsS "$PROD_URL/api/version" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write((j.data||j).commitSha||"")})')"
if [ -z "$PROD_SHA" ]; then echo "REFUSED: production did not report a commit"; exit 1; fi
if ! git cat-file -e "$PROD_SHA^{commit}" 2>/dev/null; then echo "REFUSED: production commit $PROD_SHA is unknown to this repository"; exit 1; fi
if ! git merge-base --is-ancestor "$PROD_SHA" "$CAND_SHA"; then
  echo "REFUSED: candidate $CAND_SHA does not contain production $PROD_SHA — deploying it would remove live functionality"
  exit 1
fi
echo "OK: candidate $CAND_SHA contains production $PROD_SHA ($(git rev-list --count "$PROD_SHA..$CAND_SHA") new commits)"
git diff --stat "$PROD_SHA" "$CAND_SHA" -- prisma/migrations | tail -n 3
