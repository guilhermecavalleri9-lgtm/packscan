# Cobras e Escadas

App separado dentro do PackScan (`/cobras`), sem login, só por link direto.
De **2 a 4 jogadores**, um dado, cada um no seu celular — ou vários no mesmo aparelho,
pra quem estiver junto na mesma mesa.

A tela de escolha entre os jogos fica em **`/jogos`**.

## Regras
- Rola **um dado** e anda o que tirar. (Com dois dados a média era 7 casas por vez
  e a partida acabava rápido demais.)
- Pé de escada **sobe**, cabeça de cobra **escorrega**.
- Pra chegar tem que tirar o **número certinho**: se o dado passar da última casa,
  o peão **não sai do lugar**. A partir de 6 casas do fim o placar mostra quanto falta.
- O jogo segue até todo mundo terminar (🥇🥈🥉); quem sobra por último fica em último.

## Tabuleiros
| Tabuleiro | Casas | Grade | Tempo |
|---|---|---|---|
| Corridinha | 20 | 5×4 | ~2 min |
| Rapidinho | 30 | 6×5 | ~3 min |
| Clássico 50 | 50 | 10×5 | ~5 min |
| Clássico 100 | 100 | 10×10 | ~10 min |
| Grandão 144 | 144 | 12×12 | ~15 min |
| Épico 225 | 225 | 15×15 | ~20 min |
| Maratona 400 | 400 | 20×20 | ~40 min |

Os tempos saíram de partidas simuladas de 4 jogadores (mediana de 5 partidas por
tabuleiro, contando uma jogada a cada 5 segundos).

O Clássico 100 usa o desenho tradicional (escada do 1 pro 38, cobra do 98 pro 78…).
Os outros são sorteados com semente fixa — "Grandão" é sempre o mesmo tabuleiro —
e o salto é medido **em linhas** (1 a 3 linhas, no máximo 3 colunas de lado), pra
cobra e escada saírem curtinhas no desenho mesmo no tabuleiro de 400 casas.
Nenhuma casa é ponta de duas coisas ao mesmo tempo, então não tem looping.

## Rotas
| Rota | O que faz |
|---|---|
| `GET /jogos` | tela inicial com a escolha do jogo |
| `GET /cobras` | a página do jogo (PWA próprio) |
| `POST /api/cobras/criar` | cria a sala (quem cria é o dono) |
| `POST /api/cobras/entrar` | entra pelo código; sem token vira jogador novo (serve pra pôr mais gente no mesmo celular), com token conhecido é reconexão |
| `GET /api/cobras/estado` | long-poll: segura a resposta até mudar algo (máx. 25s) |
| `POST /api/cobras/tabuleiro` | dono troca o tabuleiro (só no lobby) |
| `POST /api/cobras/comecar` | dono começa a partida (mínimo 2) |
| `POST /api/cobras/rolar` | rola o dado (só na sua vez) |
| `POST /api/cobras/revanche` | joga de novo com a mesma turma |
| `POST /api/cobras/lobby` | volta pro lobby pra trocar de tabuleiro |
| `POST /api/cobras/sair` | libera a vaga (aceita vários tokens separados por vírgula) |

O dado é rolado **no servidor** (`crypto.randomInt`), junto com a validação de
vez, o caminho andado, escada/cobra e a colocação — o celular só desenha e anima.
As salas ficam só na memória e somem depois de 6h paradas.
