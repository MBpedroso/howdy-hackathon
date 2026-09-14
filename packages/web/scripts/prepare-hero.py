"""Prepare the intro's hero artwork: the four mascots, dissolved into the page.

The supplied art is a fully opaque 1536x1024 poster on a pure black ground. Two
problems with dropping that straight onto the start screen, both visual:

 1. On the near-black page (`--void`, #07080c) the ground is *nearly* the background
    but not exactly, so the image reads as a rectangle floating on the page — the one
    thing the brief asked it not to do ("part of the game title screen, not an image
    inserted into a webpage"). It got worse, not better, when the art was enlarged to
    be the hero: a bigger rectangle has more edge.
 2. 1.8 MB is paid on the click that boots the game, before anything is playable.

So the edges get an alpha falloff and the whole thing is resized and re-encoded.
Output lands in `public/intro/crew.png`.

## Why the falloff is keyed on brightness as well as on distance

A plain geometric feather has to choose between two failures. Narrow (0.07) and the
ground's edge is still a visible rectangle. Wide (0.14+) and it reaches inside the
art: the first attempt greyed the top mascot's white head, which reads as a rendering
bug rather than as a blend.

There is no width that avoids both, because the characters reach much closer to the
frame than they look. So the ramp is combined with a brightness gate — anything that
is not the black ground stays fully opaque, whatever its distance from the edge — and
the feather is then free to be wide enough to actually dissolve the ground. Which is
sound because the ground is pure black and the page is #07080c: once its edge is
gone, nobody can tell where the art ends.

    python3 scripts/prepare-hero.py <source.png>
"""
import pathlib
import sys

from PIL import Image, ImageChops

WIDTH = 1200
# Fraction of each edge spent fading the *ground* to transparent. Generous on
# purpose: the brightness gate below is what protects the characters, so this number
# no longer has to be a compromise between a seam and a grey mascot.
FEATHER = 0.22
# The ground is (0, 0, 0) and the darkest thing in the art that must survive is well
# above this. Between the two the gate ramps, so there is no hard cut around a
# character that touches the frame.
DARK = 22
LIGHT = 64

src = sys.argv[1] if len(sys.argv) > 1 else None
if src is None:
    raise SystemExit('usage: prepare-hero.py <source.png>')

dst = pathlib.Path(__file__).resolve().parent.parent / 'public' / 'intro' / 'crew.png'

im = Image.open(src).convert('RGBA')
w, h = im.size
im = im.resize((WIDTH, round(h * WIDTH / w)), Image.LANCZOS)
w, h = im.size


def smoothstep(t: float) -> float:
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def ramp(n: int, span: int) -> list[float]:
    """1.0 across the middle, smoothstepped to 0.0 over `span` px at each end."""
    return [smoothstep(min(i, n - 1 - i) / span) for i in range(n)]


rx = ramp(w, max(1, round(w * FEATHER)))
ry = ramp(h, max(1, round(h * FEATHER)))
geometric = Image.new('L', (w, h))
geometric.putdata([round(255 * rx[x] * ry[y]) for y in range(h) for x in range(w)])

# The gate: brightest channel, so a saturated red glove counts as art and not as
# ground. `lighter` keeps whichever of the two masks says "opaque".
r, g, b, _ = im.split()
brightest = ImageChops.lighter(ImageChops.lighter(r, g), b)
gate = brightest.point([round(255 * smoothstep((v - DARK) / (LIGHT - DARK))) for v in range(256)])

im.putalpha(ImageChops.lighter(geometric, gate))
im.save(dst, optimize=True)
print(f'{dst}: {w}x{h}, {dst.stat().st_size // 1024} KB')
