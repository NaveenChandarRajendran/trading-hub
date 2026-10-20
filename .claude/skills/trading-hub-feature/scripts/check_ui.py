#!/usr/bin/env python3
"""Flag design-system breaks in Trading Hub frontend code.

Usage:  python check_ui.py <frontend/src> [--only file1 file2 ...]

Checks (outside shared/tokens.css):
  - hard-coded colors (#hex, rgb()/rgba()/hsl()) in .css/.tsx/.ts
  - inline style props that set color/background/border colors or font sizes in .tsx
  - font-size values in CSS that are not var(--fs-*)
  - new Intl.NumberFormat in app code (use the shared inr() helper)
Exit code 1 if anything is found, so it can gate a commit.
"""
import re
import sys
from pathlib import Path

COLOR = re.compile(r"#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(")
INLINE_STYLE = re.compile(r"style=\{\{[^}]*\b(color|background|backgroundColor|borderColor|fontSize)\s*:", re.S)
FONT_SIZE = re.compile(r"font-size\s*:\s*(?!\s|var\(--fs-|inherit)[^;]+;")
NUMFMT = re.compile(r"new Intl\.NumberFormat")
ALLOW = {"tokens.css"}


def scan(path: Path):
    text = path.read_text(encoding="utf-8", errors="ignore")
    issues = []
    for i, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith(("//", "/*", "*")):
            continue
        if COLOR.search(line):
            issues.append((i, "hard-coded color; use a token from tokens.css", stripped))
        if path.suffix == ".css" and FONT_SIZE.search(line):
            issues.append((i, "font-size outside the --fs-* scale", stripped))
        if path.suffix in (".ts", ".tsx") and NUMFMT.search(line) and "shared" not in path.parts:
            issues.append((i, "own number formatter; use inr() from src/shared", stripped))
    if path.suffix == ".tsx":
        for m in INLINE_STYLE.finditer(text):
            line_no = text.count("\n", 0, m.start()) + 1
            issues.append((line_no, f"inline style sets {m.group(1)}; use a class", m.group(0)[:80]))
    return issues


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    root = Path(sys.argv[1])
    if "--only" in sys.argv:
        files = [Path(p) for p in sys.argv[sys.argv.index("--only") + 1:]]
    else:
        files = [p for p in root.rglob("*") if p.suffix in (".css", ".tsx", ".ts") and "node_modules" not in p.parts]
    total = 0
    for f in sorted(files):
        if f.name in ALLOW or f.name.endswith((".test.ts", ".d.ts")) or "__fixtures__" in f.parts:
            continue
        for line_no, msg, snippet in scan(f):
            total += 1
            print(f"{f}:{line_no}: {msg}\n    {snippet[:120]}")
    print(f"\n{total} issue(s)" if total else "No design-system issues found.")
    sys.exit(1 if total else 0)


if __name__ == "__main__":
    main()
