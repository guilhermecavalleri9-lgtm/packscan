# Mandato Presidencial

Protótipo de simulador presidencial do Brasil (jan/2027 → eleição out/2030, turnos mensais).
HTML único, JavaScript puro, sem framework. Globo 3D com globe.gl (CDN jsDelivr).

## Estrutura
- `src/head.html` — CSS (tema escuro fixo "sala de situação") e marcação da página
- `src/data.js` — dados de partida: setores de comércio, 36 países (PIB, população, gasto militar, comércio com o Brasil), blocos do Congresso, grupos sociais, itens de preço, linhas do orçamento, 22 leis prontas, nomes e cidades
- `src/engine.js` — motor: fiscal (`calcFiscal`), comércio (`tradeCalc`), preços/congelamento (`pricesStep`), macro (`macroStep`: PIB, inflação, Selic por regra de Taylor, câmbio, desemprego, dívida), social, países e retaliação (`worldStep`), guerra, Congresso e votações (`vote`, `lawsStep`), 2.400 agentes (`agentsStep`), eventos (`EVENTS`), `stepMonth`
- `src/ui.js` — abas (Gabinete, Economia, Comércio, Preços, Leis, Mundo, Defesa, Povo), globo, modais, IA e save em localStorage
- `src/geo.json` — fronteiras Natural Earth 110m (world-atlas), coordenadas arredondadas
- `build.py` — gera `index.html` juntando tudo (rode `python3 build.py` depois de mexer em `src/`)
- Publicado em `/presidente` pelo `server.js` do PackScan

## IA
Hoje usa `claude.use("sample")`, que só existe dentro de artifacts do claude.ai.
Fora dele, trocar `SAMPLE(...)` / `SAMPLE.json(...)` em `ui.js` por chamadas à API da Anthropic
(via um backend pequeno, para não expor a chave). Usos: feed mensal de manchetes e posts,
análise de lei escrita em texto livre (Casa Civil), conversa com cidadãos, conselho de ministros.

## Estado atual e próximos passos sugeridos
- Balanceamento feito só por alto (sem ações, aprovação cai de ~46% para ~27% no 1º ano).
- Dados de 2026 (Selic, salário mínimo) são estimativas; conferir.
- Ideias: migrar para React + Vite ou Godot, separar motor em módulo testável, permitir jogar com outros países, backend para IA, testes do motor.
