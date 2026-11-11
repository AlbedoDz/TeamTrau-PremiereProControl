@echo off
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
call :main > "%ROOT%\install.log" 2>&1
exit /b %errorlevel%

:main
rem Everything below installs from files shipped in this folder; nothing is downloaded.
rem Each step runs even if an earlier one failed; the exit code is non-zero if any did.
set "FAILED=0"
set "PATH=%ROOT%\node;%ROOT%\uv;%ROOT%\ffmpeg\bin;%PATH%"
set "UV_PYTHON_INSTALL_DIR=%ROOT%\uvpython"
set "UV_PYTHON_DOWNLOADS=never"
set "UV_NO_INDEX=1"
set "UV_FIND_LINKS=%ROOT%\wheels"
if not defined PREMIERE_MCP_HOME set "PREMIERE_MCP_HOME=%USERPROFILE%\.premiere-mcp"

echo [1/4] Installing the Premiere bridge panel
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\app\scripts\install-windows.ps1" -SkipBuild -SkipCopilotConfig -SkipClaudeDesktopConfig
if errorlevel 1 set "FAILED=1"

echo [2/4] Registering with the AI clients found on this computer
node "%ROOT%\app\dist\cli.js" --register-clients
if errorlevel 1 set "FAILED=1"

echo [2b/4] Telling the panel where the runner is
node "%ROOT%\app\dist\cli.js" --register-panel-runner
if errorlevel 1 set "FAILED=1"

echo [3/4] Seeding speech and face models
robocopy "%ROOT%\seed-models" "%PREMIERE_MCP_HOME%\models" /E /XC /XN /XO /NFL /NDL /NJH /NJS
if errorlevel 8 set "FAILED=1"

echo [4/4] Creating the Python environment
node "%ROOT%\app\dist\cli.js" --setup-asr
if errorlevel 1 set "FAILED=1"

exit /b %FAILED%
