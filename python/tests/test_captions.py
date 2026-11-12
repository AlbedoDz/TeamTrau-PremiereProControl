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
        "safeArea": {"top": 250 / 1920, "bottom": 350 / 1920, "side": 80 / 1080},
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


def render_frame(tmp_path, groups, frame, style="clean", **overrides):
    """Render the file at 25 fps and grab the `frame`-th picture back as RGBA."""
    spec = make_spec(tmp_path, groups, style=style, **overrides)
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


def text_rows(image):
    """The text rows the frame's alpha ink occupies, top to bottom, as y spans.

    The side-safe columns that carry ink on a normal scanline are counted, so the
    few ringing pixels the codec leaves around an edge do not count as text.
    """
    alpha = image.getchannel("A")
    left, right = 65, 1015
    pitch = captions._line_height(ImageFont.truetype(FONT_PATH, FONT_SIZE))
    ink_threshold = (right - left) * 0.01
    inked = [
        y
        for y in range(alpha.height)
        if sum(1 for x in range(left, right) if alpha.getpixel((x, y)) > 128) >= ink_threshold
    ]
    if not inked:
        return []
    spans: list[list[int]] = [[inked[0], inked[0]]]
    for y in inked[1:]:
        if y == spans[-1][1] + 1:
            spans[-1][1] = y
        else:
            spans.append([y, y])
    # One line of text is one contiguous ink band; a band more than a pitch tall
    # is two lines whose tall glyph stacks meet (the line pitch is smaller than
    # the height of a Vietnamese letter with both a tone and a vowel mark).
    rows: list[tuple[int, int]] = []
    for start, end in spans:
        count = max(1, round((end - start + 1) / pitch))
        step = (end - start + 1) / count
        for index in range(count):
            rows.append((round(start + index * step), round(start + (index + 1) * step) - 1))
    return rows


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
    assert left >= 80 and right <= 1000, f"x range {left}..{right} escapes the side safe area"
    assert top >= 250 and bottom <= 1920 - 350, f"y range {top}..{bottom} escapes the vertical safe area"


def test_five_word_group_wraps_to_two_rows_inside_the_safe_area(tmp_path):
    # The brief's five-word fixture: too wide for one row at the caption size, so
    # it wraps to two balanced rows that stay inside the side and vertical margins.
    image = render_frame(tmp_path, TWO_GROUPS, frame=25)
    left, top, right, bottom = alpha_box(image)
    assert left >= 80 and right <= 1000, f"x range {left}..{right} escapes the side safe area"
    assert top >= 250 and bottom <= 1920 - 350, f"y range {top}..{bottom} escapes the vertical safe area"

    rows = text_rows(image)
    assert len(rows) == 2, f"expected two text rows, got {rows}"
    assert rows[1][0] >= rows[0][1], "the two rows overlap, so they read as one line"


def test_wrap_balances_the_lines_near_the_middle():
    # A five-word group the greedy wrap breaks after the fourth word: the balance
    # rule has to move the break back to the boundary that splits it most evenly.
    words = "chuyện anh đời chị em".split()
    font = ImageFont.truetype(FONT_PATH, FONT_SIZE)
    limit = captions.side_safe_width(1080, 80 / 1080)
    greedy = captions._greedy_lines(font, words, limit)
    assert len(greedy) == 2 and len(greedy[1]) == 1, f"the fixture should wrap greedily: {greedy}"

    lines = captions.wrap_words(font, words, limit)

    assert len(lines) == 2
    assert " ".join(lines[0]) + " " + " ".join(lines[1]) == " ".join(words), "wrapping lost or reordered words"
    ink = lambda text: font.getlength(text) + 2 * captions.STROKE_WIDTH
    alternatives = [
        abs(font.getlength(" ".join(words[:index])) - font.getlength(" ".join(words[index:])))
        for index in range(1, len(words))
        if ink(" ".join(words[:index])) <= limit and ink(" ".join(words[index:])) <= limit
    ]
    first, second = (font.getlength(" ".join(line)) for line in lines)
    assert abs(first - second) == min(alternatives), (
        f"break is not the most balanced one: {lines} ({first:.0f} vs {second:.0f})"
    )


