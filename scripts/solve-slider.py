#!/usr/bin/env python3
"""Solve a NetEase Yidun sliding-puzzle CAPTCHA.

Given the background image (with the gap) and the puzzle-piece PNG, detect the
horizontal offset (in natural background pixels) the piece must travel to fill
the gap. Uses edge-based template matching restricted to the piece's own
vertical band to avoid matching decoy outlines.

Usage: solve-slider.py <bg_image> <piece_image>
Prints a JSON object with slide_natural, gap_x_natural, piece_x0, score, bg_w, bg_h.
"""
import sys
import json
import cv2
import numpy as np


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: solve-slider.py <bg> <piece>"}))
        return 2

    bg = cv2.imread(sys.argv[1])
    piece_rgba = cv2.imread(sys.argv[2], cv2.IMREAD_UNCHANGED)
    if bg is None or piece_rgba is None:
        print(json.dumps({"error": "failed to read images"}))
        return 2

    if piece_rgba.ndim == 3 and piece_rgba.shape[2] == 4:
        alpha = piece_rgba[:, :, 3]
    else:
        alpha = cv2.cvtColor(piece_rgba, cv2.COLOR_BGR2GRAY)

    ys, xs = np.where(alpha > 20)
    if len(xs) == 0:
        print(json.dumps({"error": "empty piece alpha"}))
        return 2
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())

    piece_bgr = piece_rgba[y0:y1 + 1, x0:x1 + 1, :3]
    piece_edges = cv2.Canny(piece_bgr, 80, 200)
    bg_edges = cv2.Canny(bg, 80, 200)

    res = cv2.matchTemplate(bg_edges, piece_edges, cv2.TM_CCOEFF_NORMED)

    # The gap is at the same vertical position as the piece; restrict the
    # search to a band around y0 so decoy outlines elsewhere are ignored.
    band = 12
    r0 = max(0, y0 - band)
    r1 = min(res.shape[0], y0 + band + 1)
    sub = res[r0:r1, :].copy()
    # Ignore matches at/left of the piece's start (avoid matching itself).
    sub[:, :x0 + 8] = -1
    _, max_val, _, max_loc = cv2.minMaxLoc(sub)
    gap_x = int(max_loc[0])

    print(json.dumps({
        "slide_natural": gap_x - x0,
        "gap_x_natural": gap_x,
        "piece_x0": x0,
        "piece_w": x1 - x0 + 1,
        "score": round(float(max_val), 3),
        "bg_w": int(bg.shape[1]),
        "bg_h": int(bg.shape[0]),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
