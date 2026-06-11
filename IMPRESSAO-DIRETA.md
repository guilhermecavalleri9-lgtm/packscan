# 🖨 PackScan — Impressão direta de etiquetas (sem diálogo)

Por padrão, o navegador **sempre mostra o diálogo de impressão** ao bipar um
pacote (trava de segurança). Para a operação do dia a dia, dá pra eliminar esse
diálogo usando o Chrome em modo **Kiosk Printing** — aí a etiqueta sai **direto
na impressora**, sem perguntar nada.

## Pré-requisitos
1. Ter o **Google Chrome** instalado (ou Chromium / Brave).
2. Deixar a **impressora térmica como impressora PADRÃO** do sistema operacional.
   - O Chrome kiosk imprime sempre na impressora padrão.
3. Configurar o tamanho do papel da térmica como **100 × 25 mm** nas preferências
   da impressora (uma vez só).

## Linux (o seu caso)
```bash
chmod +x packscan-impressao-direta.sh   # só na primeira vez
./packscan-impressao-direta.sh
```

## Windows
Dê um **duplo-clique** em `PackScan-Impressao-Direta.bat`.

## Como funciona
Os scripts abrem o PackScan assim:
```
chrome --kiosk-printing --user-data-dir=<perfil-separado> https://packscan-noma.onrender.com
```
- `--kiosk-printing`: imprime direto na impressora padrão, **sem diálogo**.
- `--user-data-dir`: usa um perfil separado do seu Chrome normal, então as
  permissões de pop-up ficam lembradas e não atrapalham seu navegador do dia a dia.

## Dicas
- Na **primeira vez**, libere os pop-ups do site (ícone na barra de endereço →
  "Sempre permitir"). Sem isso a janela de impressão nem abre.
- Se sair na impressora errada, é porque ela não está como **padrão** do sistema.
- Para conferir o visual sem imprimir de verdade, abra o site no Chrome normal
  e use "Salvar como PDF" no diálogo.
- Mantenha "imprimir etiqueta automaticamente" **marcado** na aba Bipar.
