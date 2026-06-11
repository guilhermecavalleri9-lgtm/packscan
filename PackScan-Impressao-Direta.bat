@echo off
REM ============================================================================
REM  PackScan - Modo impressao direta (Chrome Kiosk Printing) - WINDOWS
REM
REM  Abre o PackScan no Chrome com a flag --kiosk-printing, que faz as
REM  etiquetas sairem DIRETO na impressora padrao do Windows, sem mostrar
REM  o dialogo de impressao.
REM
REM  COMO USAR:
REM    1. Deixe a impressora termica como IMPRESSORA PADRAO do Windows
REM       (Configuracoes > Bluetooth e dispositivos > Impressoras > clicar na
REM        termica > "Definir como padrao")
REM    2. De um duplo-clique neste arquivo.
REM ============================================================================

set URL=https://packscan-noma.onrender.com
set PERFIL=%LOCALAPPDATA%\PackScanChrome

REM Procura o chrome.exe nos locais comuns de instalacao
set CHROME=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe

if "%CHROME%"=="" (
  echo ERRO: Chrome nao encontrado. Instale o Google Chrome primeiro.
  pause
  exit /b 1
)

echo Abrindo PackScan em modo impressao direta...
echo As etiquetas vao sair direto na impressora padrao, sem dialogo.

start "" "%CHROME%" --kiosk-printing --user-data-dir="%PERFIL%" --no-first-run "%URL%"
