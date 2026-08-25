# 🏢 Portaria · encomendas do condomínio

App para o porteiro receber e entregar encomendas, avisando o morador no WhatsApp.
É um app **independente**: sobe sozinho com `node server.js`, sem depender de nenhum
outro sistema, e usa só o Node (nenhuma biblioteca para instalar).

## Como o porteiro usa

1. **Início** — lista dos blocos cadastrados. Botão **Adicionar bloco**.
2. **Bloco** — os apartamentos daquele bloco, com a quantidade de encomendas esperando.
3. **Apartamento** — a tela de trabalho:
   - **bipar** com o leitor USB do computador (o leitor digita o código e dá Enter — é só
     manter a tela aberta), pela **câmera do celular**, ou digitando à mão;
   - o aviso no WhatsApp sai com **todos os códigos numa mensagem só**;
   - **entregar** ao morador com **foto** e **assinatura** na tela.
4. **Pendentes** — tudo que está aguardando retirada, agrupado por apartamento.
5. **Histórico** — as entregas feitas, com o comprovante (foto + assinatura).
6. **Ajustes** — nome do condomínio, nome do porteiro e o texto das mensagens.

Cada apartamento pode ter **vários moradores, cada um com o seu WhatsApp**, e uma
chavinha por morador diz quem recebe ou não o aviso.

O app é um PWA: dá para instalar na tela inicial do celular ("Adicionar à tela de início")
e ele abre em tela cheia, sem barra do navegador.

## Rodando

```bash
cd portaria
node server.js          # http://localhost:3010
```

Para o celular do porteiro acessar, use o IP do computador na rede
(`http://192.168.0.10:3010`). A **câmera só funciona em HTTPS ou em localhost** —
é uma trava dos navegadores. Na rede local, publique atrás de um HTTPS
(Cloudflare Tunnel, ngrok, nginx com certificado) ou use o leitor USB.

## Aviso no WhatsApp

Funciona de dois jeitos:

**1. Manual (padrão, sem configurar nada)** — o app monta a mensagem pronta e abre a
conversa do morador no WhatsApp do próprio aparelho. O porteiro só toca em enviar.
Não precisa de conta paga nem de número dedicado.

**2. Automático** — configurando um provedor, o servidor envia sozinho, sem ninguém tocar
em nada. Escolha um destes:

| Provedor | Variáveis de ambiente |
|---|---|
| [Z-API](https://z-api.io) | `WHATSAPP_PROVIDER=zapi`, `ZAPI_INSTANCE`, `ZAPI_TOKEN`, `ZAPI_CLIENT_TOKEN` |
| [Evolution API](https://github.com/EvolutionAPI/evolution-api) (auto-hospedada) | `WHATSAPP_PROVIDER=evolution`, `EVOLUTION_URL`, `EVOLUTION_KEY`, `EVOLUTION_INSTANCE` |
| WhatsApp Cloud API (oficial da Meta) | `WHATSAPP_PROVIDER=cloud`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_TEMPLATE`, `WHATSAPP_TEMPLATE_LANG` |

```bash
WHATSAPP_PROVIDER=zapi ZAPI_INSTANCE=xxx ZAPI_TOKEN=yyy node server.js
```

Na API oficial da Meta, mensagem iniciada pela empresa fora da janela de 24h só sai por
**template aprovado** — por isso o `WHATSAPP_TEMPLATE`: o texto da encomenda vai como
parâmetro do corpo do template. Z-API e Evolution mandam texto livre.

Com o envio automático ligado, o app espera ~8 segundos depois da última bipagem antes de
mandar — assim, se chegaram 3 encomendas para o mesmo apartamento, sai **uma mensagem só
com os 3 códigos**. Dá para tocar no botão para enviar antes da hora, e a espera pode ser
desligada em Ajustes.

## Mensagens

Editáveis em **Ajustes**, com três modelos: chegou 1 encomenda, chegaram várias, e
encomenda entregue. Trechos entre chaves são trocados na hora do envio:

`{nome}` `{condominio}` `{bloco}` `{apto}` `{codigo}` `{codigos}` `{lista}` `{qtd}`
`{recebedor}` `{porteiro}` `{data}` `{hora}`

Exemplo do padrão:

> Olá Maria Souza! 👋
> Sua entrega do código **BR123456789BR** chegou na portaria.
> 📍 Bloco A · Apto 101 — 🕒 24/08/2026 às 21:59

## Outras variáveis

| Variável | Para que serve |
|---|---|
| `PORT` | porta do servidor (padrão `3010`) |
| `PORTARIA_PIN` | com um PIN definido, o app pede a senha antes de abrir |
| `DATA_DIR` | pasta dos dados no modo arquivo (padrão `portaria/dados`) |
| `SUPABASE_URL` + `SUPABASE_KEY` | guarda tudo no Supabase em vez do disco |
| `SUPABASE_TABELA` | nome da tabela (padrão `portaria_kv`) |

## Onde ficam os dados

Sem Supabase, tudo vai para arquivos JSON em `portaria/dados/` (gravação atômica: escreve
num temporário e renomeia, para não corromper se faltar energia). Em hospedagem que apaga o
disco a cada deploy (Render, Railway e afins), use o Supabase criando a tabela:

```sql
create table portaria_kv (
  chave text primary key,
  valor jsonb not null,
  atualizado_em timestamptz default now()
);
```

Fotos e assinaturas ficam em chaves separadas das listas, então carregar a tela de
encomendas não puxa imagem nenhuma. Entregas com mais de 120 dias saem do histórico
automaticamente, junto com as suas imagens.

## Ícones

`npm run icones` regera os PNGs do PWA (`tools/gerar-icones.js` desenha e codifica o PNG
na mão, sem biblioteca).
