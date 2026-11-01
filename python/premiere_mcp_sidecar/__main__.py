"""Command line: ``python -m premiere_mcp_sidecar <command> --input in.json --output out.json``.

The TypeScript server spawns this per job and reads the JSON at ``--output``.
Success is exit 0 with the command's own result object; any failure is a
non-zero exit with ``{"error": ...}`` at the same path, so the caller always has
something to report.
"""

from __future__ import annotations

import argparse
import sys
import traceback

from . import check, io


def run_captions(payload: dict) -> dict:
    # Imported here, not at module level: `check` has to work on a machine where
    # the render stack (Pillow) was never installed.
    from . import captions

    return captions.render(payload)


def run_check(payload: dict) -> dict:
    return check.run(payload.get("ffmpegPath"))


def run_transcribe(payload: dict) -> dict:
    # Same reason as `captions`: loading faster-whisper pulls ctranslate2 and the
    # CUDA DLLs, which `check` has to be able to report on when they are broken.
    from . import transcribe

    return transcribe.run(payload, payload.get("progressPath"))


def run_faces(payload: dict) -> dict:
    from . import faces

    return faces.run(payload, payload.get("progressPath"))


def run_download_models(payload: dict) -> dict:
    from . import download_models

    # Fix round 1: a model that fails no longer stops the run (the others still
    # arrive), so the verdict is carried out to the exit code here -- the caller
    # sees the full result *and* a non-zero exit, and can log which models failed.
    result = download_models.run(payload, payload.get("progressPath"))
    failed = download_models.failed(result)
    if failed:
        raise PartialFailure(result, failed)
    return result


class PartialFailure(Exception):
    """Some models arrived and some did not: the run's result, and a non-zero exit.

    ``main`` writes every model's entry at the top level (the shape a complete run
    has), adds ``failed`` and ``error``, and exits 1: setup both reports the models
    it has and fails the command that asked for all of them.
    """

    def __init__(self, result: dict, failed: list[str]) -> None:
        names = ", ".join(failed)
        detail = "; ".join(f"{key}: {result[key].get('error', 'failed')}" for key in failed)
        super().__init__(f"download-models failed for {names} ({detail})")
        self.payload = {**result, "failed": failed}


COMMANDS = {
    "captions": run_captions,
    "check": run_check,
    "download-models": run_download_models,
    "faces": run_faces,
    "transcribe": run_transcribe,
}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="premiere_mcp_sidecar")
    parser.add_argument("command", help=f"one of {', '.join(COMMANDS)}")
    parser.add_argument("--input", default=None, help="path of the JSON input object")
    parser.add_argument("--output", default=None, help="path to write the JSON result to")
    parser.add_argument("--progress", default=None, help="path for progress updates while running")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    handler = COMMANDS.get(args.command)
    try:
        if handler is None:
            raise ValueError(f"unknown command {args.command!r}; expected one of {', '.join(COMMANDS)}")
        payload = io.read_input(args.input)
        if args.progress:
            payload["progressPath"] = args.progress
        result = handler(payload)
    except PartialFailure as exc:
        # Some models arrived: write what did, so the caller reports every model's
        # verdict, and exit non-zero because the run was not complete.
        io.log(f"{args.command} failed: {exc}")
        if args.output:
            io.write_output(args.output, {**exc.payload, "error": str(exc)})
        return 1
    except Exception as exc:
        io.log(f"{args.command} failed: {exc}")
        traceback.print_exc(file=sys.stderr)
        if args.output:
            io.write_output(args.output, {"error": str(exc) or type(exc).__name__})
        return 1

    if args.output:
        io.write_output(args.output, result)
    else:
        io.log(str(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
