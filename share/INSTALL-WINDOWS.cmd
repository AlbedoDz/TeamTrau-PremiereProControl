@echo off
setlocal
cd /d "%~dp0"
echo ==========================================
echo  TeamTrau PremiereProControl - cai dat
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [LOI] Chua cai Node.js. Tai ban 20 tro len tai https://nodejs.org roi chay lai file nay.
  pause
  exit /b 1
)
for /f %%v in ('node -p "parseInt(process.versions.node)"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
  echo [LOI] Node.js la ban %NODE_MAJOR%. Can ban 20 tro len: https://nodejs.org
  pause
  exit /b 1
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [CANH BAO] Chua co ffmpeg. Cac tool cat lang, do do lon, dung tho va dung theo nhac can ffmpeg.
  echo            Cai bang lenh: winget install --id Gyan.FFmpeg -e   ^(sau do mo lai cua so nay^)
  echo.
)

set PKG=
for %%f in ("%~dp0*.tgz") do set PKG=%%f
if "%PKG%"=="" (
  echo [LOI] Khong tim thay file .tgz canh file cai dat nay.
  pause
  exit /b 1
)

echo Dang cai dat goi %PKG% ...
call npm install -g "%PKG%"
if errorlevel 1 (
  echo [LOI] npm install that bai. Xem thong bao phia tren.
  pause
  exit /b 1
)

echo.
echo Dang cai cau noi vao Premiere Pro va cau hinh Claude Desktop / VS Code ...
call premiere-pro-mcp --install-cep
if errorlevel 1 (
  echo [LOI] Cai cau noi that bai. Xem thong bao phia tren.
  pause
  exit /b 1
)

echo.
echo Kiem tra cai dat ...
call premiere-pro-mcp --doctor

echo.
echo ==========================================
echo  XONG. Lam tiep theo huong dan trong HUONG-DAN.md:
echo  1. Khoi dong lai Premiere Pro
echo  2. Window ^> Extensions ^> TeamTrau PremiereProControl ^> Start Bridge
echo  3. Khoi dong lai Claude Desktop / VS Code
echo ==========================================
pause
