"""Prepare the intro's hero artwork: the four mascots, feathered into the page.

The supplied art is a fully opaque 1536x1024 poster on a dark radial vignette. Two
problems with dropping that straight onto the start screen, both visual:

 1. On the near-black page (`--void`, #07080c) the vignette's edges are *nearly* the
    background but not exactly, so the image reads as a rectangle floating on the
    page — the one thing the brief asked it not to do ("integrated into the
    composition rather than simply placed inside a card").
 2. 1.8 MB is paid on the click that boots the game, before anything is playable.

So the edges get a smooth alpha falloff — the vignette dissolves into whatever is
behind it, which lets the characters overlap the UI without a visible seam — and the
whole thing is resized and re-encoded. Output lands in `public/intro/crew.png`.

    python3 scripts/prepare-hero.py <source.png>
"""
import pathlib
import sys

from PIL import Image

WIDTH = 1200
# Fraction of each edge spent fading to transparent. 0.07: the poster's characters
# reach much closer to the frame than they look — at 0.14 the fade greyed the top
# mascot's white head, which reads as a rendering bug rather than as a blend.
FEATHER = 0.07

src = sys.argv[1] if len(sys.argv) > 1 else None
if src is None:
    raise SystemExit('usage: prepare-hero.py <source.png>')

dst = pathlib.Path(__file__).resolve().parent.parent / 'public' / 'intro' / 'crew.png'

im = Image.open(src).convert('RGBA')
w, h = im.size
im = im.resize((WIDTH, round(h * WIDTH / w)), Image.LANCZOS)
w, h = im.size


def ramp(n: int, span: int) -> list[float]:
    """1.0 across the middle, smoothstepped to 0.0 over `span` px at each end."""
    out = []
    for i in range(n):
        d = min(i, n - 1 - i)
        t = 1.0 if d >= span else d / span
        out.append(t * t * (3 - 2 * t))  # smoothstep, so there is no visible seam
    return out


rx = ramp(w, max(1, round(w * FEATHER)))
ry = ramp(h, max(1, round(h * FEATHER)))
alpha = Image.new('L', (w, h))
alpha.putdata([round(255 * rx[x] * ry[y]) for y in range(h) for x in range(w)])

im.putalpha(alpha)
im.save(dst, optimize=True)
print(f'{dst}: {w}x{h}, {dst.stat().st_size // 1024} KB')
