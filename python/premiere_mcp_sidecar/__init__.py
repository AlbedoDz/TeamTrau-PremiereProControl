"""Python sidecar for the Premiere Pro MCP server.

Heavy media work that Premiere's scripting surface cannot do lives here: ASR,
face detection, caption rendering. The TypeScript server runs it as
``python -m premiere_mcp_sidecar <command> --input in.json --output out.json``
and reads the JSON result back.
"""

__version__ = "1.4.0"
