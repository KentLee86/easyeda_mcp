#!/usr/bin/env python3
"""Crop every page of an EasyEDA layer PDF to the board.

EasyEDA sizes PDF pages to the extent of all objects, so one stray primitive far
off the board (e.g. a bad pour vertex) makes every page mostly empty. All pages
share one coordinate frame, so the board is located once on the page that only
shows the outline (black on white), and that box plus a margin becomes the page
for every page. Needs poppler-utils (pdftoppm, pdfinfo) and Ghostscript.

It also checks each page's orientation against a reference page (Multi layer:
through-hole pads are on every page): EasyEDA 3.2 prints the Bottom Silkscreen
page rotated by 180 degrees even with mirroring off. Such pages are turned back
(still vector); pages that look mirrored are reported.

    dev/live/crop-pdf-to-board.py in.pdf out.pdf [--outline-page 11] [--reference-page 12] [--margin 0.04]
"""
import argparse
import re
import subprocess
import tempfile
from pathlib import Path

DPI = 36


def page_size(pdf: Path, page: int) -> tuple[float, float]:
    info = subprocess.run(["pdfinfo", "-f", str(page), "-l", str(page), str(pdf)], check=True, capture_output=True, text=True).stdout
    match = re.search(rf"Page\s+{page} size:\s+([\d.]+) x ([\d.]+) pts", info)
    return float(match.group(1)), float(match.group(2))


def ink_box(pdf: Path, page: int) -> tuple[int, int, int, int, int, int]:
    """Bounding box of non-white pixels on one page, from a grayscale PGM render."""
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["pdftoppm", "-f", str(page), "-l", str(page), "-r", str(DPI), "-gray", str(pdf), f"{tmp}/p"], check=True)
        data = next(Path(tmp).glob("p*.pgm")).read_bytes()
    header = data.split(b"\n", 3)
    width, height = (int(v) for v in header[1].split())
    pixels = header[3]
    xs, ys = [], []
    for y in range(height):
        row = pixels[y * width:(y + 1) * width]
        dark = [x for x, value in enumerate(row) if value < 200]
        if dark:
            xs += (dark[0], dark[-1])
            ys.append(y)
    if not xs:
        raise SystemExit(f"page {page} has no ink; pass --outline-page")
    return min(xs), min(ys), max(xs), max(ys), width, height


def render_gray(pdf: Path, page: int, dpi: int = 60) -> tuple[bytes, int, int]:
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["pdftoppm", "-f", str(page), "-l", str(page), "-r", str(dpi), "-gray", str(pdf), f"{tmp}/p"], check=True)
        data = next(Path(tmp).glob("p*.pgm")).read_bytes()
    header = data.split(b"\n", 3)
    width, height = (int(v) for v in header[1].split())
    return header[3], width, height


TRANSFORMS = {
    "none": lambda x, y, w, h: (x, y),
    "rotate180": lambda x, y, w, h: (w - 1 - x, h - 1 - y),
    "mirror-x": lambda x, y, w, h: (w - 1 - x, y),
    "mirror-y": lambda x, y, w, h: (x, h - 1 - y),
}


