"""Crop the four mascots to head-and-gloves, square, transparent.

The legs are two thin strokes: scanning rows from the top, the count of opaque
pixels stays high through the ball and the gloves and then collapses. Cut at the
collapse, take the alpha bounding box of what is left, and pad to a square so the
face sits centred — which is what a canvas `drawImage` into a circular boss will
want later.
"""
import pathlib
import sys

from PIL import Image

# The originals live outside the repo (they are full-body brand art, and only the
# crops ship). Point SRC at wherever they are: `python3 crop-fighters.py ~/Downloads`.
SRC = sys.argv[1] if len(sys.argv) > 1 else '.'
DST = str(pathlib.Path(__file__).resolve().parent.parent / 'public' / 'fighters')
NAMES = ['earth', 'jupiter', 'neptune', 'saturn']
SIZE = 512

for name in NAMES:
    im = Image.open(f'{SRC}/{name}.png').convert('RGBA')
    a = im.split()[3]
    w, h = im.size
    px = a.load()
    rows = [sum(1 for x in range(w) if px[x, y] > 24) for y in range(h)]
    peak = max(rows)
    # Walk down from the widest row; the first row under 18% of peak that stays
    # under it for 40 px is where the body ends and the legs begin.
    top = rows.index(peak)
    cut = h
    for y in range(top, h - 40):
        if rows[y] < peak * 0.18 and all(rows[y2] < peak * 0.30 for y2 in range(y, y + 40)):
            cut = y
            break
    body = im.crop((0, 0, w, cut))
    box = body.split()[3].getbbox()
    body = body.crop(box)
    bw, bh = body.size
    side = max(bw, bh)
    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    square.paste(body, ((side - bw) // 2, (side - bh) // 2))
    square = square.resize((SIZE, SIZE), Image.LANCZOS)
    square.save(f'{DST}/{name}.png', optimize=True)
    print(f'{name}: cut at {cut}/{h}, body {bw}x{bh} -> {SIZE}x{SIZE}')


def ball_geometry(path):
    """Where the mascot's ball is inside a crop, normalised to the square.

    The renderer draws the face inside the entity's collision circle, so it needs
    the ball's centre and radius — not the image's. Centring the image instead put
    Jupiter's ball left of the boss's circle and cropped Saturn's face at the chin.

    Found as the largest circle that fits inside the opaque mask: a two-pass
    chamfer distance transform, whose maximum is the ball's centre and whose value
    there is the ball's radius. The gloves and arms are part of the same mask but
    are far thinner, so they never win.
    """
    import numpy as np

    im = Image.open(path).convert('RGBA')
    a = np.asarray(im.split()[3], dtype=np.float32) > 24
    h, w = a.shape
    big = float(h + w)
    d = np.where(a, big, 0.0)
    # Forward pass, then backward: 4-neighbour chamfer is enough for a blob this round.
    for y in range(h):
        for x in range(w):
            if not a[y, x]:
                continue
            best = d[y, x]
            if y > 0:
                best = min(best, d[y - 1, x] + 1)
            if x > 0:
                best = min(best, d[y, x - 1] + 1)
            d[y, x] = best
    for y in range(h - 1, -1, -1):
        for x in range(w - 1, -1, -1):
            if not a[y, x]:
                continue
            best = d[y, x]
            if y < h - 1:
                best = min(best, d[y + 1, x] + 1)
            if x < w - 1:
                best = min(best, d[y, x + 1] + 1)
            d[y, x] = best
    cy, cx = np.unravel_index(int(d.argmax()), d.shape)
    r = float(d[cy, cx])
    return cx / w, cy / h, r / w


if __name__ == '__main__' and '--geometry' in sys.argv:
    for name in NAMES:
        cx, cy, r = ball_geometry(f'{DST}/{name}.png')
        print(f"  {name}: {{ cx: {cx:.3f}, cy: {cy:.3f}, r: {r:.3f} }},")
