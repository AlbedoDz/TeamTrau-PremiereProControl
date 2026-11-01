#!/bin/bash
# TeamTrau PremiereProControl - cai dat tren macOS
cd "$(dirname "$0")" || exit 1
echo "=========================================="
echo " TeamTrau PremiereProControl - cai dat"
echo "=========================================="

if ! command -v node >/dev/null 2>&1; then
  echo "[LOI] Chua cai Node.js. Tai ban 20 tro len tai https://nodejs.org roi chay lai."
  exit 1
fi
if [ "$(node -p 'parseInt(process.versions.node)')" -lt 20 ]; then
  echo "[LOI] Can Node.js 20 tro len: https://nodejs.org"
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[CANH BAO] Chua co ffmpeg. Cac tool cat lang, do do lon, dung tho, dung theo nhac can ffmpeg."
  echo "           Cai bang: brew install ffmpeg"
fi

PKG="$(ls ./*.tgz 2>/dev/null | head -n 1)"
if [ -z "$PKG" ]; then
  echo "[LOI] Khong tim thay file .tgz canh file cai dat nay."
  exit 1
fi

echo "Dang cai dat goi $PKG ..."
npm install -g "$PKG" || { echo "[LOI] npm install that bai. Neu bao loi quyen, chay lai voi: sudo npm install -g \"$PKG\""; exit 1; }

echo
echo "Dang cai cau noi vao Premiere Pro va cau hinh Claude Desktop ..."
premiere-pro-mcp --install-cep || exit 1

echo
echo "Kiem tra cai dat ..."
premiere-pro-mcp --doctor

echo
echo "XONG. Lam tiep theo huong dan trong HUONG-DAN.md:"
echo " 1. Khoi dong lai Premiere Pro"
echo " 2. Window > Extensions > MCP Bridge (CEP) > Start Bridge"
echo " 3. Khoi dong lai Claude Desktop"
