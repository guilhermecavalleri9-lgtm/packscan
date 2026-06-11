#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# PackScan — Modo impressão direta (Chrome Kiosk Printing)
#
# Abre o PackScan no Chrome com a flag --kiosk-printing, que faz as etiquetas
# saírem DIRETO na impressora padrão do sistema, sem mostrar o diálogo de
# impressão. Use no computador da operação que tem a impressora térmica.
#
# COMO USAR:
#   1. Deixe a impressora térmica como IMPRESSORA PADRÃO do sistema
#      (Configurações → Impressoras → clique na térmica → "Definir como padrão")
#   2. Dê permissão de execução uma vez:   chmod +x packscan-impressao-direta.sh
#   3. Rode:                               ./packscan-impressao-direta.sh
# ─────────────────────────────────────────────────────────────────────────────

URL="https://packscan-noma.onrender.com"

# Perfil separado pra não bagunçar seu Chrome normal (lembra pop-ups liberados)
PERFIL="$HOME/.packscan-chrome"

# Descobre o executável do Chrome/Chromium instalado
CHROME=""
for c in google-chrome google-chrome-stable chromium chromium-browser brave-browser; do
  if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
done

if [ -z "$CHROME" ]; then
  echo "❌ Chrome/Chromium não encontrado. Instale o Google Chrome primeiro."
  exit 1
fi

echo "🖨  Abrindo PackScan em modo impressão direta usando: $CHROME"
echo "   (as etiquetas vão sair direto na impressora padrão, sem diálogo)"

"$CHROME" \
  --kiosk-printing \
  --user-data-dir="$PERFIL" \
  --no-first-run \
  --disable-features=Translate \
  "$URL"
