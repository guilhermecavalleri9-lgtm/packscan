# Escala — Base de Entregas

App **separado do PackScan** para montar a escala automática dos motoristas.
É um único arquivo (`index.html`), sem servidor e sem instalação: abre no
navegador do celular ou computador. Os dados ficam salvos **no próprio
aparelho** (localStorage) — por isso tem backup em Configurações.

Visual estilo Nubank (roxo, cards). Primeira versão para irmos ajustando.

## Como abrir
- Abra o arquivo `escala/index.html` no navegador (duplo clique ou arraste pra aba).
- No celular: dá pra hospedar (ex.: GitHub Pages) e "Adicionar à tela de início".

## O que já dá pra fazer
- **Motoristas**: nome, veículo (🚗 carro / 🛵 moto), capacidade de pacotes/dia
  (só informativo) e vínculo:
  - **Fixo da rota** → região fixa + dias da semana que trabalha.
  - **Suplente** → quais regiões ele pode cobrir.
- **Regiões**: adicionar/remover (só por nome).
- **Folgas de emergência**: tira o motorista da escala numa data específica.
- **Gerar escala do dia**:
  1. Escala os **fixos** que trabalham naquele dia da semana (e não estão de folga).
  2. Se a região do fixo ficou **descoberta** (folga ou dia que ele não trabalha),
     puxa um **suplente** que pode cobrir aquela região.
  3. **Demanda (forquilha)**: você diz quantos carros/motos precisa no dia; se
     faltar, ele puxa **suplentes de reforço** do tipo de veículo certo.
  4. Mostra contadores (na rua / carros / motos), avisos de região sem cobertura
     ou demanda não atendida, e os suplentes que sobraram (disponíveis).
- **Backup**: exportar/importar `.json` em Configurações (⚙️ no topo).

## Próximos passos (a combinar)
- Reforço já ir direto pra uma região específica (hoje fica na lista pra você
  encaixar na rota mais cheia).
- Escala da semana inteira de uma vez.
- Contagem/registro de volume real por rota para automatizar o "vem muito".
