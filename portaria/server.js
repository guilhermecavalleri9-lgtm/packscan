// ═══════════════════════════════════════════════════════════════════════════════
// PORTARIA — servidor do app de encomendas do condomínio
// ═══════════════════════════════════════════════════════════════════════════════
// App independente: sobe sozinho com `node server.js` e não depende de nenhum
// outro sistema. Node puro, sem bibliotecas externas.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/store');
const whats = require('./lib/whatsapp');

const PORT = process.env.PORT || 3010;
// PIN de acesso (opcional). Com ele preenchido, o app pede a senha antes de abrir.
const PIN = String(process.env.PORTARIA_PIN || '').trim();

const PUBLIC_DIR = path.join(__dirname, 'public');
const LIMITE_CORPO = 12 * 1024 * 1024; // 12 MB — foto da entrega cabe folgado

// ─── HELPERS HTTP ─────────────────────────────────────────────────────────────
function json(res, code, dados) {
  const corpo = Buffer.from(JSON.stringify(dados));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': corpo.length });
  res.end(corpo);
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let bruto = '', tamanho = 0;
    req.on('data', c => {
      tamanho += c.length;
      if (tamanho > LIMITE_CORPO) { req.destroy(); return reject(new Error('corpo grande demais')); }
      bruto += c;
    });
    req.on('end', () => { try { resolve(JSON.parse(bruto || '{}')); } catch (e) { resolve({}); } });
    req.on('error', reject);
  });
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function servirArquivo(res, arquivo, cache) {
  fs.readFile(arquivo, (err, dados) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': TIPOS[path.extname(arquivo).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': cache || 'no-cache'
    });
    res.end(dados);
  });
}

