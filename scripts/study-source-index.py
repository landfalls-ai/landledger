"""Write a small Markdown index of the Craft Anything source graphs in <dir> (stdout).

For each graph: its id, file count and languages. Craft Anything extracts symbols only for JavaScript and TypeScript,
so for Go files this script adds the top-level `func` declarations with their line numbers, read from the file the
graph names (and checked against the graph's sha256), so the research can cite upstream/<repo>/<file>:<line>.
"""
import hashlib
import json
import pathlib
import re
import sys

FUNC = re.compile(r"^func (?:\(([^)]*)\) )?([A-Za-z_][A-Za-z0-9_]*)")


def main(folder: str) -> None:
    out = ["# OpenCost source graphs: index", "",
           "Written by `scripts/study-source-graph.sh` from Craft Anything `app_source_import` graphs (the JSON is "
           "git-ignored in `study/opencost-source-graph/`). Go symbols: top-level `func` lines, read from the files "
           "the graphs name; a file whose sha256 differs from the graph's is marked.", ""]
    for graph in sorted(pathlib.Path(folder).glob("*.json")):
        data = json.loads(graph.read_text())
        root = pathlib.Path(data["params"]["path"])
        res = data["result"]
        files = res["files"]
        langs = ", ".join(f"{k} {v}" for k, v in sorted(res["languages"].items()))
        rel = root.as_posix().split("/upstream/", 1)[-1]
        out += [f"## {graph.stem}: `upstream/{rel}`", "",
                f"`{res['source_graph_id'][:19]}…` · {len(files)} files ({langs}) · truncated: {res['truncated']}", ""]
        for f in files:
            path = root / f["path"]
            if f["path"].endswith("_test.go") or f["path"].endswith(".test.js") or f["path"].endswith(".test.ts"):
                continue
            if f["language"] == "go":
                raw = path.read_bytes()
                ok = hashlib.sha256(raw).hexdigest() == f["sha256"]
                funcs = []
                for n, line in enumerate(raw.decode("utf-8", "replace").splitlines(), 1):
                    m = FUNC.match(line)
                    if m:
                        recv = m.group(1).split()[-1].lstrip("*") + "." if m.group(1) else ""
                        funcs.append(f"{recv}{m.group(2)}:{n}")
                if funcs:
                    flag = "" if ok else " (sha256 differs from graph)"
                    out.append(f"- `{f['path']}`{flag}: " + ", ".join(funcs))
            elif f["language"].startswith(("typescript", "javascript")) and (f["exports"] or f["functions"]):
                names = list(dict.fromkeys([*f["exports"], *f["functions"]]))[:40]
                out.append(f"- `{f['path']}`: " + ", ".join(str(n) for n in names))
        out.append("")
    print("\n".join(out))


if __name__ == "__main__":
    main(sys.argv[1])
