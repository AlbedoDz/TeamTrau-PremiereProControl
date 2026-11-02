@echo off
rem Launcher for the installed copy: runs the bundled Node with the bundled uv and ffmpeg on PATH.
set "ROOT=%~dp0.."
set "PATH=%ROOT%\node;%ROOT%\uv;%ROOT%\ffmpeg\bin;%PATH%"
set "UV_PYTHON_INSTALL_DIR=%ROOT%\uvpython"
"%ROOT%\node\node.exe" "%ROOT%\app\dist\cli.js" %*