def test_active_word_color_clean(tmp_path):
    group = TWO_GROUPS[0]
    word = group["words"][1]
    middle = (word["start"] + word["end"]) / 2
    image = render_frame(tmp_path, TWO_GROUPS, frame=int(round(middle * 25)))

    assert highlighted(image) is not None, "no #FFD400 pixels on the spoken word"


def test_active_word_follows_word_list_not_text(tmp_path):
    # `text` splits differently ("Nguyễn  Thị" has a double space, "Lý." a full
    # stop the word list does not carry), so an index into text.split() would
    # colour the wrong word.
    group = {
        "start": 0.0,
        "end": 1.2,
        "text": "Nguyễn  Thị Lý.",
        "words": [
            {"w": "Nguyễn", "start": 0.0, "end": 0.4},
            {"w": "Thị", "start": 0.4, "end": 0.8},
            {"w": "Lý", "start": 0.8, "end": 1.2},
        ],
    }
    word = group["words"][2]
    image = render_frame(tmp_path, [group], frame=int(round((word["start"] + word["end"]) / 2 * 25)))

    coloured = highlighted(image)
    assert coloured is not None, "the spoken word is not coloured"
    assert abs(coloured["width"] - text_mask(word["w"]).width) <= 12, (
        f"the coloured run {coloured} is not {word['w']!r}"
    )


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
    widest_line = max(font.getlength(word["w"]) for word in group["words"])
    assert box is not None and box[2] - box[0] >= widest_line - 2, (
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


def test_repeated_frames_reuse_drawn_pictures(tmp_path, monkeypatch):
    calls = []
    original = captions._draw

    def counting_draw(*args, **kwargs):
        calls.append(args[3])  # the active word index
        return original(*args, **kwargs)

    monkeypatch.setattr(captions, "_draw", counting_draw)
    # Two 1 s groups at 25 fps: 50 frames, but only the four distinct pictures
    # (one per active word) are drawn, because a clean frame is fully described
    # by the group's words and the active index.
    groups = [{"start": 0.0, "end": 1.0, "text": "một hai ba bốn", "words": [
        {"w": "một", "start": 0.0, "end": 0.25},
        {"w": "hai", "start": 0.25, "end": 0.5},
        {"w": "ba", "start": 0.5, "end": 0.75},
        {"w": "bốn", "start": 0.75, "end": 1.0},
    ]}]
    spec = make_spec(tmp_path, groups, duration=2.0)
    result = captions.render(spec)

    assert result["frames"] == 50
    assert len(calls) == 4, f"drew {len(calls)} pictures for 50 frames"
    stream = probe(spec["outPath"])
    assert int(stream["nb_read_frames"]) == 50


def test_pop_ramp_is_drawn_per_frame_but_the_rest_is_reused(tmp_path, monkeypatch):
    calls = []
    original = captions._draw
    monkeypatch.setattr(captions, "_draw", lambda *args, **kwargs: (calls.append(args[4]), original(*args, **kwargs))[1])

    groups = [{"start": 0.0, "end": 1.0, "text": "một hai", "words": [
        {"w": "một", "start": 0.0, "end": 0.5},
        {"w": "hai", "start": 0.5, "end": 1.0},
    ]}]
    captions.render(make_spec(tmp_path, groups, style="pop"))

    # 25 frames. Each word scales through its 120 ms ramp (the 20 and 100 ms
    # frames still ramp, the 60/140 ms frames are at 1.15 and 1.0) and is then at
    # rest, so each word needs a handful of pictures instead of 13 per word.
    assert len(calls) <= 6, f"drew {len(calls)} pictures for 25 frames"


def test_repeated_frames_fall_back_to_copy_when_links_are_refused(tmp_path, monkeypatch):
    # NTFS refuses a hardlink once a file has ~1024 links (WinError 1142), and
    # some filesystems have none at all: the frame must still be produced.
    def refuse(*_args, **_kwargs):
        raise OSError(1142, "An attempt was made to create more links on a file than the file system supports")

    monkeypatch.setattr(captions.os, "link", refuse)
    groups = [{"start": 0.0, "end": 1.0, "text": "một hai", "words": [
        {"w": "một", "start": 0.0, "end": 0.5},
        {"w": "hai", "start": 0.5, "end": 1.0},
    ]}]
    spec = make_spec(tmp_path, groups, duration=1.0)

    assert captions.render(spec)["frames"] == 25
    assert int(probe(spec["outPath"])["nb_read_frames"]) == 25


@pytest.mark.parametrize(
    "fps, rational",
    [
        (25, "25"),
        (30, "30"),
        (50, "50"),
        (60, "60"),
        (23.976, "24000/1001"),
        (29.97, "30000/1001"),
        (59.94, "60000/1001"),
        (23.98, "24000/1001"),
        (29.97002997, "30000/1001"),
        (59.94005994, "60000/1001"),
    ],
)
def test_framerate_rational(fps, rational):
    assert captions.framerate(fps) == rational


def test_bottom_line_sits_one_gap_above_the_350px_bottom_margin(tmp_path):
    # 9:16 at 1080x1920: the lowest text row ends at 1920 - 350 - gap (stroke may add a few px).
    image = render_frame(tmp_path, TWO_GROUPS, frame=10)
    _, _, _, bottom = alpha_box(image)
    gap = captions.bottom_gap_for(1920)
    assert bottom <= 1920 - 350 - gap + captions.STROKE_WIDTH * 2
    assert bottom >= 1920 - 350 - gap - 150, f"caption bottom {bottom} is far from the safe line"


# ---- looks -----------------------------------------------------------------

def _look(**changes):
    look = captions.legacy_look("clean", 1080, 1920)
    look.update(changes)
    return look


def _near(color, target, tol=12):
    return all(abs(a - b) <= tol for a, b in zip(color[:3], target)) and color[3] > 0


def _near_box(image, target):
    pixels = image.load()
    xs, ys = [], []
    for y in range(image.height):
        for x in range(image.width):
            if _near(pixels[x, y], target):
                xs.append(x)
                ys.append(y)
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1) if xs else None


