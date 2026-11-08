#!/usr/bin/env python3
"""Flattens the three.js example modules into one folder for the web build.

`three/examples/jsm/**` import each other with relative paths ("../utils/X.js")
and bare specifiers ("three", "fflate"). A browser served from the app's strict
CSP cannot resolve those from a flat folder, so this script copies each
transitively referenced module next to the others and rewrites the specifiers.

Usage: flatten_webgl_vendor.py <output-dir> <three-examples-dir>
"""
import pathlib
import re
import shutil
import sys

BARE = [
    (re.compile(r"from ['\"]three['\"]"), "from './three.module.min.js'"),
    (re.compile(r"from ['\"]fflate['\"]"), "from './fflate.module.js'"),
]
RELATIVE = re.compile(r"from ['\"]\.\./([A-Za-z0-9_./-]+\.js)['\"]")


def rewrite(path: pathlib.Path, examples: pathlib.Path, out: pathlib.Path) -> bool:
    text = path.read_text()
    changed = False

    for pattern, replacement in BARE:
        new = pattern.sub(replacement, text)
        if new != text:
            text, changed = new, True

    for match in list(RELATIVE.finditer(text)):
        relative = match.group(1)
        source = examples / relative
        if not source.exists():
            continue
        destination = out / pathlib.Path(relative).name
        if not destination.exists():
            shutil.copy2(source, destination)
        text = text.replace(match.group(0), "from './%s'" % pathlib.Path(relative).name)
        changed = True

    if changed:
        path.write_text(text)
    return changed


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    out = pathlib.Path(sys.argv[1])
    examples = pathlib.Path(sys.argv[2])

    for _ in range(10):
        if not any(rewrite(path, examples, out) for path in list(out.glob("*.js"))):
            break

    remaining = sorted({
        m.group(0)
        for path in out.glob("*.js")
        for m in RELATIVE.finditer(path.read_text())
    })
    print("module graph flattened:", len(list(out.glob("*.js"))), "files")
    if remaining:
        print("unresolved imports:", ", ".join(remaining))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
