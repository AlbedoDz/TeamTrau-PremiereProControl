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
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from . import io

STYLES = ("clean", "pop", "karaoke")

# Caption face at a 1920 px tall frame, in pixels. A group inside the rules (up to
# three words / eighteen characters) measures ~500 px at this size against the
# 950 px between the side margins, so it stays on one row; at 72 px a name triple
# like "Trưng Trắc, Đinh," would wrap. (Measured, see the task report.)
FONT_SIZE_AT_1920 = 44
FONT_NAME = "BeVietnamPro-Bold.ttf"
TEXT_COLOR = (255, 255, 255, 255)
STROKE_COLOR = (0, 0, 0, 255)
STROKE_WIDTH = 6
ACTIVE_COLOR = (0xFF, 0xD4, 0x00, 255)

SAFE_TOP = 0.10
SAFE_BOTTOM = 0.15
SAFE_SIDE = 0.06
BOTTOM_GAP = 40

POP_PEAK = 1.15
POP_MS = 120

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


def _group_at(groups: list[dict], t: float) -> dict | None:
    """The visible group at ``t``: its own span first, else the nearest one."""
    for group in groups:
        if group["start"] <= t < group["end"]:
            return group
    before = [g for g in groups if g["end"] <= t]
    if before:
        return before[-1]
    after = [g for g in groups if g["start"] > t]
    return after[0] if after else None


def _pieces(group: dict, style: str) -> list[str]:
    pieces = group["text"].split()
    if style == "pop":
        return [piece.upper() for piece in pieces]
    return pieces


def _layout(font: ImageFont.FreeTypeFont, pieces: list[str], max_width: int) -> list[list[str]]:
    """Greedy wrap: a line never exceeds ``max_width`` unless a single word does."""
    lines: list[list[str]] = []
    current: list[str] = []
    for piece in pieces:
        candidate = " ".join([*current, piece])
        if current and font.getlength(candidate) > max_width:
            lines.append(current)
            current = [piece]
        else:
            current.append(piece)
    if current:
        lines.append(current)
    return lines


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
    """Centre the wrapped group horizontally and sit its last line on the safe line."""
    lines = _layout(font, pieces, int(width * (1 - 2 * safe["side"])))
    line_height = _line_height(font)
    # The block's top edge is held below the safe line, so a caption never reaches
    # into the safe area even when the face is bigger than the plan assumed.
    top_limit = int(height * safe["top"])
    bottom_y = max(int(height * (1 - safe["bottom"])) - BOTTOM_GAP, top_limit + line_height * len(lines))
    top_y = bottom_y - line_height * len(lines)

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
        for piece in line:
            # Both variants are drawn on the same baseline so every letter of the
            # group stays on one line, whatever its box height.
            if index == active:
                active_draw.text(
                    (x, top_y + row * line_height + _baseline(active_font)), piece,
                    font=active_font, fill=ACTIVE_COLOR, anchor="ls",
                    stroke_width=STROKE_WIDTH, stroke_fill=STROKE_COLOR,
                )
            else:
                overlay_draw.text(
                    (x, top_y + row * line_height + _baseline(font)), piece,
                    font=font, fill=TEXT_COLOR, anchor="ls",
                    stroke_width=STROKE_WIDTH, stroke_fill=STROKE_COLOR,
                )
            # Step the way the line was measured; the last word has nothing to step to.
            x += font.getlength(piece + " ") if piece is not line[-1] else font.getlength(piece)
            index += 1

    image.alpha_composite(overlay)
    image.alpha_composite(active_layer)


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
    try:
        for number in range(frame_count):
            # Sample the middle of the frame's span, so a word boundary that lands
            # exactly on a frame time resolves to the frame that follows it.
            t = (number + 0.5) / fps
            frame = Image.new("RGBA", (width, height), (0, 0, 0, 0))
            group = _group_at(groups, t)
            if group is not None:
                active = _active_index(group, t)
                scale = 1.0
                if style == "pop" and active is not None:
                    scale = _pop_scale(t - group["words"][active]["start"])
                _draw(frame, font, _pieces(group, style), active, scale, width, height, safe)
            frame.save(scratch / f"{number:06d}.png")
            if number % 25 == 0:
                io.write_progress(progress_path, number / frame_count, None)

        run = subprocess.run(
            [
                "ffmpeg", "-nostdin", "-v", "error", "-y",
                "-framerate", f"{fps:g}",
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
