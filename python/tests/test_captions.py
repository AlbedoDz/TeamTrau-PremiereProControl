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
    assert left >= 64.8 and right <= 1015.2, f"x range {left}..{right} escapes the side safe area"
    assert top >= 192 and bottom <= 1632, f"y range {top}..{bottom} escapes the vertical safe area"


def test_five_word_group_wraps_to_two_rows_inside_the_safe_area(tmp_path):
    # The brief's five-word fixture: too wide for one row at the caption size, so
    # it wraps to two balanced rows that stay inside the side and vertical margins.
    image = render_frame(tmp_path, TWO_GROUPS, frame=25)
    left, top, right, bottom = alpha_box(image)
    assert left >= 64.8 and right <= 1015.2, f"x range {left}..{right} escapes the side safe area"
    assert top >= 192 and bottom <= 1632, f"y range {top}..{bottom} escapes the vertical safe area"

    rows = text_rows(image)
    assert len(rows) == 2, f"expected two text rows, got {rows}"
    assert rows[1][0] >= rows[0][1], "the two rows overlap, so they read as one line"


def test_wrap_balances_the_lines_near_the_middle():
    # A five-word group the greedy wrap breaks after the fourth word: the balance
    # rule has to move the break back to the boundary that splits it most evenly.
    words = "chuyện anh đời chị em".split()
    font = ImageFont.truetype(FONT_PATH, FONT_SIZE)
    limit = captions.side_safe_width(1080, 0.06)
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
