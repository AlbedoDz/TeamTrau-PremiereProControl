"""Behaviour of the caption renderer: a ProRes 4444 file with real alpha.

Frame times below are picked from the group/word times of the spec under test,
so each assertion looks at the moment it describes (a word just starting, a
style animation already back at rest, the start or middle of a group).
"""
import json
import shutil
import subprocess

import pytest
from PIL import Image, ImageDraw, ImageFont

from premiere_mcp_sidecar import captions

FONT_PATH = captions.font_path()
FONT_SIZE = captions.font_size_for(1920)
HIGHLIGHT = (0xFF, 0xD4, 0x00)

TWO_GROUPS = [
    {
        "start": 0.0,
        "end": 0.8,
        "text": "Chào mừng các bạn",
        "words": [
            {"w": "Chào", "start": 0.0, "end": 0.25},
            {"w": "mừng", "start": 0.25, "end": 0.5},
            {"w": "các", "start": 0.5, "end": 0.65},
            {"w": "bạn", "start": 0.65, "end": 0.8},
        ],
    },
    {
        "start": 0.8,
        "end": 1.6,
        "text": "Trưng Trắc, Đinh, Lý, Trần",
        "words": [
            {"w": "Trưng", "start": 0.8, "end": 1.0},
            {"w": "Trắc,", "start": 1.0, "end": 1.2},
            {"w": "Đinh,", "start": 1.2, "end": 1.4},
            {"w": "Lý,", "start": 1.4, "end": 1.55},
            {"w": "Trần", "start": 1.55, "end": 1.6},
        ],
    },
]


def make_spec(tmp_path, groups, **overrides):
    spec = {
        "groups": groups,
        "style": "clean",
        "width": 1080,
        "height": 1920,
        "fps": 25,
        "duration": max(group["end"] for group in groups) + 0.4,
        "outPath": str(tmp_path / "captions.mov"),
        "safeArea": {"top": 0.10, "bottom": 0.15, "side": 0.06},
    }
    spec.update(overrides)
    return spec


def probe(path):
    if not shutil.which("ffprobe"):
        pytest.skip("ffprobe is not on PATH")
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-count_frames", "-show_entries",
            "stream=codec_name,pix_fmt,nb_read_frames,width,height", "-of", "json", str(path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(out.stdout)["streams"][0]


def render_frame(tmp_path, groups, frame, style="clean"):
    """Render the file at 25 fps and grab the `frame`-th picture back as RGBA."""
    spec = make_spec(tmp_path, groups, style=style)
    result = captions.render(spec)
    assert result == {"path": spec["outPath"], "frames": int(round(spec["duration"] * spec["fps"]))}
    png = tmp_path / f"frame-{frame}.png"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", spec["outPath"],
         "-vf", f"select=eq(n\\,{frame})", "-vsync", "0", "-frames:v", "1", str(png)],
        check=True,
    )
    return Image.open(png).convert("RGBA")


def alpha_box(image):
    """Bounding box of the pixels that are not fully transparent, or None."""
    return image.getbbox()


def active_word_pixels(image, get):
    """Pixels matching `get()`, as the box they span (width, height, top, bottom)."""
    pixels = image.load()
    found = [
        (x, y)
        for x in range(image.width)
        for y in range(image.height)
        if get(pixels[x, y])
    ]
    if not found:
        return None
    xs = [x for x, _ in found]
    ys = [y for _, y in found]
    return {"width": max(xs) - min(xs) + 1, "height": max(ys) - min(ys) + 1, "top": min(ys), "bottom": max(ys)}


def text_mask(text, size=FONT_SIZE):
    """Mask of `text` drawn alone, so a frame can be matched against a case/colour.

    Measurements compare *ink* boxes, which is what a frame's pixels show (a space
    has no ink), and the ink is taken from ``textbbox`` because ``getbbox`` would
    add a trailing space's advance.
    """
    font = ImageFont.truetype(FONT_PATH, size)
    left, top, right, bottom = ImageDraw.Draw(Image.new("L", (1, 1))).textbbox((0, 0), text, font=font)
    mask = Image.new("L", (right - left + 2, bottom - top + 2), 0)
    ImageDraw.Draw(mask).text((1 - left, 1 - top), text, font=font, fill=255)
    return mask


def active_word_pixels(image, get):
    """Pixels of the colour `get()` returns, as (width, top row, bottom row)."""
    pixels = image.load()
    found = [
        (x, y)
        for x in range(image.width)
        for y in range(image.height)
        if get(pixels[x, y])
    ]
    if not found:
        return None
    xs = [x for x, _ in found]
    ys = [y for _, y in found]
    return {"width": max(xs) - min(xs) + 1, "height": max(ys) - min(ys) + 1, "top": min(ys), "bottom": max(ys)}


def highlighted(image):
    """The pixels drawn in the `#FFD400` active-word colour (±8 per channel)."""

    def is_highlight(rgba):
        return rgba[3] >= 128 and all(abs(c - t) <= 8 for c, t in zip(rgba[:3], HIGHLIGHT))

    return active_word_pixels(image, is_highlight)