function novoId(prefixo) {
  return prefixo + '_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}
function txt(v, max) {
  return String(v === undefined || v === null ? '' : v).trim().slice(0, max || 120);
}

// ─── MENSAGENS PADRÃO ─────────────────────────────────────────────────────────
// Editáveis pelo app (aba Ajustes). Trechos entre chaves são trocados na hora:
// {nome} {condominio} {bloco} {apto} {codigo} {codigos} {lista} {qtd}
// {recebedor} {porteiro} {data} {hora}
const MSG_PADRAO = {
  chegadaUm:     'Olá {nome}! 👋\n\nSua entrega do código *{codigo}* chegou na portaria.\n\n📍 {bloco} · Apto {apto}\n🕒 {data} às {hora}\n\nJá pode retirar. 🙂',
  chegadaVarios: 'Olá {nome}! 👋\n\nChegaram *{qtd} entregas* pra você na portaria:\n\n{lista}\n\n📍 {bloco} · Apto {apto}\n🕒 {data} às {hora}\n\nJá pode retirar. 🙂',
  entregue:      'Olá {nome}! ✅\n\nEncomenda(s) *{codigos}* entregue(s) para *{recebedor}* em {data} às {hora}.\n\nQualquer dúvida, fale com a portaria. 🙂'
};

const fmtData = ts => new Date(ts).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const fmtHora = ts => new Date(ts).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

function montar(modelo, ctx) {
  return String(modelo || '').replace(/\{(\w+)\}/g, (todo, chave) =>
    (ctx[chave] === undefined || ctx[chave] === null) ? todo : String(ctx[chave]));
}

function contexto(cadastro, morador, bloco, apto, pacotes, extra) {
  const codigos = pacotes.map(p => p.codigo);
  const agora = Date.now();
  return Object.assign({
    nome: (morador && morador.nome) || 'morador',
    condominio: (cadastro && cadastro.condominio) || 'condomínio',
    bloco: bloco || '', apto: apto || '',
    codigo: codigos[0] || '',
    codigos: codigos.join(', '),
    lista: codigos.map((c, i) => `${i + 1}. *${c}*`).join('\n'),
    qtd: codigos.length,
    data: fmtData(agora), hora: fmtHora(agora)
  }, extra || {});
}

// aviso de chegada: um código só ou todos eles numa mensagem só
function textoChegada(cadastro, morador, bloco, apto, pacotes) {
  const msgs = Object.assign({}, MSG_PADRAO, (cadastro && cadastro.mensagens) || {});
  const modelo = pacotes.length > 1 ? msgs.chegadaVarios : msgs.chegadaUm;
  return montar(modelo, contexto(cadastro, morador, bloco, apto, pacotes));
}
function textoEntrega(cadastro, morador, bloco, apto, pacotes, recebedor, porteiro) {
  const msgs = Object.assign({}, MSG_PADRAO, (cadastro && cadastro.mensagens) || {});
  return montar(msgs.entregue, contexto(cadastro, morador, bloco, apto, pacotes, {
    recebedor: recebedor || (morador && morador.nome) || 'morador',
    porteiro: porteiro || 'portaria'
  }));
}

// ─── CADASTRO ─────────────────────────────────────────────────────────────────
// Limpa o que vem do app: campo estranho fora, texto no tamanho certo,
// telefone só com dígitos.
function sanearCadastro(body) {
  body = body || {};
  const msgs = body.mensagens || {};
  return {
    condominio: txt(body.condominio, 80) || 'Meu Condomínio',
    mensagens: {
      chegadaUm:     txt(msgs.chegadaUm, 1200)     || MSG_PADRAO.chegadaUm,
      chegadaVarios: txt(msgs.chegadaVarios, 1200) || MSG_PADRAO.chegadaVarios,
      entregue:      txt(msgs.entregue, 1200)      || MSG_PADRAO.entregue
    },
    avisoAutomatico: body.avisoAutomatico !== false,
    avisarNaEntrega: body.avisarNaEntrega !== false,
    blocos: (Array.isArray(body.blocos) ? body.blocos.slice(0, 200) : []).map(b => ({
      id: txt(b.id, 40) || novoId('b'),
      nome: txt(b.nome, 40) || 'Bloco',
      apartamentos: (Array.isArray(b.apartamentos) ? b.apartamentos.slice(0, 600) : []).map(a => ({
        id: txt(a.id, 40) || novoId('a'),
        numero: txt(a.numero, 20) || '?',
        moradores: (Array.isArray(a.moradores) ? a.moradores.slice(0, 20) : []).map(m => ({
          id: txt(m.id, 40) || novoId('m'),
          nome: txt(m.nome, 60) || 'Morador',
          telefone: whats.normalizarTelefone(m.telefone),
          avisar: m.avisar !== false
        }))
      }))
    })),
    atualizadoEm: new Date().toISOString()
  };
}

function acharLocal(cadastro, blocoId, aptoId) {
  const bloco = ((cadastro && cadastro.blocos) || []).find(b => b.id === blocoId) || null;
  const apto = bloco ? ((bloco.apartamentos || []).find(a => a.id === aptoId) || null) : null;
  return { bloco, apto };
}

// ─── PACOTES ──────────────────────────────────────────────────────────────────
const DIAS_HISTORICO = 120;  // entregas mais antigas saem da lista
const MAX_PACOTES = 4000;

const lerCadastro = async () => (await store.get('cadastro')) || sanearCadastro({});
const lerPacotes = async () => {
  const d = await store.get('pacotes');
  return (d && Array.isArray(d.pacotes)) ? d.pacotes : [];
};
const gravarPacotes = lista => store.set('pacotes', { pacotes: lista, atualizadoEm: new Date().toISOString() });

// tira do histórico o que já passou do prazo (e apaga as fotos junto)
function limpar(lista) {
  const limite = Date.now() - DIAS_HISTORICO * 86400000;
  const ficam = [], saem = [];
  for (const p of lista) {
    const velho = p.status === 'entregue' && (p.entregueEm || p.criadoEm || 0) < limite;
    (velho ? saem : ficam).push(p);
  }
  ficam.sort((a, b) => (b.criadoEm || 0) - (a.criadoEm || 0));
  while (ficam.length > MAX_PACOTES) {
    const i = ficam.map(p => p.status).lastIndexOf('entregue');
    if (i < 0) break;
    saem.push(ficam.splice(i, 1)[0]);
  }
  for (const p of saem) {
    if (p.fotoId) store.del('img:' + p.fotoId);
    if (p.assinaturaId) store.del('img:' + p.assinaturaId);
  }
  return ficam;
}

// grava foto/assinatura em chave separada — a lista de encomendas continua leve
async function guardarImagem(dataUrl, prefixo, limite) {
  if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/') !== 0) return null;
  const id = novoId(prefixo);
  await store.set('img:' + id, { dataUrl: dataUrl.slice(0, limite), criadoEm: Date.now() });
  return id;
}

// manda o aviso pra todos os moradores do apartamento que pedem para ser avisados
async function avisarMoradores(apto, montarTexto) {
  const moradores = ((apto && apto.moradores) || []).filter(m => m.avisar !== false && m.telefone);
  const enviados = [];
  for (const m of moradores) {
    const texto = montarTexto(m);
    const r = whats.automatico() ? await whats.enviar(m.telefone, texto) : { ok: false, erro: 'envio manual' };
    enviados.push({
      moradorId: m.id, morador: m.nome, telefone: m.telefone,
      enviado: r.ok, erro: r.ok ? null : r.erro,
      link: r.ok ? null : whats.link(m.telefone, texto), texto
    });
  }
  return enviados;
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function api(req, res, pathname, query) {
  // PIN de acesso: no cabeçalho (chamadas do app) ou na URL (imagens no <img>)
  if (PIN && pathname !== '/api/sessao') {
    const enviado = String(req.headers['x-portaria-pin'] || query.get('pin') || '');
    if (enviado !== PIN) return json(res, 401, { error: 'PIN inválido' });
  }

  // ── o app pergunta se precisa de PIN antes de mostrar a tela ──
  if (req.method === 'GET' && pathname === '/api/sessao') {
    const pin = String(req.headers['x-portaria-pin'] || query.get('pin') || '');
    return json(res, 200, {
      precisaPin: !!PIN,
      pinOk: !PIN || pin === PIN,
      envioAutomatico: whats.automatico(),
      provedor: whats.automatico() ? whats.provedor : null
    });
  }

  // ── carrega tudo que o app precisa pra abrir ──
  if (req.method === 'GET' && pathname === '/api/dados') {
    const [cadastro, pacotes] = await Promise.all([lerCadastro(), lerPacotes()]);
    return json(res, 200, {
      cadastro, pacotes,
      envioAutomatico: whats.automatico(),
      provedor: whats.automatico() ? whats.provedor : null,
      msgPadrao: MSG_PADRAO
    });
  }

  // ── salva o cadastro (blocos, apartamentos, moradores, mensagens) ──
  if (req.method === 'POST' && pathname === '/api/cadastro') {
    const body = await lerCorpo(req);
    const cadastro = sanearCadastro(body);
    await store.set('cadastro', cadastro);
    return json(res, 200, { ok: true, cadastro });
  }

  // ── bipagem: registra um ou vários códigos no apartamento escolhido ──
  if (req.method === 'POST' && pathname === '/api/pacotes/registrar') {
    const body = await lerCorpo(req);
    const blocoId = txt(body.blocoId, 40), aptoId = txt(body.aptoId, 40);
    const codigos = (Array.isArray(body.codigos) ? body.codigos : [body.codigo])
      .map(c => txt(c, 60).toUpperCase()).filter(Boolean).slice(0, 50);
    if (!codigos.length) return json(res, 400, { error: 'informe pelo menos um código' });

    const cadastro = await lerCadastro();
    const { bloco, apto } = acharLocal(cadastro, blocoId, aptoId);
    if (!bloco || !apto) return json(res, 404, { error: 'bloco ou apartamento não encontrado' });

    const lista = await lerPacotes();
    const agora = Date.now();
    const criados = [], repetidos = [];
    for (const codigo of codigos) {
      // já pendente = o porteiro bipou duas vezes; não duplica
      const igual = lista.find(p => p.codigo === codigo && p.status === 'pendente');
      if (igual) { repetidos.push(igual); continue; }
      const p = {
        id: novoId('p'), codigo, blocoId, aptoId,
        bloco: bloco.nome, apto: apto.numero,
        status: 'pendente', criadoEm: agora,
        porteiro: txt(body.porteiro, 40),
        avisadoEm: null, entregueEm: null, recebidoPor: '',
        fotoId: null, assinaturaId: null, obs: ''
      };
      lista.push(p); criados.push(p);
    }
    await gravarPacotes(limpar(lista));
    if (criados.length) console.log(`[portaria] ${criados.length} encomenda(s) · ${bloco.nome} apto ${apto.numero}`);
    return json(res, 200, { ok: true, criados, repetidos });
  }

  // ── avisa a chegada no WhatsApp (uma mensagem com todos os códigos) ──
  if (req.method === 'POST' && pathname === '/api/avisar') {
    const body = await lerCorpo(req);
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(i => txt(i, 40)).filter(Boolean);
    const cadastro = await lerCadastro();
    const lista = await lerPacotes();
    const alvo = lista.filter(p => ids.indexOf(p.id) !== -1);
    if (!alvo.length) return json(res, 400, { error: 'nenhuma encomenda selecionada' });

    const { bloco, apto } = acharLocal(cadastro, alvo[0].blocoId, alvo[0].aptoId);
    if (!apto) return json(res, 404, { error: 'apartamento não encontrado' });

    const enviados = await avisarMoradores(apto, m =>
      textoChegada(cadastro, m, bloco && bloco.nome, apto.numero, alvo));
    if (enviados.some(e => e.enviado)) {
      const agora = Date.now();
      for (const p of alvo) p.avisadoEm = agora;
      await gravarPacotes(lista);
    }
    return json(res, 200, {
      ok: true, enviados, automatico: whats.automatico(),
      semTelefone: enviados.length === 0
    });
  }

  // ── o app abriu os links wa.me: marca as encomendas como avisadas ──
  if (req.method === 'POST' && pathname === '/api/avisado') {
    const body = await lerCorpo(req);
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(i => txt(i, 40));
    const lista = await lerPacotes();
    const agora = Date.now();
    let n = 0;
    for (const p of lista) if (ids.indexOf(p.id) !== -1 && !p.avisadoEm) { p.avisadoEm = agora; n++; }
    if (n) await gravarPacotes(lista);
    return json(res, 200, { ok: true, marcados: n });
  }

  // ── entrega ao morador: quem recebeu + foto + assinatura ──
  if (req.method === 'POST' && pathname === '/api/pacotes/entregar') {
    const body = await lerCorpo(req);
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(i => txt(i, 40)).filter(Boolean);
    if (!ids.length) return json(res, 400, { error: 'nenhuma encomenda selecionada' });

    const lista = await lerPacotes();
    const alvo = lista.filter(p => ids.indexOf(p.id) !== -1 && p.status === 'pendente');
    if (!alvo.length) return json(res, 400, { error: 'encomendas já entregues ou inexistentes' });

    const fotoId = await guardarImagem(body.foto, 'f', 4000000);
    const assinaturaId = await guardarImagem(body.assinatura, 's', 2000000);

    const agora = Date.now();
    const recebedor = txt(body.recebidoPor, 60) || 'morador';
    for (const p of alvo) {
      p.status = 'entregue'; p.entregueEm = agora;
      p.recebidoPor = recebedor;
      p.recebedorId = txt(body.moradorId, 40);
      p.porteiroEntrega = txt(body.porteiro, 40);
      p.obs = txt(body.obs, 300);
      p.fotoId = fotoId; p.assinaturaId = assinaturaId;
    }
    await gravarPacotes(limpar(lista));

    let enviados = [];
    if (body.avisar) {
      const cadastro = await lerCadastro();
      const { bloco, apto } = acharLocal(cadastro, alvo[0].blocoId, alvo[0].aptoId);
      enviados = await avisarMoradores(apto, m =>
        textoEntrega(cadastro, m, bloco && bloco.nome, apto && apto.numero, alvo, recebedor, txt(body.porteiro, 40)));
    }
    console.log(`[portaria] ${alvo.length} encomenda(s) entregue(s) para ${recebedor}`);
    return json(res, 200, { ok: true, entregues: alvo.map(p => p.id), enviados, automatico: whats.automatico() });
  }

  // ── apagar encomenda registrada por engano ──
  if (req.method === 'POST' && pathname === '/api/pacotes/remover') {
    const body = await lerCorpo(req);
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(i => txt(i, 40));
    const lista = await lerPacotes();
    const ficam = [];
    let n = 0;
    for (const p of lista) {
      if (ids.indexOf(p.id) !== -1) {
        n++;
        if (p.fotoId) store.del('img:' + p.fotoId);
        if (p.assinaturaId) store.del('img:' + p.assinaturaId);
      } else ficam.push(p);
    }
    if (n) await gravarPacotes(ficam);
    return json(res, 200, { ok: true, removidos: n });
  }

  // ── foto ou assinatura de uma entrega (abre direto no <img src>) ──
  if (req.method === 'GET' && pathname === '/api/imagem') {
    const id = txt(query.get('id'), 40);
    const img = id ? await store.get('img:' + id) : null;
    const m = img && img.dataUrl ? /^data:([\w/+.-]+);base64,(.*)$/.exec(img.dataUrl) : null;
    if (!m) { res.writeHead(404); return res.end('Not found'); }
    const bin = Buffer.from(m[2], 'base64');
    res.writeHead(200, { 'Content-Type': m[1], 'Content-Length': bin.length, 'Cache-Control': 'private, max-age=86400' });
    return res.end(bin);
  }

  return json(res, 404, { error: 'rota não encontrada' });
}

// ─── SERVIDOR ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = decodeURIComponent(u.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Portaria-Pin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    return res.end();
  }

  try {
    if (pathname.indexOf('/api/') === 0) return await api(req, res, pathname, u.searchParams);
  } catch (e) {
    console.error('[erro]', pathname, e.message);
    return json(res, 500, { error: 'erro no servidor: ' + e.message });
  }

  // arquivos do app
  if (req.method === 'GET') {
    if (pathname === '/' || pathname === '/index.html') return servirArquivo(res, path.join(PUBLIC_DIR, 'index.html'));
    if (pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type': TIPOS['.js'], 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
      return fs.createReadStream(path.join(PUBLIC_DIR, 'sw.js')).pipe(res);
    }
    // nada de subir pastas com ../
    const seguro = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const arquivo = path.join(PUBLIC_DIR, seguro);
    if (arquivo.indexOf(PUBLIC_DIR) === 0 && fs.existsSync(arquivo) && fs.statSync(arquivo).isFile()) {
      return servirArquivo(res, arquivo, /\.(png|svg|ico)$/.test(arquivo) ? 'public, max-age=86400' : 'no-cache');
    }
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🏢 Portaria na porta ${PORT}`);
  console.log(`   dados: ${store.usandoSupabase ? 'Supabase' : store.DATA_DIR}`);
  console.log(`   whatsapp: ${whats.automatico() ? 'automático (' + whats.provedor + ')' : 'manual (link wa.me)'}`);
  console.log(`   acesso: ${PIN ? 'protegido por PIN' : 'sem PIN (só pelo link)'}`);
});
