"""Burn word-timed captions into a transparent ProRes 4444 overlay.

Each frame is drawn with PIL as RGBA on a fully transparent canvas, written as a
PNG, and the numbered PNGs are encoded in one ffmpeg pass. The ProRes 4444 file
becomes a layer above the cut in Premiere, so the video underneath is untouched.

Times in the spec are seconds from 0 of the short. A group is visible from its
own ``start`` to ``end``; inside it the word whose ``start``/``end`` spans the
frame is the "active" word, and each style draws it differently:

- ``clean``   white text, 6 px black stroke, active word ``#FFD400``
- ``pop``     CHỮ HOA, active word scales 1.0 -> 1.15 -> 1.0 over 120 ms
- ``karaoke`` the whole group is drawn, the active word in ``#FFD400``

A group is drawn as one or two balanced rows: the widest group the rules allow
(three words / eighteen characters) fits a single row at 72 px, so a longer one
wraps at the word boundary nearest the middle of the group.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from . import io

STYLES = ("clean", "pop", "karaoke")

# Caption face at a 1920 px tall frame, in pixels, scaled by ``height / 1920``.
# Size is set for phone viewing: the widest group the rules allow (three words /
# eighteen characters) still comes to ~700 px against the 950 px between the side
# margins, and the brief's five-word fixture wraps to two rows.
FONT_SIZE_AT_1920 = 72
FONT_NAME = "BeVietnamPro-Bold.ttf"
TEXT_COLOR = (255, 255, 255, 255)
STROKE_COLOR = (0, 0, 0, 255)
STROKE_WIDTH = 6
ACTIVE_COLOR = (0xFF, 0xD4, 0x00, 255)

SAFE_TOP = 0.10
SAFE_BOTTOM = 0.15
SAFE_SIDE = 0.06
# Gap under the caption block at 1920 px, scaled with the frame like the type.
BOTTOM_GAP_AT_1920 = 40

POP_PEAK = 1.15
POP_MS = 120

MAX_LINES = 2
# Slack left between the caption and the side margins so the pop style's 1.15
# scale still fits inside them.
SIDE_HEADROOM = POP_PEAK

# Multiples of 1001/1000 that ffmpeg wants as a rational; ``30`` alone is 30.000.
NTSC_RATES = {24000: 23.976, 30000: 29.97, 60000: 59.94}

FONTS_DIR = Path(__file__).resolve().parent / "fonts"


def font_path(name: str = FONT_NAME) -> str:
    """Absolute path of a bundled font, so the sidecar works from any cwd."""
    return str(FONTS_DIR / name)


def caption_font(name: str | None = None, size: float = FONT_SIZE_AT_1920) -> ImageFont.FreeTypeFont:
    """The caption typeface; ``name`` may be a family name, a bundled file name or a path."""
    if name:
        candidate = Path(name)
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size)
        for option in (name, f"{name}.ttf", name.replace(" ", "") + ".ttf"):
            bundled = FONTS_DIR / option
            if bundled.is_file():
                return ImageFont.truetype(str(bundled), size)
    return ImageFont.truetype(font_path(FONT_NAME), size)


def _baseline(font: ImageFont.FreeTypeFont) -> int:
    """Distance from the top of the text box down to the baseline."""
    return -font.getbbox("H")[1]


def font_size_for(height: int) -> int:
    """Type size in pixels, tied to the frame height so a 9:16 frame wraps the same."""
    return max(1, round(int(height) * FONT_SIZE_AT_1920 / 1920))


def bottom_gap_for(height: int) -> int:
    """Gap under the caption block, scaled with the frame height."""
    return max(1, round(int(height) * BOTTOM_GAP_AT_1920 / 1920))


def framerate(fps: float) -> str:
    """ffmpeg ``-framerate`` value: a rational for NTSC rates, else the number.

    ``-framerate 29.97`` is 29.970 fps, so a 29.97 fps timeline would drift by a
    frame roughly every 55 s; ``-framerate 30000/1001`` is exact.
    """
    rate = float(fps)
    if rate <= 0:
        raise ValueError(f"fps must be positive, got {fps}")
    for base, ntsc in NTSC_RATES.items():
        # NTSC stays distinct from its integer slot (never within 1.5% of 30/60).
        if abs(rate - ntsc) < 0.01:
            return f"{base}/1001"
    return f"{rate:g}"


def side_safe_width(width: int, side: float) -> int:
    """Usable caption width: the side margins, less the stroke and the pop scale.

    The stroke is drawn half outside the advance on each side, and pop scales the
    line by 1.15 about its centre, so a line of this width still lands inside the
    side margins (a few pixels are kept back for the codec's ringing).
    """
    usable = width * (1 - 2 * side)
    return int(usable / SIDE_HEADROOM) - 2 * STROKE_WIDTH - 4


def _ink_width(font: ImageFont.FreeTypeFont, text: str) -> float:
    """Advance plus the stroke that ``getlength`` ignores, on both sides."""
    return font.getlength(text) + 2 * STROKE_WIDTH


def wrap_words(font: ImageFont.FreeTypeFont, words: list[str], max_width: int) -> list[list[str]]:
    """Wrap ``words`` into at most ``MAX_LINES`` rows, balanced round the middle.

    A row never exceeds ``max_width`` (plus its stroke) unless a single word does.
    A group that fits one row stays one row. Otherwise the break whose two rows
    are closest in width wins, so a group that has to break gets the break nearest
    the middle of the group rather than the greedy one; ``MAX_LINES`` two-row
    breaks are the only shape offered, so the block is never taller than two rows.
    """
    if not words:
        return []
    limit = max(int(max_width), int(max(_ink_width(font, word) for word in words)))
    greedy = _greedy_lines(font, words, limit)
    if len(greedy) == 1:
        return greedy

    def evenness(lines: list[list[str]]) -> float:
        return abs(font.getlength(" ".join(lines[0])) - font.getlength(" ".join(lines[1])))

    # The greedy break competes only when it is already inside the line cap.
    best_score, best_lines = float("inf"), greedy
    if len(greedy) <= MAX_LINES:
        best_score = evenness(greedy)
    for index in range(1, len(words)):
        head_words, tail_words = words[:index], words[index:]
        if _ink_width(font, " ".join(head_words)) > limit:
            continue
        if _ink_width(font, " ".join(tail_words)) > limit:
            continue
        # Balance on the drawn line widths: both rows carry the same stroke, so
        # only the advances decide how even they look. A tie keeps the earlier break.
        score = abs(font.getlength(" ".join(head_words)) - font.getlength(" ".join(tail_words)))
        if score < best_score:
            best_score, best_lines = score, [head_words, tail_words]
    return best_lines


def _greedy_lines(font: ImageFont.FreeTypeFont, words: list[str], limit: int) -> list[list[str]]:
    lines: list[list[str]] = []
    current: list[str] = []
    for word in words:
        candidate = " ".join([*current, word])
        if current and _ink_width(font, candidate) > limit:
            lines.append(current)
            current = [word]
        else:
            current.append(word)
    if current:
        lines.append(current)
    return lines


def _pop_scale(elapsed: float) -> float:
    """Scale of the active word ``elapsed`` seconds into it: up and back in 120 ms."""
    if elapsed < 0:
        return 1.0
    ramp = POP_MS / 2000
    if elapsed < ramp:
        return 1.0 + (POP_PEAK - 1.0) * (elapsed / ramp)
    if elapsed < 2 * ramp:
        return POP_PEAK - (POP_PEAK - 1.0) * ((elapsed - ramp) / ramp)
    return 1.0


def _active_index(group: dict, t: float) -> int | None:
    """Index of the word spoken at ``t``, or the nearest one when between words."""
    words = group.get("words") or []
    for index, word in enumerate(words):
        if word["start"] <= t < word["end"]:
            return index
    previous = [i for i, word in enumerate(words) if word["end"] <= t]
    if previous:
        return previous[-1]
    following = [i for i, word in enumerate(words) if word["start"] > t]
    return following[0] if following else (len(words) - 1 if words else None)


def _group_at(groups: list[dict], t: float) -> int | None:
    """Index of the visible group at ``t``: its own span first, else the nearest one."""
    for index, group in enumerate(groups):
        if group["start"] <= t < group["end"]:
            return index
    before = [i for i, group in enumerate(groups) if group["end"] <= t]
    if before:
        return before[-1]
    after = [i for i, group in enumerate(groups) if group["start"] > t]
    return after[0] if after else None


def _pieces(group: dict, style: str) -> list[str]:
    """The words to draw: ``group["words"]`` is the source of truth.

    ``text`` is only a display fallback for ``words``-less groups, so text that
    splits differently (punctuation, a collapsed space) cannot shift the active
    word onto its neighbour. The pop style renders CHỮ HOA.
    """
    words = [word["w"] for word in group.get("words") or []]
    pieces = words or group["text"].split()
    if style == "pop":
        return [piece.upper() for piece in pieces]
    return pieces


def _line_height(font: ImageFont.FreeTypeFont) -> int:
    ascent, descent = font.getmetrics()
    return ascent + descent


def _draw(
    image: Image.Image,
    font: ImageFont.FreeTypeFont,
    pieces: list[str],
    active: int | None,
    scale: float,
    width: int,
    height: int,
    safe: dict,
) -> None:
    """Centre the wrapped group horizontally and sit its bottom line on the safe line."""
    lines = wrap_words(font, pieces, side_safe_width(width, safe["side"]))
    line_height = _line_height(font)
    # The bottom line owns the safe line and the block grows upwards from it; the
    # top clamp is only a backstop for a block taller than the space it is given.
    bottom_y = int(height * (1 - safe["bottom"])) - bottom_gap_for(height)
    top_limit = int(height * safe["top"]) + STROKE_WIDTH
    top_y = max(bottom_y - line_height * len(lines), top_limit)

    # The active word is drawn on its own layer for two reasons: enlarging it must
    # not clip at the frame edge, and at pop's peak it is wider than its slot, so
    # its fill has to replace the white copy underneath rather than tint it.
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    overlay_draw = ImageDraw.Draw(overlay)
    active_layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    active_draw = ImageDraw.Draw(active_layer)
    # Exact, unrounded size: font_variant only takes integers and would quantise
    # the pop ramp (65.55 -> 66 up, then a jump on the way back down).
    active_font = caption_font(font.path, max(1.0, font.size * scale)) if active is not None else None

    index = 0
    for row, line in enumerate(lines):
        text = " ".join(line)
        x = (width - font.getlength(text)) / 2
        # One baseline per row, shared by the active and the still words, so the
        # pair sits on the same line whatever its box height.
        baseline = top_y + row * line_height + _baseline(font)
        for piece in line:
            if index == active:
                active_draw.text(
                    (x, baseline), piece,
                    font=active_font, fill=ACTIVE_COLOR, anchor="ls",
                    stroke_width=STROKE_WIDTH, stroke_fill=STROKE_COLOR,
                )
            else:
                overlay_draw.text(
                    (x, baseline), piece,
                    font=font, fill=TEXT_COLOR, anchor="ls",
                    stroke_width=STROKE_WIDTH, stroke_fill=STROKE_COLOR,
                )
            # Step the way the line was measured; the last word has nothing to step to.
            x += font.getlength(piece + " ") if piece is not line[-1] else font.getlength(piece)
            index += 1

    image.alpha_composite(overlay)
    image.alpha_composite(active_layer)


def _place(source: Path, target: Path) -> None:
    """Give ``target`` the picture at ``source``: a hardlink if possible, else a copy.

    A hardlink makes every repeated frame cost nothing; filesystems without them
    (or a denied link) fall back to copying, which is still far cheaper than
    drawing the caption again.
    """
    try:
        os.link(source, target)
    except OSError:
        shutil.copyfile(source, target)


def render(spec: dict) -> dict:
    """Render ``spec["groups"]`` to ``spec["outPath"]`` and return ``{path, frames}``."""
    groups = sorted(spec["groups"], key=lambda group: group["start"])
    style = spec.get("style", "clean")
    if style not in STYLES:
        raise ValueError(f"unknown style {style!r}; expected one of {', '.join(STYLES)}")
    width = int(spec["width"])
    height = int(spec["height"])
    fps = float(spec["fps"])
    duration = float(spec["duration"])
    if not groups and duration <= 0:
        raise ValueError("nothing to render: no groups and no duration")
    if duration <= 0:
        duration = max(group["end"] for group in groups)
    safe = {
        "top": float(spec.get("safeArea", {}).get("top", SAFE_TOP)),
        "bottom": float(spec.get("safeArea", {}).get("bottom", SAFE_BOTTOM)),
        "side": float(spec.get("safeArea", {}).get("side", SAFE_SIDE)),
    }
    font = caption_font(spec.get("font"), font_size_for(height))
    frame_count = int(round(duration * fps))
    if frame_count <= 0:
        raise ValueError(f"duration {duration} s at {fps} fps yields no frames")

    out_path = Path(spec["outPath"])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    progress_path = spec.get("progressPath")
    scratch = Path(tempfile.mkdtemp(prefix="premiere-captions-"))
    rendered: dict[tuple[int, int, float], Path] = {}
    try:
        for number in range(frame_count):
            # Sample the middle of the frame's span, so a word boundary that lands
            # exactly on a frame time resolves to the frame that follows it.
            t = (number + 0.5) / fps
            target = scratch / f"{number:06d}.png"
            group_index = _group_at(groups, t)
            group = None if group_index is None else groups[group_index]
            active = None
            scale = 1.0
            if group is not None:
                active = _active_index(group, t)
                if style == "pop" and active is not None:
                    scale = round(_pop_scale(t - group["words"][active]["start"]), 3)
            # Frames repeat: a word is on screen for 8-20 frames and only pop's
            # 120 ms ramp changes the picture, so draw each distinct picture once.
            key = (group_index, -1 if active is None else active, scale)
            if key in rendered:
                _place(rendered[key], target)
            else:
                frame = Image.new("RGBA", (width, height), (0, 0, 0, 0))
                if group is not None:
                    _draw(frame, font, _pieces(group, style), active, scale, width, height, safe)
                frame.save(target)
                rendered[key] = target
            if number % 25 == 0:
                io.write_progress(progress_path, number / frame_count, None)

        run = subprocess.run(
            [
                "ffmpeg", "-nostdin", "-v", "error", "-y",
                "-framerate", framerate(fps),
                "-i", str(scratch / "%06d.png"),
                "-c:v", "prores_ks", "-profile:v", "4",
                "-pix_fmt", "yuva444p10le", "-alpha_bits", "16",
                str(out_path),
            ],
            capture_output=True,
        )
        if run.returncode != 0:
            detail = run.stderr.decode("utf-8", "replace").strip()[-400:]
            raise RuntimeError(f"ffmpeg could not encode {out_path}: {detail or run.returncode}")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    io.write_progress(progress_path, 1.0, None)
    return {"path": str(out_path), "frames": frame_count}