def _still(look, words, active, width=1080, height=1920):
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    font = captions.caption_font(look["font"], look["sizePx"])
    captions._draw(image, font, words, active, 1.0, width, height, look)
    return image


HIGHLIGHT_LOOK = dict(
    font="BeVietnamPro-ExtraBold.ttf", accentColor="#22D3EE", active="pill",
    pill={"padXPx": 13, "padYPx": 6, "radiusPx": 16}, stroke=None,
)


@pytest.mark.parametrize("style,frame", [("clean", 3), ("pop", 1)])
def test_legacy_spec_matches_explicit_legacy_look(tmp_path, style, frame):
    from PIL import ImageChops

    plain = render_frame(tmp_path, TWO_GROUPS, frame, style=style)
    explicit = render_frame(
        tmp_path, TWO_GROUPS, frame, style=style, look=captions.legacy_look(style, 1080, 1920)
    )
    assert ImageChops.difference(plain, explicit).getbbox() is None


def test_highlight_draws_accent_pill_behind_active_word_only():
    words = ["alpha", "beta", "gamma"]
    look = _look(**HIGHLIGHT_LOOK)
    image = _still(look, words, 1)
    box = _near_box(image, (0x22, 0xD3, 0xEE))
    assert box is not None
    font = captions.caption_font(look["font"], look["sizePx"])
    line = " ".join(words)
    x0 = (1080 - font.getlength(line)) / 2 + font.getlength("alpha ")
    x1 = x0 + font.getlength("beta")
    assert box[0] <= x0 and box[2] >= x1
    next_x0 = x1 + font.getlength(" ")
    assert box[2] <= next_x0
    # The pill sits on the word's own line, with the word drawn white on top of it.
    pixels = image.load()
    ink = [
        (px, py)
        for py in range(box[1] - 40, box[3] + 40)
        for px in range(int(x0), int(x1))
        if pixels[px, py][:3] == (255, 255, 255) and pixels[px, py][3] == 255
        and box[0] <= px < box[2] and box[1] <= py < box[3]
    ]
    assert ink, "active word must be white inside the pill"
    ink_top = min(py for _, py in ink)
    ink_bottom = max(py for _, py in ink)
    assert ink_top >= box[1] and ink_bottom < box[3]
    assert ink_top <= (box[1] + box[3]) / 2 <= ink_bottom


