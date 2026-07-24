# Modo Motorista + Avisos — Plano (aprovado pelo Guilherme)

> Documento de referência pra construir quando houver tempo. **Nada disso está em
> produção ainda.** Aqui fica registrado o design aprovado, o fluxo e as regras.
> Data do combinado: julho/2026.

## Visão geral
Transformar o PackScan (que hoje planeja: importar → geocodificar → roteirizar)
em algo com **execução na rua estilo Circuit**, mas no visual escuro do PackScan
e **de graça** (sem virar app nativo). Continua sendo site/PWA.

Mockups aprovados (artifacts):
- Protótipo interativo (Iniciar rota → navegação): https://claude.ai/code/artifact/e57b9517-2dae-4e9e-862a-dd429810a3ac
- Fluxo completo (como encaixa no app): https://claude.ai/code/artifact/90c3c55f-37b9-4611-934d-7fbbe7b6d470
- Navegação no app (grátis): https://claude.ai/code/artifact/aa914457-097c-4174-912d-77cc2057495b
- Tela do motorista (estilo Circuit): https://claude.ai/code/artifact/22ab6bbf-ad6d-4bf5-be1a-13c4bd2c0e4a

Cópias dos mockups estão nesta pasta (`docs/modo-motorista/*.html`).

---

## 1. Entrada pela tela inicial
- Depois de roteirizar, aparece um botão **"Iniciar rota"** (verde, com tag "novo")
  logo abaixo dos 4 botões principais.
- Se houver mais de uma rota, abre uma listinha pra escolher qual motorista/rota.
- Também pode virar **link do motorista** (ele abre no celular dele, sem login;
  os status voltam pela sincronização que já existe).

## 2. Tela de navegação (estilo Circuit, tema escuro)
- **Mapa ocupando tudo** + **aba arrastável** (grab no topo; recolhe pra mostrar
  mais mapa).
- Endereço grande + contador "parada X / total · horário".
- **4 botões de ação** (ordem aprovada): **Navegar · Avisar (WhatsApp) · Não
  entregue · Entregue**.
  - **Navegar**: abre folha pra escolher Google Maps / Waze (guia por voz e volta).
  - **Avisar** (verde, WhatsApp): mensagem pronta **"Oi! Sua entrega é a próxima,
    já estou a caminho 🛵📦"** — abre o WhatsApp do motorista com o número do
    cliente preenchido. Grátis.
  - **Não entregue / Entregue**: marcam e avançam pra próxima parada.
- **Arrastar pro lado**: ← volta uma parada, → pula pra próxima (sem marcar).
- Info da parada: código do pacote, cidade + CEP; e opções Editar / Remover parada.
- **Posição do motorista ao vivo** (bolinha azul com cone de direção) via GPS do
  navegador — grátis.

## 3. Navegação: como fica de graça
- Mapa próprio (OpenStreetMap, o que já usamos) com a rota e a posição ao vivo
  **dentro do app** → custo R$ 0.
- Voz turn-by-turn NÃO roda bem em site; por isso o botão **Navegar** entrega pro
  Waze/Google Maps num toque (que o motorista já tem). É o que o próprio Circuit faz.
- Só ficaria "igual ao Circuit" (voz dentro do app) virando **app nativo** +
  licença do Navigation SDK do Google (pago). Fora do escopo por enquanto.

## 4. Lista de avisos (na TELA INICIAL também)
O Guilherme quer, **na página inicial**, uma lista pra avisar os clientes com
mensagem individual calculada por horário.

### Mensagem (template de início de rota)
> "Oi! Aqui é o entregador **{entregador}**. Estou iniciando a rota agora 🛵.
> Seu pedido é a **parada nº {posicao}** e deve chegar **entre {ini} e {fim}**. 📦"

### Cálculo do horário (ETA)
- **Tempo médio por parada:** ~3 min (configurável).
- **Previsão da parada N** = `hora_de_inicio + (N - 1) × 3min`.
- **Janela:** −1h e +1h em volta da previsão (2h no total). **Configurável**
  (ex.: ±40 min quando souber o ritmo real).
- **Travar o início da janela** pra nunca ser antes da hora de início (ex.: parada
  20 daria 12:57 se início 13:00 → mostra a partir de 13:00).

Exemplo (início 13:00, 3 min/parada):

| Parada | Previsão | Janela (−1h / +1h, travada no início) |
|---|---|---|
| 1  | 13:00 | 13:00 – 14:00 |
| 5  | 13:12 | 13:00 – 14:12 |
| 20 | 13:57 | 13:00 – 14:57 |
| 40 | 14:57 | 13:57 – 15:57 |
| 60 | 15:57 | 14:57 – 16:57 |

### Como enviar (lista "para cada um individualmente")
- **Grátis:** a lista mostra cada cliente com a mensagem pronta; toca em um → abre
  o WhatsApp preenchido → Enviar → próximo. Um por vez (o WhatsApp não deixa
  disparar pra vários num toque só). Custo R$ 0.
- **"Avisar os próximos 3"**: mesma coisa em fila (abre 1, envia, abre 2...).
- **Pago (API oficial):** dispara pra todos automaticamente ao mesmo tempo
  (~R$0,05–0,10 por cliente). Opcional, pra depois.

### Bônus (pra depois)
Recalcular sozinho as previsões das paradas restantes conforme o ritmo real do dia
(adiantado/atrasado), deixando as janelas mais certeiras.

---

## 5. O que precisa pra montar
- **Telefone do cliente** na planilha (coluna nova na importação).
- **Hora de início** da rota (o motorista informa ou pega automático ao "Iniciar rota").
- **Nome do entregador** (por rota/motorista).
- Texto dos templates (já definidos acima; ajustáveis).

## 6. Custos (resumo)
| Item | Custo |
|---|---|
| Modo motorista + navegação no app + posição ao vivo | **R$ 0** (mapa OSM + GPS) |
| Avisar cliente (WhatsApp do motorista, manual) | **R$ 0** |
| Lista de avisos com horário calculado | **R$ 0** |
| Envio automático em massa (API oficial) | ~R$0,05–0,10 por mensagem |
| Otimização real por ruas (OSRM próprio) | ~R$30–80/mês (servidor), uso ilimitado |

## 7. Duas mensagens diferentes (não confundir)
1. **Botão "Avisar" na parada** (ao lado do Navegar): *"Sua entrega é a próxima, já
   estou a caminho."* — pro cliente da vez.
2. **Lista de avisos na tela inicial** (início da rota): *"...seu pedido é a parada
   nº N, chega entre A e B."* — pra todos, com horário calculado.
