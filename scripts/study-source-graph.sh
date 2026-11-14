#!/usr/bin/env bash
# Build Craft Anything source graphs of OpenCost's allocation and pricing code into study/opencost-source-graph/
# (git-ignored: they copy string literals out of upstream, including test fixtures that look like secrets), then write
# the small, committed index study/opencost-source-graph.md from them.
set -euo pipefail
cd "$(dirname "$0")/.."
CLI=$(ls -d tools/craft-anything/craft-anything-cli-*/craft-anything-cli | tail -1)
out=study/opencost-source-graph
mkdir -p "$out"
# name:path pairs, relative to upstream/
for pair in \
  core-opencost:opencost/core/pkg/opencost \
  core-pricing:opencost/core/pkg/pricing \
  core-source:opencost/core/pkg/source \
  costmodel:opencost/pkg/costmodel \
  cloud-provider:opencost/pkg/cloud/provider \
  currency:opencost/pkg/currency \
  customcost:opencost/pkg/customcost \
  inferencecost:opencost/pkg/inferencecost \
  ui-app:opencost-ui/app; do
  name=${pair%%:*}; path=${pair#*:}
  "$CLI" --deep app-source-import --path "$PWD/upstream/$path" --respect-gitignore true > "$out/$name.json"
  echo "$name: $(wc -c < "$out/$name.json") bytes"
done
python3 -I scripts/study-source-index.py "$out" > study/opencost-source-graph.md
