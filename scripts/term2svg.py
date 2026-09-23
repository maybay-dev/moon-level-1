#!/usr/bin/env python3
"""Render terminal text into a faithful SVG 'screenshot'.

Renders verbatim terminal output with dark background, syntax-colored prompts,
and proper alignment — suitable for embedding in a README as evidence.

Usage: term2svg.py "Title line"  (reads body from argv[2] or stdin)
"""
import html
import re
import sys

THEME = {
    "bg": "#0d1117",
    "titlebar": "#161b22",
    "border": "#30363d",
    "text": "#c9d1d9",
    "dim": "#8b949e",
    "green": "#3fb950",
    "yellow": "#d29922",
    "accent": "#58a6ff",
    "red": "#f85149",
}

LINE_H = 21
PAD = 18
FONT = 13


def colorize(line: str) -> str:
    """Return HTML for a terminal line with minimal, tasteful coloring."""
    e = html.escape(line)

    # Command lines (start with $ ...)
    if line.startswith("$ "):
        return f'<tspan fill="{THEME["accent"]}">$</tspan> <tspan fill="{THEME["text"]}">{html.escape(line[2:])}</tspan>'

    # Headers (==== or ---- rules)
    if re.match(r"^[=\-─]{8,}$", line.strip()):
        return f'<tspan fill="{THEME["border"]}">{e}</tspan>'

    # PASS/FAIL markers
    if "✓" in line:
        e = e.replace("✓", f'</tspan><tspan fill="{THEME["green"]}">✓</tspan><tspan fill="{THEME["text"]}">')
    if "●" in line:
        e = e.replace("●", f'</tspan><tspan fill="{THEME["accent"]}">●</tspan><tspan fill="{THEME["text"]}">')
    if "PASS" in line:
        e = e.replace("PASS", f'<tspan fill="{THEME["green"]}">PASS</tspan>')
    if "passed" in line and "✓" not in line:
        e = e.replace("passed", f'<tspan fill="{THEME["green"]}">passed</tspan>')
    if re.search(r"\b(0x[a-fA-F0-9]{16,}|mn_addr_\S+)", line):
        # highlight addresses/hashes
        e = re.sub(
            r"(0x[a-fA-F0-9]{16,}|mn_addr_\S+)",
            rf'<tspan fill="{THEME["yellow"]}">\1</tspan><tspan fill="{THEME["text"]}">',
            e,
        )
    return f'<tspan fill="{THEME["text"]}">{e}</tspan>'


def render(title: str, body: str) -> str:
    lines = body.rstrip("\n").split("\n")
    width = max((max(len(l) for l in lines) + 4) * 8, 780)
    height = PAD * 2 + LINE_H * (len(lines) + 2)

    rows = []
    for i, line in enumerate(lines):
        y = PAD + LINE_H * (i + 2)
        rows.append(
            f'<text x="{PAD}" y="{y}" xml:space="preserve" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="{FONT}">{colorize(line)}</text>'
        )

    rows_svg = "\n".join(rows)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <!-- Faithful render of real terminal output. Regenerate: scripts/capture_evidence.sh -->
  <rect width="{width}" height="{height}" rx="10" fill="{THEME["bg"]}" stroke="{THEME["border"]}"/>
  <rect width="{width}" height="38" rx="10" fill="{THEME["titlebar"]}"/>
  <rect y="28" width="{width}" height="10" fill="{THEME["titlebar"]}"/>
  <circle cx="18" cy="19" r="6" fill="#ff5f57"/>
  <circle cx="38" cy="19" r="6" fill="#febc2e"/>
  <circle cx="58" cy="19" r="6" fill="#28c840"/>
  <text x="{width // 2}" y="24" text-anchor="middle" font-size="12" fill="{THEME["dim"]}">{html.escape(title)}</text>
  <text x="{PAD}" y="{PAD + LINE_H * 1.4}" font-size="{FONT}" fill="{THEME["dim"]}">{html.escape("user@midnight:~/whisperpoll")}</text>
  {rows_svg}
</svg>
"""


if __name__ == "__main__":
    title = sys.argv[1] if len(sys.argv) > 1 else "terminal"
    body = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    sys.stdout.write(render(title, body))
