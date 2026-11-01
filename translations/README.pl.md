# Adobe Premiere Pro MCP Server

[English](../README.md)

Steruj Adobe Premiere Pro przez MCP za pomocą Codex, Claude Code, Claude Desktop lub innego klienta MCP.

## Szybki start

```bash
git clone https://github.com/AlbedoDz/TeamTrau-PremiereProControl.git
cd TeamTrau-PremiereProControl
npm run setup:mac
```

1. W Premiere Pro otwórz `Window > Extensions > TeamTrau PremiereProControl`.
2. Ustaw `Temp Directory` na `/tmp/premiere-mcp-bridge`.
3. Kliknij `Save Configuration`, `Start Bridge`, a następnie `Test Connection`.
4. Jeśli test się nie powiedzie, kliknij `Run Diagnostics` i udostępnij `/tmp/premiere-mcp-bridge/premiere-mcp-diagnostics-latest.json`.

## Klienci MCP

- `npm run setup:mac` automatycznie konfiguruje Claude Desktop na macOS.
- Dla Codex, Claude Code i innych klientów użyj zbudowanego `dist/index.js` oraz `PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge`.

## Oficjalna dokumentacja

Pełna i aktualna dokumentacja znajduje się w [README.md](../README.md).
