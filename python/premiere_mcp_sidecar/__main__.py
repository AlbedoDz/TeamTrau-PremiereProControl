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

from . import captions, check, io


def run_captions(payload: dict) -> dict:
    return captions.render(payload)


def run_check(payload: dict) -> dict:
    return check.run()


COMMANDS = {
    "captions": run_captions,
    "check": run_check,
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
