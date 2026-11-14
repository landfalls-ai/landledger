#!/usr/bin/env bash
# Fetch the open-source projects Landledger studies into upstream/ (git-ignored).
# Pinned to the release tags the research was written against (each at least two weeks old when pinned);
# pass --latest to take the default branch instead.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p upstream
OPENCOST_COMMIT=2f1af7f0c26368b50bf981a25e9e5f38b800979f      # v1.121.3, released 2026-09-16 (Apache-2.0)
OPENCOST_UI_COMMIT=5babf86adf8d75677e721d62902b3b2b4d1a59a0   # v1.121.2, released 2026-09-11 (Apache-2.0)
FOCUS_COMMIT=f1eeb30a78f7c141ef1237d589355296a2761c1c         # v1.4, released 2026-06-04 (see docs/research.md: licence)
fetch() { # dir url commit
  if [ ! -d "upstream/$1/.git" ]; then
    git init -q "upstream/$1" && git -C "upstream/$1" remote add origin "$2"
  fi
  if [ "${LATEST:-}" = 1 ]; then git -C "upstream/$1" fetch -q --depth 1 --filter=blob:limit=5m origin HEAD
  else git -C "upstream/$1" fetch -q --depth 1 --filter=blob:limit=5m origin "$3"; fi
  git -C "upstream/$1" checkout -q FETCH_HEAD
  echo "$1 at $(git -C "upstream/$1" rev-parse --short HEAD)"
}
[ "${1:-}" = --latest ] && LATEST=1
fetch opencost https://github.com/opencost/opencost.git "$OPENCOST_COMMIT"
fetch opencost-ui https://github.com/opencost/opencost-ui.git "$OPENCOST_UI_COMMIT"
fetch focus-spec https://github.com/FinOps-Open-Cost-and-Usage-Spec/FOCUS_Spec.git "$FOCUS_COMMIT"
