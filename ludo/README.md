# Ludo

App separado dentro do PackScan (`/ludo`), sem login, só por link direto.
De **2 a 4 jogadores**, 4 peões cada, um no seu celular — ou vários no mesmo
aparelho, pra quem estiver junto. A tela de escolha dos jogos fica em `/jogos`.

## Regras
- **Passa o dedo** na mesa e o dado rola (não tem botão).
- Precisa tirar **6** pra botar um peão na pista.
- Tirou **6, joga de novo** — três seguidos perde a vez.
- Parou em cima de peão adversário, **manda ele pra casa**. Nas casas marcadas
  com ★ (as quatro saídas e as quatro estrelas) ninguém come ninguém.
- Depois de dar a volta, o peão entra na **reta final** da cor dele.
- Pra entrar no meio tem que tirar o **número certinho**; passou, o peão não anda.
- Ganha quem levar os **4 peões** pra chegada. O jogo segue até todo mundo
  terminar (🥇🥈🥉), igual no cobras e escadas.

Com 2 jogadores as cores ficam em cantos opostos (vermelho e amarelo), que é
como se joga na mesa. As cores são distribuídas quando a partida começa.

Enrolou mais de **10 segundos**? O servidor joga por você: rola o dado e, se
tiver mais de um peão possível, escolhe sozinho — chegar no meio vale mais que
comer, comer mais que tirar peão da casa, e o desempate vai no peão mais
adiantado. A barrinha embaixo do dado mostra o tempo.

## Como o tabuleiro é representado
A posição do peão é um **passo de -1 a 56**, não uma coordenada:

| Passo | Onde está |
|---|---|
| -1 | na casa (base) |
| 0 a 50 | na volta; a casa física é `percurso[(inicio + passo) % 52]` |
| 51 a 55 | na reta final da cor |
| 56 | chegou no meio |

Cada cor começa numa casa diferente do percurso (0, 13, 26 e 39), então o
servidor não precisa saber desenho nenhum: pra saber se dois peões estão na
mesma casa basta comparar `(inicio + passo) % 52`. O desenho (cruz de 15×15,
retas finais, triângulos do meio) mora só no celular, que monta o SVG.

## Rotas
| Rota | O que faz |
|---|---|
| `GET /ludo` | a página do jogo (PWA próprio) |
| `POST /api/ludo/criar` | cria a sala (quem cria é o dono) |
| `POST /api/ludo/entrar` | entra pelo código; sem token vira jogador novo (mais gente no mesmo celular), com token conhecido é reconexão |
| `GET /api/ludo/estado` | long-poll: segura a resposta até mudar algo (máx. 25s) |
| `POST /api/ludo/comecar` | dono começa a partida (mínimo 2) |
| `POST /api/ludo/rolar` | rola o dado (o servidor também chama sozinho depois de 10s) |
| `POST /api/ludo/mover` | escolhe qual peão mexer (só quando dá mais de uma opção) |
| `POST /api/ludo/revanche` | joga de novo com a mesma turma |
| `POST /api/ludo/sair` | libera a vaga (aceita vários tokens separados por vírgula) |

Quando só existe **uma** jogada possível o servidor já mexe sozinho, e quando
não existe nenhuma ele passa a vez — o celular só escolhe peão quando tem mesmo
o que escolher.

O dado é rolado no servidor (`crypto.randomInt`), junto com a validação de vez,
as jogadas possíveis, a captura e a colocação. As salas ficam só na memória e
somem depois de 6h paradas.
