"""Generate HiggsRead PWA icons and install screenshots from brand assets."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SRC_H = ROOT / "src" / "assets" / "higgsread-h.png"
SRC_LOGO = ROOT / "src" / "assets" / "higgsread-logo.png"
OUT = ROOT / "public"

APP = (247, 247, 245, 255)  # #F7F7F5
PLATE = (238, 236, 230, 255)  # #EEECE6
INK = (55, 53, 47, 255)
MUTED = (155, 154, 151, 255)


def is_paper(r: int, g: int, b: int) -> bool:
    """Drop near-white and cream plate fills so only ink/gold remain."""
    mx, mn = max(r, g, b), min(r, g, b)
    return mx >= 228 and (mx - mn) <= 28


def trim_near_white(im: Image.Image, threshold: int = 248) -> Image.Image:
    rgba = im.convert("RGBA")
    px = rgba.load()
    w, h = rgba.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            if r >= threshold and g >= threshold and b >= threshold:
                px[x, y] = (r, g, b, 0)
            elif is_paper(r, g, b):
                px[x, y] = (r, g, b, 0)
    bbox = rgba.getbbox()
    if not bbox:
        return rgba
    pad = 2
    left, top, right, bottom = bbox
    return rgba.crop(
        (
            max(0, left - pad),
            max(0, top - pad),
            min(w, right + pad),
            min(h, bottom + pad),
        )
    )


def fit_on_canvas(mark: Image.Image, size: int, bg: tuple[int, int, int, int], scale: float) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), bg)
    target = int(size * scale)
    ratio = mark.width / mark.height
    if ratio >= 1:
        nw, nh = target, max(1, int(target / ratio))
    else:
        nh, nw = target, max(1, int(target * ratio))
    resized = mark.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas.alpha_composite(resized, ((size - nw) // 2, (size - nh) // 2))
    return canvas


def save_png(im: Image.Image, path: Path) -> None:
    im.save(path, "PNG", optimize=True)
    print(f"wrote {path.name} {im.size} {path.stat().st_size} bytes")


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in (
        r"C:\Windows\Fonts\georgia.ttf",
        r"C:\Windows\Fonts\times.ttf",
        r"C:\Windows\Fonts\constan.ttf",
    ):
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def compose_screenshot(width: int, height: int, path: Path, logo: Image.Image) -> None:
    img = Image.new("RGBA", (width, height), APP)
    draw = ImageDraw.Draw(img)

    wash = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    wash_draw = ImageDraw.Draw(wash)
    for i in range(180):
        wash_draw.rectangle([0, i, width, i + 1], fill=(255, 255, 255, int(10 * (1 - i / 180))))
    img.alpha_composite(wash)

    if width < height:
        pw, ph = int(width * 0.78), int(height * 0.28)
    else:
        pw, ph = int(width * 0.46), int(height * 0.42)
    px = (width - pw) // 2
    py = (height - ph) // 2 - (40 if width < height else 10)

    shadow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [px + 6, py + 10, px + pw + 6, py + ph + 10],
        radius=28,
        fill=(55, 53, 47, 22),
    )
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18)))

    plate = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    plate_draw = ImageDraw.Draw(plate)
    plate_draw.rounded_rectangle([px, py, px + pw, py + ph], radius=28, fill=PLATE)
    plate_draw.rounded_rectangle(
        [px + 1, py + 1, px + pw - 1, py + ph - 1],
        radius=27,
        outline=(255, 255, 255, 180),
        width=2,
    )
    plate_draw.rounded_rectangle(
        [px, py, px + pw, py + ph],
        radius=28,
        outline=(120, 116, 108, 70),
        width=2,
    )
    img.alpha_composite(plate)

    max_logo_w = int(pw * 0.78)
    max_logo_h = int(ph * 0.48)
    ratio = logo.width / logo.height
    lw = max_logo_w
    lh = int(lw / ratio)
    if lh > max_logo_h:
        lh = max_logo_h
        lw = int(lh * ratio)
    logo_r = logo.resize((lw, lh), Image.Resampling.LANCZOS)
    img.alpha_composite(logo_r, (px + (pw - lw) // 2, py + int(ph * 0.22)))

    tag = "Read. Listen. Remember."
    font = load_font(max(28, width // 42))
    bbox = draw.textbbox((0, 0), tag, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (width - tw) // 2
    ty = py + ph + (72 if width < height else 48)
    draw.text((tx, ty), tag, font=font, fill=INK)

    sub = "Your library, always at hand."
    sfont = load_font(max(20, width // 56))
    sb = draw.textbbox((0, 0), sub, font=sfont)
    sw = sb[2] - sb[0]
    draw.text(((width - sw) // 2, ty + th + 18), sub, font=sfont, fill=MUTED)

    rgb = Image.new("RGB", img.size, APP[:3])
    rgb.paste(img, mask=img.split()[-1])
    rgb.save(path, "PNG", optimize=True)
    print(f"wrote {path.name} {rgb.size} {path.stat().st_size} bytes")


def main() -> None:
    mark = trim_near_white(Image.open(SRC_H))
    logo = trim_near_white(Image.open(SRC_LOGO), threshold=246)
    print("trimmed H", mark.size, "logo", logo.size)

    for size in (192, 512):
        save_png(fit_on_canvas(mark, size, APP, 0.78), OUT / f"icon-{size}.png")
    for size in (192, 512):
        save_png(fit_on_canvas(mark, size, PLATE, 0.62), OUT / f"icon-maskable-{size}.png")
    save_png(fit_on_canvas(mark, 96, APP, 0.78), OUT / "icon-96.png")
    save_png(fit_on_canvas(mark, 180, APP, 0.72), OUT / "apple-touch-icon.png")

    compose_screenshot(1080, 1920, OUT / "screenshot-narrow.png", logo)
    compose_screenshot(1920, 1080, OUT / "screenshot-wide.png", logo)


if __name__ == "__main__":
    main()