def test_render_has_alpha_and_frame_count(tmp_path):
    spec = make_spec(tmp_path, TWO_GROUPS, fps=25, duration=2.0)
    result = captions.render(spec)

    assert result["path"] == spec["outPath"]
    assert result["frames"] == 50
    assert (tmp_path / "captions.mov").exists()
    stream = probe(spec["outPath"])
    # The encoder is fed yuva444p10le and ffmpeg 8.1 reports the written file as
    # yuva444p12le; what matters here is ProRes 4444 with an alpha plane.
    assert stream["pix_fmt"].startswith("yuva444p")
    assert stream["codec_name"] == "prores"
    assert int(stream["nb_read_frames"]) == 50


def test_vietnamese_glyphs_render():
    font = ImageFont.truetype(FONT_PATH, FONT_SIZE)
    for char in "Trưng Trắc Đinh".replace(" ", ""):
        assert font.getmask(char).getbbox() is not None, f"font has no glyph for {char!r}"


def test_text_inside_safe_area(tmp_path):
    image = render_frame(tmp_path, TWO_GROUPS, frame=10)
    left, top, right, bottom = alpha_box(image)
    assert left >= 64.8 and right <= 1015.2, f"x range {left}..{right} escapes the side safe area"
    assert top >= 192 and bottom <= 1632, f"y range {top}..{bottom} escapes the vertical safe area"


def test_active_word_color_clean(tmp_path):
    group = TWO_GROUPS[0]
    word = group["words"][1]
    middle = (word["start"] + word["end"]) / 2
    image = render_frame(tmp_path, TWO_GROUPS, frame=int(round(middle * 25)))

    assert highlighted(image) is not None, "no #FFD400 pixels on the spoken word"


def test_pop_uppercases_and_scales_active_word(tmp_path):
    groups = [
        {
            "start": 0.0,
            "end": 1.0,
            "text": "chào mừng các bạn",
            "words": [
                {"w": "chào", "start": 0.0, "end": 0.4},
                {"w": "mừng", "start": 0.4, "end": 0.65},
                {"w": "các", "start": 0.65, "end": 0.85},
                {"w": "bạn", "start": 0.85, "end": 1.0},
            ],
        }
    ]
    word = groups[0]["words"][1]
    peak = render_frame(tmp_path, groups, frame=int(round((word["start"] + 0.06) * 25)), style="pop")
    rest = render_frame(tmp_path, groups, frame=int(round((word["start"] + 0.12) * 25)), style="pop")

    popped = highlighted(peak)
    settled = highlighted(rest)
    assert popped is not None and settled is not None
    assert popped["width"] > settled["width"], f"{popped} should be wider than {settled}"
    assert popped["height"] > settled["height"], f"{popped} should be taller than {settled}"

    # The group is written in lower case, so a coloured word this wide means the pop
    # style drew it in capitals: upper-case ink is ~15% wider, and the baseline-anchored
    # cap keeps it just as tall at rest (sub-pixel sizing costs a pixel off each side).
    upper = text_mask("MỪNG")
    lower = text_mask("mừng")
    assert settled["width"] >= upper.width - 10, f"the active word is not CHỮ HOA ({settled} vs {upper.size})"
    assert settled["width"] > lower.width + 8, "the word looks lower case"
    assert settled["height"] >= upper.height - 4, "the active word is not drawn in capitals"


def test_karaoke_shows_whole_group_from_start(tmp_path):
    group = TWO_GROUPS[1]
    first, second = group["words"][0], group["words"][1]

    # Every word of the group is on screen at its first frame, not revealed word by word.
    start = render_frame(tmp_path, TWO_GROUPS, frame=int(round(group["start"] * 25)), style="karaoke")
    box = alpha_box(start)
    font = ImageFont.truetype(FONT_PATH, FONT_SIZE)
    assert box is not None and box[2] - box[0] >= font.getlength(group["text"]) - 2, (
        "only part of the group is visible at group start"
    )

    before = render_frame(tmp_path, TWO_GROUPS, frame=int(round(0.82 * 25)), style="karaoke")
    coloured = highlighted(before)
    assert coloured is not None, "the first word should be coloured while it is spoken"
    # The coloured run is the slot of the first word (advance + space), so it is the
    # first word's ink plus the space that leads to the next one. The second word
    # ("Trắc,") sits lower, because its comma descends, so its box is the taller one.
    assert abs(coloured["width"] - text_mask(first["w"]).width) <= 12, "the second word changed colour too early"
    assert coloured["height"] <= text_mask(first["w"]).height + 2, "the second word is already coloured"

    middle = (second["start"] + second["end"]) / 2
    after = render_frame(tmp_path, TWO_GROUPS, frame=int(round(middle * 25)), style="karaoke")
    coloured = highlighted(after)
    assert coloured is not None, "the second word never changed colour"
    assert abs(coloured["width"] - text_mask(second["w"]).width) <= 12, (
        f"the coloured run {coloured} looks like the wrong word"
    )
