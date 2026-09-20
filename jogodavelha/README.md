# Velha ∞ — jogo da velha infinito (4 peças)

App separado dentro do PackScan, igual `escala` e `financeiro`: **sem login, só por link direto**.
Feito pra dois celulares na mesma sala, cada um com sua tela.

## Regra
- Cada jogador só pode ter **4 peças** no tabuleiro.
- Ao colocar a 5ª, a **peça mais antiga dele some** (ela fica piscando com contorno tracejado antes de sair).
- Ganha quem fizer 3 em linha. Como as peças se reciclam, **nunca dá velha** — o jogo é infinito.
- A revanche só começa quando os dois pedirem; quem perdeu começa a rodada seguinte.

## Como usar
1. Um dos dois abre `/jogodavelha`, põe o nome e toca em **Criar partida**.
2. Aparece um código de 4 letras/números. Toque em **Compartilhar link** (manda `/jogodavelha?sala=XXXX`).
3. O outro celular abre o link (ou digita o código) e a partida começa.

Dá pra instalar na tela inicial do celular (PWA próprio, `/jogodavelha/manifest.json`).

## Rotas
| Rota | O que faz |
|---|---|
| `GET /jogodavelha` | a página do jogo |
| `GET /jogodavelha/manifest.json`, `GET /jogodavelha/sw.js` | PWA |
| `POST /api/jogodavelha/criar` | cria a sala (quem cria joga de ✕) |
| `POST /api/jogodavelha/entrar` | entra pelo código (ou volta pra sala, com o token guardado) |
| `GET /api/jogodavelha/estado` | long-poll: o servidor segura a resposta até mudar algo (máx. 25s) |
| `POST /api/jogodavelha/jogar` | joga numa casa (0..8) |
| `POST /api/jogodavelha/revanche` | pede revanche |
| `POST /api/jogodavelha/zerar` | zera o placar |
| `POST /api/jogodavelha/sair` | libera a vaga na sala |

As salas ficam **só na memória do servidor** (nada de Supabase — partida é coisa passageira) e são
descartadas depois de 3h paradas. O servidor é quem manda nas regras: vez, casa ocupada, peça que
sai e vitória são todos validados lá, o celular só desenha.