def test_highlight_pill_stays_inside_side_margin():
    look = _look(**HIGHLIGHT_LOOK)
    image = _still(look, ["abcdefghijklmnopqr"], 0)
    box = _near_box(image, (0x22, 0xD3, 0xEE))
    assert box is not None
    assert box[0] >= 1080 * look["safeArea"]["side"] - 1


def test_minimal_has_soft_shadow_and_no_hard_stroke():
    look = _look(
        stroke=None, active="none",
        shadow={"dxPx": 4, "dyPx": 4, "blurPx": 8, "color": "#000000B3"},
    )
    image = _still(look, ["Soft", "shadow"], None)
    pixels = image.load()
    soft = hard = 0
    white = [(x, y) for y in range(image.height) for x in range(image.width) if pixels[x, y][:3] == (255, 255, 255) and pixels[x, y][3] == 255]
    assert white
    for x, y in white[::20]:
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            r, g, b, a = pixels[x + dx, y + dy]
            if a == 255 and (r, g, b) == (0, 0, 0):
                hard += 1
    soft = sum(1 for y in range(image.height) for x in range(image.width) if 1 <= pixels[x, y][3] <= 200 and pixels[x, y][:3] == (0, 0, 0))
    assert soft > 50
    assert hard == 0


def test_middle_position_centres_block_at_60_percent():
    look = _look(position="middle")
    image = _still(look, ["Middle", "of", "frame"], None)
    box = image.getbbox()
    centre = (box[1] + box[3]) / 2
    assert abs(centre - 0.60 * 1920) <= 0.02 * 1920


def test_large_look_keeps_long_word_inside_frame():
    look = _look(sizePx=104)
    image = _still(look, ["x" * 30], None)
    box = image.getbbox()
    assert box[0] >= 0 and box[2] <= 1080 and box[1] >= 0 and box[3] <= 1920


def test_caption_preview_writes_png_of_requested_size(tmp_path):
    look = _look(**HIGHLIGHT_LOOK)
    out = tmp_path / "preview.png"
    result = captions.preview({
        "look": look, "width": 540, "height": 960, "text": "one two three four",
        "maxWords": 3, "maxChars": 18, "activeIndex": 1, "outPath": str(out),
    })
    assert result == {"path": str(out), "width": 540, "height": 960}
    image = Image.open(out)
    assert image.size == (540, 960)
    rgba = image.convert("RGBA")
    assert rgba.getchannel("A").getextrema() == (255, 255)
    assert _near_box(rgba, (0x22, 0xD3, 0xEE)) is not None


# SHA-256 of the RGBA bytes drawn by the renderer at commit 0a5bf25 (before looks existed).
GOLDEN_CLEAN = "b48d5c668ae99d3e9c490d139af21427221e246c5ce3d576ce989785507c1a70"
GOLDEN_POP = "c82fc4a7dfba0973ded6879c972c3a557334ec245b10ef2d35c7d450f789f245"


@pytest.mark.parametrize("style,pieces,active,scale,golden", [
    ("clean", ["Chào", "mừng", "các", "bạn", "hôm", "nay"], 1, 1.0, GOLDEN_CLEAN),
    ("pop", ["CHÀO", "MỪNG", "CÁC", "BẠN"], 2, 1.075, GOLDEN_POP),
])
def test_legacy_look_output_is_byte_identical_to_pre_look_renderer(style, pieces, active, scale, golden):
    import hashlib

    look = captions.legacy_look(style, 1080, 1920)
    image = Image.new("RGBA", (1080, 1920), (0, 0, 0, 0))
    font = captions.caption_font(look["font"], look["sizePx"])
    captions._draw(image, font, pieces, active, scale, 1080, 1920, look)
    assert hashlib.sha256(image.tobytes()).hexdigest() == golden


def test_preview_first_group_breaks_after_punctuation_with_closing_quote():
    for text in ('say "hi." now ok', "see (this.) now ok"):
        words = captions._first_cluster(text, 5, 40)
        assert words[-1] in ('"hi."', "(this.)")
        assert len(words) == 2