def orientation(pdf: Path, page: int, reference: tuple[bytes, int, int]) -> tuple[str, dict]:
    """Which transform of `page` best covers the reference page's ink."""
    ref, rw, rh = reference
    img, w, h = render_gray(pdf, page)
    if (w, h) != (rw, rh):
        return "none", {}
    ref_ink = [(x, y) for y in range(0, h, 2) for x in range(0, w, 2) if ref[y * w + x] < 128]
    scores = {}
    for name, transform in TRANSFORMS.items():
        hits = 0
        for x, y in ref_ink:
            tx, ty = transform(x, y, w, h)
            # Allow one pixel of rasterization offset.
            if any(img[yy * w + xx] < 128
                   for yy in range(max(0, ty - 1), min(h, ty + 2))
                   for xx in range(max(0, tx - 1), min(w, tx + 2))):
                hits += 1
        scores[name] = round(hits / max(len(ref_ink), 1), 2)
    best = max(scores, key=scores.get)
    # Only correct clear cases; pages that barely show pads stay as they are.
    if best != "none" and scores[best] >= 0.8 and scores[best] > scores["none"] + 0.2:
        return best, scores
    return "none", scores


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--outline-page", type=int, default=11, help="page that shows only the board outline (default 11)")
    parser.add_argument("--reference-page", type=int, default=12, help="page used as orientation reference (default 12, Multi layer)")
    parser.add_argument("--margin", type=float, default=0.04, help="margin as a fraction of the board size")
    args = parser.parse_args()

    page_w, page_h = page_size(args.source, args.outline_page)
    x0, y0, x1, y1, width, height = ink_box(args.source, args.outline_page)
    sx, sy = page_w / width, page_h / height
    mx, my = (x1 - x0) * sx * args.margin, (y1 - y0) * sy * args.margin
    # PDF y grows upwards; the render's y grows downwards.
    left, right = x0 * sx - mx, (x1 + 1) * sx + mx
    bottom, top = page_h - (y1 + 1) * sy - my, page_h - y0 * sy + my
    left, bottom = max(0.0, left), max(0.0, bottom)
    right, top = min(page_w, right), min(page_h, top)

    with tempfile.TemporaryDirectory() as tmp:
        marked = Path(tmp) / "cropbox.pdf"
        subprocess.run(["gs", "-q", "-o", str(marked), "-sDEVICE=pdfwrite",
                        "-c", f"[/CropBox [{left:.2f} {bottom:.2f} {right:.2f} {top:.2f}] /PAGES pdfmark",
                        "-f", str(args.source)], check=True)
        cropped = Path(tmp) / "cropped.pdf"
        subprocess.run(["gs", "-q", "-o", str(cropped), "-sDEVICE=pdfwrite", "-dUseCropBox", str(marked)], check=True)

        reference = render_gray(cropped, args.reference_page)
        pages = int(re.search(r"Pages:\s+(\d+)", subprocess.run(["pdfinfo", str(cropped)], check=True, capture_output=True, text=True).stdout).group(1))
        subprocess.run(["pdfseparate", str(cropped), f"{tmp}/page-%03d.pdf"], check=True)
        parts = []
        for number in range(1, pages + 1):
            part = Path(tmp) / f"page-{number:03d}.pdf"
            fix, scores = orientation(cropped, number, reference)
            if fix != "none":
                fixed = Path(tmp) / f"fixed-{number:03d}.pdf"
                if fix == "rotate180":
                    # Re-render the page (vector) on a device turned by 180 degrees; page
                    # /Rotate entries and BeginPage transforms do not survive pdfwrite.
                    w, h = page_size(part, 1)
                    subprocess.run(["gs", "-q", "-o", str(fixed), "-sDEVICE=pdfwrite", "-dAutoRotatePages=/None",
                                    "-dFIXEDMEDIA", f"-dDEVICEWIDTHPOINTS={w}", f"-dDEVICEHEIGHTPOINTS={h}",
                                    "-c", "<</Orientation 2>> setpagedevice", "-f", str(part)], check=True)
                else:
                    print(f"page {number}: printed {fix}; mirrored pages are reported, not changed")
                    parts.append(str(part))
                    continue
                check, _ = orientation(fixed, 1, reference)
                print(f"page {number}: printed {fix} (scores {scores}); corrected" + ("" if check == "none" else f", still {check}!"))
                part = fixed
            parts.append(str(part))
        subprocess.run(["pdfunite", *parts, str(args.target)], check=True)
    print(f"{args.target}: pages cropped to {right - left:.0f} x {top - bottom:.0f} pt "
          f"(was {page_w:.0f} x {page_h:.0f}; board found on page {args.outline_page})")


if __name__ == "__main__":
    main()
