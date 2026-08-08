const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY || 'AIzaSyCHRl5eRHAfw0-WVEBj0wC5tpbJ81265gk';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const MERCADOPAGO_TOKEN = process.env.MERCADOPAGO_TOKEN || '';
// pacotes de créditos à venda (1 crédito = 1 requisição). Preço = custo de API × 1,3 (~30% de margem), arredondado.
const PACOTES_CREDITOS = [
  { id: 'p1000', creditos: 1000, preco: 34.90 },
  { id: 'p2500', creditos: 2500, preco: 86.90 },
  { id: 'p5000', creditos: 5000, preco: 174.90 }
];
// plano mensal com chave própria: usa a própria chave do Google (obrigatória; a da IA é opcional) por 30 dias, sem gastar créditos
const PLANO_MENSAL = { id: 'plano_mensal', preco: 24.90, dias: 30 };
// créditos de boas-vindas pra testar o sistema ao se registrar
const CREDITOS_BOAS_VINDAS = 150;
// programa de indicação: quem assina por um link ganha 20% de desconto, e quem indicou
// ganha 20% acumulativo por indicação confirmada — a cada 5 indicações, 1 mês grátis.
const INDICACAO_PCT = 20;
const INDICACOES_POR_MES_GRATIS = 5;
// banco de endereços local (CNEFE/IBGE Censo 2022) — geocodificação instantânea e grátis.
// Baixa por município; chave no cache = 'cnefe:<cep8>:<numero>' -> {lat,lng,logradouro,bairro,cidade}
const CNEFE_BASE = 'https://ftp.ibge.gov.br/Cadastro_Nacional_de_Enderecos_para_Fins_Estatisticos/Censo_Demografico_2022/Arquivos_CNEFE/CSV/Municipio/42_SC/';
const _cnefeJobs = {}; // cod -> { estado:'rodando'|'ok'|'erro', feito, total, enderecos, error, cidade }
const CNEFE_CIDADES = [
  { cod: '4216602', nome: 'São José',       arq: '4216602_SAO_JOSE.zip' },
  { cod: '4205407', nome: 'Florianópolis',  arq: '4205407_FLORIANOPOLIS.zip' },
  { cod: '4211900', nome: 'Palhoça',        arq: '4211900_PALHOCA.zip' },
  { cod: '4202305', nome: 'Biguaçu',        arq: '4202305_BIGUACU.zip' }
];

// e-mail transacional (Brevo) — confirmação de cadastro
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_SENDER = process.env.BREVO_SENDER || '';
const BREVO_SENDER_NOME = process.env.BREVO_SENDER_NOME || 'PackScan';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((res, rej) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { res(JSON.parse(body)); } catch(e) { res({}); } });
    req.on('error', rej);
  });
}

function json(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

// ─── OSRM: roteirização por ruas reais (opcional, com fallback no cliente) ──────
const OSRM_URL = process.env.OSRM_URL || 'http://169.58.84.152:5000';

// pega a matriz de tempos (duração) entre todos os pontos via serviço /table
function osrmTable(coords) { // coords = [[lng,lat], ...]
  return new Promise((resolve, reject) => {
    const coordStr = coords.map(c => c[0].toFixed(6) + ',' + c[1].toFixed(6)).join(';');
    const full = OSRM_URL + '/table/v1/driving/' + coordStr + '?annotations=duration';
    const lib = full.indexOf('https') === 0 ? https : http;
    const reqO = lib.get(full, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.code === 'Ok' && j.durations) resolve(j.durations);
          else reject(new Error('OSRM: ' + (j.code || 'sem matriz')));
        } catch (e) { reject(e); }
      });
    });
    reqO.on('error', reject);
    reqO.setTimeout(15000, () => reqO.destroy(new Error('OSRM timeout')));
  });
}

// pega o TRAÇADO da rota pelas ruas (geometria) via serviço /route
function osrmRoute(coords) { // coords = [[lng,lat], ...]
  return new Promise((resolve, reject) => {
    const coordStr = coords.map(c => c[0].toFixed(6) + ',' + c[1].toFixed(6)).join(';');
    const full = OSRM_URL + '/route/v1/driving/' + coordStr + '?overview=full&geometries=geojson';
    const lib = full.indexOf('https') === 0 ? https : http;
    const reqO = lib.get(full, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.code === 'Ok' && j.routes && j.routes[0] && j.routes[0].geometry) resolve(j.routes[0].geometry.coordinates);
          else reject(new Error('OSRM route: ' + (j.code || 'sem rota')));
        } catch (e) { reject(e); }
      });
    });
    reqO.on('error', reject);
    reqO.setTimeout(20000, () => reqO.destroy(new Error('OSRM timeout')));
  });
}

// 2-opt usando a matriz de tempos; iniIdx/fimIdx (índices no vetor coords) fixam
// as pontas quando o usuário configurou ponto de partida/chegada
function osrmDoisOpt(ordem, D, base, iniIdx, fimIdx) {
  const di = (a, b) => { const v = D[a] && D[a][b]; return (v == null ? 1e12 : v); };
  const node = pos => base + ordem[pos];
  let n = ordem.length, melhorou = true, voltas = 0;
  while (melhorou && voltas < 40) {
    melhorou = false; voltas++;
    for (let i = 0; i < n - 1; i++) {
      let A = (i === 0) ? iniIdx : node(i - 1);
      for (let k = i + 1; k < n; k++) {
        const E = (k === n - 1) ? fimIdx : node(k + 1);
        const B = node(i), C = node(k);
        let antes = 0, depois = 0;
        if (A >= 0) { antes += di(A, B); depois += di(A, C); }
        if (E >= 0) { antes += di(C, E); depois += di(B, E); }
        if (depois + 1e-9 < antes) {
          let lo = i, hi = k;
          while (lo < hi) { const t = ordem[lo]; ordem[lo] = ordem[hi]; ordem[hi] = t; lo++; hi--; }
          melhorou = true; A = (i === 0) ? iniIdx : node(i - 1);
        }
      }
    }
  }
  return ordem;
}

// devolve a ordem ótima (índices dos pontos de entrada) usando tempos reais
async function otimizarOSRM(pontos, ini, fim) {
  const coords = [];
  let iniIdx = -1, fimIdx = -1;
  if (ini && ini.lat && ini.lng) { iniIdx = coords.length; coords.push([ini.lng, ini.lat]); }
  const base = coords.length;
  pontos.forEach(p => coords.push([p.lng, p.lat]));
  if (fim && fim.lat && fim.lng) { fimIdx = coords.length; coords.push([fim.lng, fim.lat]); }
  const D = await osrmTable(coords);
  const n = pontos.length;
  const di = (a, b) => { const v = D[a] && D[a][b]; return (v == null ? 1e12 : v); };
  const idx = i => base + i;
  // vizinho mais próximo (por tempo), começando do ponto de partida se houver
  const visit = new Array(n).fill(false), ordem = [];
  let cur;
  if (iniIdx >= 0) cur = iniIdx;
  else { ordem.push(0); visit[0] = true; cur = idx(0); }
  while (ordem.length < n) {
    let best = -1, bd = Infinity;
    for (let j = 0; j < n; j++) if (!visit[j]) { const d = di(cur, idx(j)); if (d < bd) { bd = d; best = j; } }
    if (best < 0) break;
    visit[best] = true; ordem.push(best); cur = idx(best);
  }
  return osrmDoisOpt(ordem, D, base, iniIdx, fimIdx);
}

function httpsGet(hostname, reqPath) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path: reqPath, headers: { 'User-Agent': 'PackScan/3.0' } }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function httpsPost(hostname, reqPath, headers, payload) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(payload);
    const req = https.request(
      { hostname, path: reqPath, method: 'POST', headers: { ...headers, 'Content-Length': buf.length } },
      r => { let data = ''; r.on('data', c => data += c); r.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } }); }
    );
    req.on('error', reject); req.write(buf); req.end();
  });
}

// baixa uma URL https e devolve o corpo como Buffer (segue redirecionamentos simples)
function httpsGetBuffer(urlStr, saltos) {
  saltos = saltos || 0;
  return new Promise((resolve, reject) => {
    if (saltos > 5) return reject(new Error('muitos redirecionamentos'));
    https.get(urlStr, { headers: { 'User-Agent': 'PackScan/3.0' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        const next = r.headers.location.startsWith('http') ? r.headers.location : new URL(r.headers.location, urlStr).toString();
        return resolve(httpsGetBuffer(next, saltos + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// descompacta o PRIMEIRO arquivo de um .zip usando só o zlib nativo (lê o diretório
// central pra achar o tamanho comprimido e o offset — funciona pra zip de 1 arquivo).
const zlib = require('zlib');
function unzipPrimeiroArquivo(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: EOCD não encontrado');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('zip: diretório central inválido');
  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip: header local inválido');
  const lFnLen = buf.readUInt16LE(localOffset + 26);
  const lExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + lFnLen + lExtraLen;
  const comp = buf.slice(dataStart, dataStart + compSize);
  return method === 8 ? zlib.inflateRawSync(comp) : comp;
}

// ─── SUPABASE CACHE ───────────────────────────────────────────────────────────
// cache local em memória para esta instância (evita bater no Supabase toda requisição)
const memoriaCache = {};

async function supabaseGet(cacheKey) {
  // 1. tenta memória primeiro
  if (memoriaCache[cacheKey]) return memoriaCache[cacheKey];

  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const keyEnc = encodeURIComponent(cacheKey);
    const r = await supabaseRequest('GET',
      `/rest/v1/geo_cache?cache_key=eq.${keyEnc}&select=*&limit=1`
    );
    if (r.status >= 300) { console.error('[supabase get]', r.status, JSON.stringify(r.body)); return null; }
    const result = r.body;
    if (result && result[0]) {
      const coord = result[0].coord_data;
      memoriaCache[cacheKey] = coord;
      return coord;
    }
  } catch(e) { console.error('[supabase get]', e.message); }
  return null;
}

async function supabaseSet(cacheKey, coordData) {
  memoriaCache[cacheKey] = coordData;
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  // Upsert manual (GET → PATCH ou POST). Funciona com ou sem constraint UNIQUE
  // em cache_key, ao contrário de Prefer:merge-duplicates que exige a constraint
  // (e falhava silenciosamente, não persistindo nada entre reinícios do servidor).
  try {
    const keyEnc = encodeURIComponent(cacheKey);
    const get = await supabaseRequest('GET',
      `/rest/v1/geo_cache?cache_key=eq.${keyEnc}&select=cache_key&limit=1`);
    if (get.status >= 300) { console.error('[supabase set/get]', get.status, JSON.stringify(get.body)); return; }
    let r;
    if (get.body && get.body[0]) {
      r = await supabaseRequest('PATCH', `/rest/v1/geo_cache?cache_key=eq.${keyEnc}`, {
        coord_data: coordData,
        criado_em: new Date().toISOString()
      });
    } else {
      r = await supabaseRequest('POST', '/rest/v1/geo_cache', {
        cache_key: cacheKey,
        coord_data: coordData,
        criado_em: new Date().toISOString()
      });
    }
    if (r.status >= 300) console.error('[supabase set]', r.status, JSON.stringify(r.body));
  } catch(e) { console.error('[supabase set]', e.message); }
}

// procura, em pacotes já geocodificados antes (qualquer importação, não só o lote
// atual), uma rua resolvida pra esse CEP — útil quando o texto do pacote atual e a
// referência do Google pro CEP não trazem nome de rua nenhum
async function buscarRuaApreendidaPorCep(cep) {
  if (!cep) return '';
  const prefixo = `end:${cep}|`;
  for (const k in memoriaCache) {
    if (k.indexOf(prefixo) === 0) {
      const c = memoriaCache[k];
      if (c && c.logradouro && c.logradouro.trim()) return c.logradouro.trim();
    }
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) return '';
  try {
    const r = await supabaseRequest('GET',
      `/rest/v1/geo_cache?cache_key=like.${encodeURIComponent(prefixo + '*')}&select=coord_data&limit=20`
    );
    if (r.status >= 300 || !Array.isArray(r.body)) return '';
    for (const row of r.body) {
      const c = row.coord_data;
      if (c && c.logradouro && c.logradouro.trim()) return c.logradouro.trim();
    }
  } catch(e) { console.error('[cep-rua-cache]', e.message); }
  return '';
}

// limpa só o cache de geocodificação por endereço ("end:...") — NUNCA as referências
// de CEP ("cep:..."), correções de nome ("cfg:nomes") ou usuários ("auth:..."), que
// moram na mesma tabela genérica mas são dados permanentes, não cache descartável
async function supabaseClear() {
  Object.keys(memoriaCache).forEach(k => { if (k.indexOf('end:') === 0) delete memoriaCache[k]; });
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await supabaseRequest('DELETE', `/rest/v1/geo_cache?cache_key=like.${encodeURIComponent('end:*')}`);
  } catch(e) { console.error('[supabase clear]', e.message); }
}

async function supabaseDelete(cacheKey) {
  delete memoriaCache[cacheKey];
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const keyEnc = encodeURIComponent(cacheKey);
    await supabaseRequest('DELETE', `/rest/v1/geo_cache?cache_key=eq.${keyEnc}`);
  } catch(e) { console.error('[supabase delete]', e.message); }
}

// ─── CONTADOR DE USO DA GOOGLE GEOCODING API ──────────────────────────────────
// Registra UMA linha por chamada REAL ao Google (cache miss). É chamada de dentro
// das funções que de fato batem no Google (geocodificarEndereco e ruaPeloCep), que
// só são alcançadas quando não houve cache — então cache hit nunca conta.
// NUNCA pode travar/derrubar o fluxo de geocodificação: tudo em try/catch e sem await
// obrigatório no chamador.
async function logGoogleCall(usuario, cep, apiType, tokens) {
  // contabiliza o consumo de créditos: só requisições ao Google contam (1 req = 1 crédito)
  if (usuario && (apiType || 'geocoding') === 'geocoding') {
    if (typeof usoGeocoding[usuario] === 'number') usoGeocoding[usuario]++;
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await supabaseRequest('POST', '/rest/v1/google_api_log', {
      usuario: usuario || null,
      api_type: apiType || 'geocoding',
      cep: cep || null,
      input_tokens: (tokens && tokens.input) || null,
      output_tokens: (tokens && tokens.output) || null
    });
  } catch(e) { console.error('[google-log]', e.message); }
}

// ─── CRÉDITOS PRÉ-PAGOS ────────────────────────────────────────────────────────
// 1 crédito = 1 requisição ao Google. O usuário tem um total comprado (campo
// "creditos" no registro) e um consumo histórico (linhas 'geocoding' no log). Saldo
// = creditos - consumo. Pra não consultar o banco a cada pacote, o consumo de cada
// usuário é carregado uma vez (lazy) e mantido em memória, incrementado a cada chamada.
const usoGeocoding = {}; // usuario -> nº de requisições Google já feitas (histórico)

async function carregarUsoGeocoding(usuario) {
  if (typeof usoGeocoding[usuario] === 'number') return usoGeocoding[usuario];
  if (!SUPABASE_URL || !SUPABASE_KEY) { usoGeocoding[usuario] = 0; return 0; }
  try {
    const enc = encodeURIComponent(usuario);
    const r = await supabaseRequest('GET',
      `/rest/v1/google_api_log?usuario=eq.${enc}&api_type=eq.geocoding&select=id`,
      null, { 'Prefer': 'count=exact', 'Range': '0-0' });
    // Content-Range vem como "0-0/123" — o total fica depois da barra
    const cr = (r.headers && (r.headers['content-range'] || r.headers['Content-Range'])) || '';
    const total = parseInt((cr.split('/')[1] || '0'), 10);
    usoGeocoding[usuario] = Number.isFinite(total) ? total : 0;
  } catch(e) { console.error('[creditos uso]', e.message); usoGeocoding[usuario] = 0; }
  return usoGeocoding[usuario];
}

// saldo restante de um usuário (Infinity para admin = ilimitado)
async function saldoCreditos(usuarioRec) {
  if (!usuarioRec) return 0;
  if (usuarioRec.admin) return Infinity;
  const comprados = Number(usuarioRec.creditos) || 0;
  const usado = await carregarUsoGeocoding(usuarioRec.usuario);
  return comprados - usado;
}

// ─── PAGAMENTO (Mercado Pago — PIX) ────────────────────────────────────────────
function mpRequest(method, mpPath, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'Authorization': 'Bearer ' + MERCADOPAGO_TOKEN, 'Content-Type': 'application/json', ...(extraHeaders || {}) };
    if (payload) headers['Content-Length'] = payload.length;
    const req = https.request({ hostname: 'api.mercadopago.com', path: mpPath, method, headers }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => { let p; try { p = data ? JSON.parse(data) : {}; } catch(e) { p = data; } resolve({ status: r.statusCode, body: p }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── CUPONS DE DESCONTO ────────────────────────────────────────────────────────
const CUPONS_KEY = 'cfg:cupons';
async function getCupons() {
  const v = await supabaseGet(CUPONS_KEY);
  return Array.isArray(v) ? v : [];
}
async function setCupons(lista) { await supabaseSet(CUPONS_KEY, lista); }

// valida um código de cupom; devolve o cupom ou null
async function validarCupom(codigo) {
  if (!codigo) return null;
  const lista = await getCupons();
  const c = lista.find(x => x.codigo === String(codigo).trim().toUpperCase());
  if (!c) return null;
  if (c.usosMax > 0 && (c.usados || 0) >= c.usosMax) return null; // esgotado
  return c;
}
async function consumirCupom(codigo) {
  const lista = await getCupons();
  const c = lista.find(x => x.codigo === codigo);
  if (c) { c.usados = (c.usados || 0) + 1; await setCupons(lista); }
}
// monta um e-mail válido pro Mercado Pago: se o usuário JÁ é um e-mail, usa ele;
// senão limpa caracteres inválidos (espaço, acento, @ extra) e usa @packscan.app
function emailPagador(usuario) {
  const u = String(usuario || '').trim().toLowerCase();
  if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(u)) return u;
  const limpo = u.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+|[._-]+$/g, '') || 'cliente';
  return limpo + '@packscan.app';
}

function precoComCupom(preco, cupom) {
  if (!cupom) return preco;
  const v = Math.round(preco * (1 - cupom.pct / 100) * 100) / 100;
  return Math.max(0.01, v); // PIX não aceita valor zero
}

// aplica um pagamento aprovado — idempotente (só aplica 1x). Pode ser compra de
// créditos (rec.tipo='creditos') ou renovação do plano mensal (rec.tipo='plano').
// O lock em memória evita crédito em dobro quando o webhook e o polling do
// frontend confirmam o mesmo pagamento ao mesmo tempo.
// estende (ou ativa) o plano mensal de um usuário por N dias. Acumula se ainda
// estiver vigente. Usado tanto pelo PIX avulso quanto pela assinatura recorrente.
async function ativarPlano(usuario, dias) {
  const lista = await getUsuarios();
  const u = lista.find(x => x.usuario === usuario);
  if (!u) return false;
  const base = (u.planoAte && u.planoAte > Date.now()) ? u.planoAte : Date.now();
  u.planoProprio = true;
  u.planoAte = base + (dias || 30) * 24 * 60 * 60 * 1000;
  await setUsuarios(lista);
  return true;
}

// ─── INDICAÇÕES (referral) ─────────────────────────────────────────────────────
// código curto e estável por usuário (gerado 1x e guardado no registro)
function novoRefCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 chars
}
async function garantirRefCode(usuario) {
  const lista = await getUsuarios();
  const u = lista.find(x => x.usuario === usuario);
  if (!u) return null;
  if (!u.refCode) {
    let code; const usados = new Set(lista.map(x => x.refCode).filter(Boolean));
    do { code = novoRefCode(); } while (usados.has(code));
    u.refCode = code;
    await setUsuarios(lista);
  }
  return u.refCode;
}
function acharPorRefCode(lista, code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  return lista.find(x => x.refCode === c) || null;
}
// desconto de indicação disponível pro usuário (20% enquanto não foi consumido no 1º pagamento)
function descontoIndicacao(u) {
  return (u && u.indicadoPor && !u.indicacaoUsada) ? INDICACAO_PCT : 0;
}
// confirma a indicação do usuário que acabou de pagar (idempotente): marca o desconto como
// usado e credita quem indicou (20% acumulativo → a cada 5, 1 mês grátis).
async function confirmarIndicacao(usuarioPagante) {
  const lista = await getUsuarios();
  const u = lista.find(x => x.usuario === usuarioPagante);
  if (!u || !u.indicadoPor || u.indicacaoCreditada) return;
  u.indicacaoUsada = true;       // já aproveitou o desconto de 20%
  u.indicacaoCreditada = true;   // não credita o padrinho duas vezes
  const padrinho = acharPorRefCode(lista, u.indicadoPor) || lista.find(x => x.usuario === u.indicadoPor);
  if (padrinho && padrinho.usuario !== u.usuario) {
    padrinho.refTotal = (padrinho.refTotal || 0) + 1;         // histórico total
    padrinho.refPendentes = (padrinho.refPendentes || 0) + 1; // rumo ao próximo mês grátis
    while (padrinho.refPendentes >= INDICACOES_POR_MES_GRATIS) {
      padrinho.refPendentes -= INDICACOES_POR_MES_GRATIS;
      const base = (padrinho.planoAte && padrinho.planoAte > Date.now()) ? padrinho.planoAte : Date.now();
      padrinho.planoProprio = true;
      padrinho.planoAte = base + PLANO_MENSAL.dias * 24 * 60 * 60 * 1000;
      padrinho.refMesesGratis = (padrinho.refMesesGratis || 0) + 1;
      console.log(`[indicacao] ${padrinho.usuario} ganhou 1 mês grátis (${INDICACOES_POR_MES_GRATIS} indicações)`);
    }
    console.log(`[indicacao] confirmada: ${u.usuario} indicado por ${padrinho.usuario} (total ${padrinho.refTotal})`);
  }
  await setUsuarios(lista);
}

const _creditandoAgora = new Set();
async function creditarPagamento(mpId) {
  if (_creditandoAgora.has(mpId)) return await supabaseGet('pay:' + mpId);
  _creditandoAgora.add(mpId);
  try { return await _creditarPagamentoInterno(mpId); }
  finally { _creditandoAgora.delete(mpId); }
}
async function _creditarPagamentoInterno(mpId) {
  const rec = await supabaseGet('pay:' + mpId);
  if (!rec || rec.status === 'creditado') return rec; // já aplicado ou inexistente
  if (rec.tipo === 'plano') {
    await ativarPlano(rec.usuario, rec.dias || 30);
    await confirmarIndicacao(rec.usuario); // credita quem indicou (1ª vez só)
  } else {
    // compatibilidade: pagamentos de crédito antigos ainda são creditados
    const lista = await getUsuarios();
    const u = lista.find(x => x.usuario === rec.usuario);
    if (u) { u.creditos = (Number(u.creditos) || 0) + rec.creditos; await setUsuarios(lista); }
  }
  await supabaseSet('pay:' + mpId, { ...rec, status: 'creditado' });
  if (rec.cupom) await consumirCupom(rec.cupom); // desconta 1 uso do cupom
  console.log(`[pagamento] aprovado: ${rec.usuario} ${rec.tipo === 'plano' ? '+plano mensal' : '+'+rec.creditos+' créditos'} (R$ ${rec.preco}${rec.cupom ? ', cupom '+rec.cupom : ''})`);
  return { ...rec, status: 'creditado' };
}

function supabaseRequest(method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const host = SUPABASE_URL.replace('https://','').replace('http://','');
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...( extraHeaders || {} )
    };
    if (payload) headers['Content-Length'] = payload.length;
    const req = https.request({ hostname: host, path, method, headers }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; }
        catch(e) { parsed = data; }
        resolve({ status: r.statusCode, body: parsed, headers: r.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── AUTENTICAÇÃO ───────────────────────────────────────────────────────────
const crypto = require('crypto');
const AUTH_SECRET = process.env.AUTH_SECRET || (() => {
  console.warn('[auth] AUTH_SECRET não definido — usando segredo de desenvolvimento (tokens somem a cada deploy)');
  return 'packscan-dev-secret-troque-em-producao';
})();
const AUTH_USUARIOS_KEY = 'auth:usuarios';
const TOKEN_VALIDADE_MS = 24 * 60 * 60 * 1000; // 1 dia — login diário obrigatório

async function getUsuarios() {
  const v = await supabaseGet(AUTH_USUARIOS_KEY);
  return Array.isArray(v) ? v : [];
}
async function setUsuarios(lista) {
  await supabaseSet(AUTH_USUARIOS_KEY, lista);
}

function hashSenha(senha, saltHex) {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function senhaConfere(senha, hashArmazenado) {
  if (!hashArmazenado || hashArmazenado.indexOf(':') === -1) return false;
  const [salt, hashOriginal] = hashArmazenado.split(':');
  const hashTentativa = crypto.scryptSync(senha, salt, 64).toString('hex');
  const a = Buffer.from(hashOriginal, 'hex'), b = Buffer.from(hashTentativa, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── CONFIRMAÇÃO DE E-MAIL (Brevo) ─────────────────────────────────────────────
const EMAIL_ATIVO = !!(BREVO_API_KEY && BREVO_SENDER); // só exige confirmação se configurado
const EMAIL_CODIGO_VALIDADE_MS = 15 * 60 * 1000; // 15 minutos
function emailValido(e) { return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(e || '').trim()); }
function gerarCodigo6() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function hashCodigo(c) { return crypto.createHash('sha256').update(String(c) + '|' + AUTH_SECRET).digest('hex'); }

// envia um e-mail transacional pela API do Brevo
function enviarEmailBrevo(to, subject, html) {
  return new Promise(resolve => {
    if (!EMAIL_ATIVO) return resolve({ ok: false, motivo: 'e-mail não configurado' });
    const payload = Buffer.from(JSON.stringify({
      sender: { name: BREVO_SENDER_NOME, email: BREVO_SENDER },
      to: [{ email: to }],
      subject, htmlContent: html
    }));
    const r = https.request({
      hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': payload.length }
    }, resp => {
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => resolve({ ok: resp.statusCode < 300, status: resp.statusCode, body: d }));
    });
    r.on('error', e => resolve({ ok: false, motivo: e.message }));
    r.write(payload); r.end();
  });
}

// gera um código novo pro usuário, salva o hash+validade e dispara o e-mail
async function enviarCodigoEmail(u) {
  const codigo = gerarCodigo6();
  u.emailCodigoHash = hashCodigo(codigo);
  u.emailCodigoExp = Date.now() + EMAIL_CODIGO_VALIDADE_MS;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:460px;margin:0 auto;padding:24px;background:#0e1424;color:#e8ecf3;border-radius:12px">
      <div style="font-size:20px;font-weight:700;letter-spacing:1px;margin-bottom:8px">PACK<span style="color:#4f8ef7">SCAN</span></div>
      <p style="color:#aab3c5">Seu código de confirmação de cadastro é:</p>
      <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#4f8ef7;text-align:center;margin:18px 0">${codigo}</div>
      <p style="color:#7b869c;font-size:13px">Ele vale por 15 minutos. Se não foi você, ignore este e-mail.</p>
    </div>`;
  const r = await enviarEmailBrevo(u.email, 'Seu código PackScan: ' + codigo, html);
  return r;
}

function base64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function base64urlDecode(str) { return Buffer.from(str.replace(/-/g,'+').replace(/_/g,'/'), 'base64'); }

function gerarToken(usuario, admin) {
  const exp = Date.now() + TOKEN_VALIDADE_MS; // login diário
  const payload = JSON.stringify({ u: usuario, a: !!admin, exp });
  const payloadB64 = base64url(payload);
  const assinatura = base64url(crypto.createHmac('sha256', AUTH_SECRET).update(payloadB64).digest());
  return `${payloadB64}.${assinatura}`;
}
function verificarToken(token) {
  if (!token || token.indexOf('.') === -1) return null;
  const [payloadB64, assinatura] = token.split('.');
  const esperada = base64url(crypto.createHmac('sha256', AUTH_SECRET).update(payloadB64).digest());
  const a = Buffer.from(assinatura), b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return { usuario: payload.u, admin: !!payload.a };
  } catch(e) { return null; }
}

async function autenticar(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return verificarToken(token);
}

// ─── PROTEÇÃO CONTRA FORÇA BRUTA NO LOGIN ─────────────────────────────────────
// 5 senhas erradas seguidas (por IP+usuário) bloqueia novas tentativas por 15 min.
// Em memória: zera num restart do servidor, o que é aceitável pra este fim.
const loginFalhas = {}; // "ip|usuario" -> { erros, bloqueadoAte }
const LOGIN_MAX_ERROS = 5;
const LOGIN_BLOQUEIO_MS = 15 * 60 * 1000;

function ipDoRequest(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || 'ip-desconhecido';
}
function loginBloqueadoAte(chave) {
  const rec = loginFalhas[chave];
  if (!rec || !rec.bloqueadoAte) return 0;
  if (rec.bloqueadoAte <= Date.now()) { delete loginFalhas[chave]; return 0; } // bloqueio venceu
  return rec.bloqueadoAte;
}
function registrarFalhaLogin(chave) {
  const rec = loginFalhas[chave] || (loginFalhas[chave] = { erros: 0, bloqueadoAte: 0 });
  rec.erros++;
  if (rec.erros >= LOGIN_MAX_ERROS) {
    rec.bloqueadoAte = Date.now() + LOGIN_BLOQUEIO_MS;
    console.warn(`[auth] bloqueio por força bruta: ${chave} (${rec.erros} erros)`);
  }
}

// ─── PASSO 1: rua pelo CEP via Google ────────────────────────────────────────
// Correios (ViaCEP) muitas vezes sabem o logradouro oficial de um CEP mesmo quando o
// reverse-geocode do Google só retorna nível de bairro (sem componente "route")
async function buscarRuaViaCep(cep) {
  try {
    const d = await httpsGet('viacep.com.br', `/ws/${cep}/json/`);
    if (d && !d.erro && d.logradouro) return { rua: d.logradouro, bairro: d.bairro || '', cidade: d.localidade || '' };
  } catch(e) { console.error(`[viacep] erro ${cep}:`, e.message); }
  return null;
}

// ─── BANCO DE ENDEREÇOS LOCAL (CNEFE) ─────────────────────────────────────────
// pega só o primeiro número do texto (o número da casa), pra casar com o CNEFE
function numeroDoTexto(t) {
  const m = String(t || '').match(/\d+/);
  return m ? m[0] : '';
}
// busca instantânea no banco local por CEP + número. Se o número exato não existir,
// pega o número MAIS PRÓXIMO na mesma CEP (CNEFE é denso → ótima aproximação).
async function buscarCnefe(cepDigitos, numero) {
  if (!cepDigitos || cepDigitos.length !== 8 || !numero) return null;
  const exato = await supabaseGet('cnefe:' + cepDigitos + ':' + numero);
  if (exato && exato.lat) return exato;
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const r = await supabaseRequest('GET',
      `/rest/v1/geo_cache?cache_key=like.${encodeURIComponent('cnefe:' + cepDigitos + ':*')}&select=cache_key,coord_data&limit=800`);
    if (r.status >= 300 || !Array.isArray(r.body) || !r.body.length) return null;
    const alvo = parseInt(numero, 10);
    if (!isFinite(alvo)) return null;
    let best = null, bd = Infinity;
    for (const row of r.body) {
      const c = row.coord_data; if (!c || c.lat == null) continue;
      const n = parseInt((String(row.cache_key).split(':')[2] || ''), 10);
      if (!isFinite(n)) continue;
      const d = Math.abs(n - alvo);
      if (d < bd) { bd = d; best = c; }
    }
    // só aceita se o vizinho estiver razoavelmente perto (mesmo trecho da rua)
    if (best && bd <= 200) return { ...best, precisao: 'CNEFE_APROX' };
  } catch(e) { console.error('[cnefe-aprox]', e.message); }
  return null;
}

// importa uma cidade do CNEFE pro cache (chaves cnefe:cep:numero). Retorna o resumo.
// job (opcional) recebe diagnósticos: bytes, linhas, parseados, feito/total.
async function importarCnefe(cidade, onProgress, job) {
  const buf = await httpsGetBuffer(CNEFE_BASE + cidade.arq);
  if (job) job.bytes = buf.length;
  const csv = unzipPrimeiroArquivo(buf).toString('utf8');
  const linhas = csv.split(/\r?\n/);
  if (job) job.linhas = linhas.length;
  const head = linhas[0].split(';').map(s => s.trim());
  const col = n => head.indexOf(n);
  const iCep = col('CEP'), iTipo = col('NOM_TIPO_SEGLOGR'), iTit = col('NOM_TITULO_SEGLOGR'),
        iNome = col('NOM_SEGLOGR'), iNum = col('NUM_ENDERECO'), iLoc = col('DSC_LOCALIDADE'),
        iLat = col('LATITUDE'), iLng = col('LONGITUDE');
  const mapa = new Map(); // cnefe:cep:numero -> coord_data (dedup, último vence)
  for (let k = 1; k < linhas.length; k++) {
    const p = linhas[k].split(';');
    if (p.length < head.length) continue;
    const cep = (p[iCep] || '').replace(/\D/g, '');
    const numero = (p[iNum] || '').trim();
    const lat = parseFloat(p[iLat]), lng = parseFloat(p[iLng]);
    if (cep.length !== 8 || !numero || numero === '0' || !isFinite(lat) || !isFinite(lng)) continue;
    const logradouro = [p[iTipo], p[iTit], p[iNome]].map(s => (s || '').trim()).filter(Boolean).join(' ');
    mapa.set('cnefe:' + cep + ':' + numero, { lat, lng, logradouro, bairro: (p[iLoc] || '').trim(), cidade: cidade.nome });
  }
  // grava em lote na geo_cache (batches de 1000)
  const linhasCache = [];
  for (const [cache_key, coord_data] of mapa) linhasCache.push({ cache_key, coord_data });
  if (job) { job.parseados = linhasCache.length; job.total = linhasCache.length; job.colunas = { iCep, iNum, iLat, iLng }; }
  if (!linhasCache.length) {
    throw new Error(`0 endereços parseados (bytes ${job ? job.bytes : '?'}, linhas ${linhas.length}, colunas cep/num/lat/lng=${iCep}/${iNum}/${iLat}/${iLng})`);
  }
  let gravados = 0;
  for (let i = 0; i < linhasCache.length; i += 1000) {
    const lote = linhasCache.slice(i, i + 1000);
    // upsert: se a chave já existir (reimport), atualiza em vez de quebrar com 409
    const resp = await supabaseRequest('POST', '/rest/v1/geo_cache', lote, { 'Prefer': 'resolution=merge-duplicates,return=minimal' });
    if (resp && resp.status >= 300) throw new Error(`Supabase rejeitou (HTTP ${resp.status}): ${JSON.stringify(resp.body).substring(0,160)}`);
    gravados += lote.length;
    if (job) job.feito = gravados;
    if (onProgress) onProgress(gravados, linhasCache.length);
  }
  return { cidade: cidade.nome, enderecos: gravados };
}

async function ruaPeloCep(cep, ctx) {
  if (!cep || cep.length !== 8) return { rua: '', bairro: '', cidade: '' };
  const cepKey = 'cep:' + cep;
  const cached = await supabaseGet(cepKey);
  if (cached && (cached.rua || cached.manual)) { console.log(`[cep-cache] ${cep}`); return cached; }

  let resultado = cached || { rua: '', bairro: '', cidade: '' };
  const cepFmt = `${cep.substring(0,5)}-${cep.substring(5)}`;
  const query = encodeURIComponent(`${cepFmt}, Brasil`);
  try {
    const d = await httpsGet('maps.googleapis.com',
      `/maps/api/geocode/json?address=${query}&key=${(ctx && ctx.googleKey) || GOOGLE_KEY}&language=pt-BR&region=BR`
    );
    // chamada real ao Google (passou do cache de CEP) — conta no contador.
    // chave própria (plano) é registrada com tipo separado: não gasta crédito nem entra no custo do admin
    logGoogleCall(ctx && ctx.usuario, cep, (ctx && ctx.googleKey) ? 'geocoding_propria' : 'geocoding');
    if (ctx && (d.status === 'REQUEST_DENIED' || d.status === 'OVER_QUERY_LIMIT' || d.status === 'OVER_DAILY_LIMIT')) {
      ctx.googleErro = { status: d.status, msg: d.error_message || '' };
      console.error(`[google] chave recusada no CEP (${d.status}): ${d.error_message || ''}`);
    }
    if (d.status === 'OK' && d.results[0]) {
      const comps = d.results[0].address_components;
      const get = type => (comps.find(c => c.types.includes(type)) || {}).long_name || '';
      const lat = d.results[0].geometry.location.lat;
      const lng = d.results[0].geometry.location.lng;
      const estado = get('administrative_area_level_1');
      // valida que é SC e Grande Florianópolis
      if ((estado === 'Santa Catarina' || estado === 'SC') && lat >= -28.5 && lat <= -26.5) {
        resultado = {
          rua: get('route'),
          bairro: get('sublocality_level_1') || get('sublocality') || get('neighborhood'),
          cidade: get('administrative_area_level_2'),
          lat, lng
        };
      } else {
        console.log(`[cep] ${cep} → resultado inválido (${estado}) — ignorado`);
      }
    }
  } catch(e) { console.error(`[cep] erro ${cep}:`, e.message); }

  // Google não trouxe rua (CEP genérico de bairro) — tenta nos Correios antes de desistir
  if (!resultado.rua) {
    const viaCep = await buscarRuaViaCep(cep);
    if (viaCep && viaCep.rua) {
      resultado = { ...resultado, rua: viaCep.rua, bairro: resultado.bairro || viaCep.bairro, cidade: resultado.cidade || viaCep.cidade };
    }
  }

  if (resultado.rua || resultado.lat) {
    await supabaseSet(cepKey, resultado);
    console.log(`[cep] ${cep} → ${resultado.rua || '(sem rua)'}, ${resultado.cidade}`);
  }
  return resultado;
}

// ─── PASSO 2: IA extrai rua bruta + número/complemento ────────────────────────
function extrairNumeroLocal(complemento) {
  let c = (complemento || '')
    .replace(/portão|portao|branco|preto|amarelo|azul|verde|fundo|frente|lateral|descendo|subindo|referencia|ref\.|obs\.|entregar|fachada/gi, '')
    .replace(/CPF[\s:]*[\d.\-]+/gi, '')
    .replace(/\s{2,}/g, ' ').trim();
  c = c.replace(/^(Rua|Av|Avenida|Travessa|Alameda)\s+[^,\d]+[,\s]+/i, '').trim();
  const nums = c.match(/\d[\d\s]*(?:ap(?:to)?\.?\s*\d+)?(?:\s*bloco\s*\w+)?/i);
  if (nums) return { rua: '', complemento: nums[0].trim() };
  const ql = extrairQuadraLote(complemento);
  if (ql) return { rua: '', complemento: ql };
  return { rua: '', complemento: c.substring(0, 30) || 'S/N' };
}

function limparPrefixoNumero(c) {
  return c.replace(/\b(n[uú]mero|n[º°]\.?|n\.)\s*/gi, '').trim();
}

function complementoValido(c) {
  if (!c) return false;
  if (c.length > 40) return false;
  if (/identificad|informa[cç][aã]o dispon[íi]vel|n[aã]o h[aá]\b|nenhum|sem n[uú]mero|fornecido|n[aã]o (foi|encontr)/i.test(c)) return false;
  return true;
}

// rede de segurança determinística: pega quadra/lote do texto bruto mesmo que a IA não tenha pego
function extrairQuadraLote(textoBruto) {
  const qd = textoBruto.match(/\b(?:quadra|qd|q)\.?\s*(\w+)/i);
  const lt = textoBruto.match(/\b(?:lote|lt)\.?\s*(\w+)/i);
  if (!qd && !lt) return '';
  return [qd ? `Quadra ${qd[1]}` : '', lt ? `Lote ${lt[1]}` : ''].filter(Boolean).join(', ');
}

async function extrairInfoIA(textoBruto, ruaCep, ctx) {
  textoBruto = textoBruto || '';
  if (!textoBruto.trim()) return { rua: '', complemento: 'S/N' };
  // chave da IA: usa a do usuário (plano próprio) se houver; se for plano próprio sem
  // chave de IA, NÃO cai na chave global (usa extração por regex, sem custo pro admin)
  const anthropicKey = (ctx && ctx.anthropicKey) || (ctx && ctx.forcarChavePropria ? '' : ANTHROPIC_KEY);
  if (!anthropicKey) return extrairNumeroLocal(textoBruto);

  const prompt = `Você recebe o texto bruto de um endereço de entrega. Extraia duas coisas e responda em JSON.

Rua já conhecida pelo CEP (pode estar errada ou vazia): "${ruaCep || ''}"
Texto bruto do endereço: "${textoBruto}"

Extraia:
1. "rua": se o texto bruto MENCIONAR um nome de rua/avenida (ex: "Rua Antônio Jovita Duarte", "Av Lisboa"), copie esse nome exatamente como está escrito (mesmo com pequenos erros de digitação), SEM o número. Se o texto bruto não mencionar nenhuma rua, deixe "".
2. "complemento": o identificador necessário para localizar o imóvel — NUNCA deixe vazio se houver QUALQUER informação útil, e PROCURE ATIVAMENTE por quadra/lote no texto antes de desistir. Use esta prioridade:
   - Número da casa/prédio: escreva SÓ o número puro, sem a palavra "Número"/"Nº"/"N." na frente: "158 casa 2" → "158, Casa 2" (NUNCA "Número 158, Casa 2")
   - Apartamento/Bloco: "3147 ap 201 bloco 23" → "3147, Ap 201, Bloco 23"
   - Quadra/Lote — SEMPRE que aparecer "Q", "QD", "Quadra", "LT" ou "Lote" no texto, mesmo sem número de casa, mesmo abreviado ou colado em outras palavras: "Q39" → "Quadra 39" | "s/n Q 49 LT 01" → "Quadra 49, Lote 1" | "quadra 04 lote 12" → "Quadra 4, Lote 12"
   - Nome de comércio/loja/condomínio quando não há número nem quadra/lote: "Loja Space Car Filmes" → "Loja Space Car Filmes" | "Agropecuária da Família" → "Agropecuária da Família"
   - Se DE FATO não houver nenhum número, quadra/lote ou nome de comércio em lugar nenhum do texto, use exatamente "S/N" (nunca escreva frases explicando que não achou nada — só "S/N").
   Remova: cores de portão, referências, CPF, nomes de pessoas, observações de entrega (ex: "deixar com vizinho").

Responda APENAS com um JSON válido de uma linha, sem markdown: {"rua":"...","complemento":"..."}`;

  try {
    const result = await httpsPost('api.anthropic.com', '/v1/messages',
      { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 150, messages: [{ role: 'user', content: prompt }] })
    );
    // chamada real à API da Anthropic — conta no contador com os tokens usados (pra estimar custo).
    // chave própria (plano) tem tipo separado: não entra no custo do admin
    logGoogleCall(ctx && ctx.usuario, ctx && ctx.cep, (ctx && ctx.anthropicKey) ? 'anthropic_propria' : 'anthropic', {
      input: (result.usage && result.usage.input_tokens) || 0,
      output: (result.usage && result.usage.output_tokens) || 0
    });
    const texto = result.content?.[0]?.text?.trim() || '';
    const match = texto.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      const complBruto = limparPrefixoNumero((parsed.complemento || '').trim());
      let compl = complementoValido(complBruto) ? complBruto : 'S/N';
      if (compl === 'S/N') {
        const ql = extrairQuadraLote(textoBruto);
        if (ql) compl = ql;
      }
      console.log(`[ia] "${textoBruto.substring(0,30)}" → rua:"${parsed.rua||''}" compl:"${compl}"`);
      return { rua: (parsed.rua || '').trim(), complemento: compl };
    }
  } catch(e) { console.error('[ia] erro:', e.message); }
  return extrairNumeroLocal(textoBruto);
}


// ─── PASSO 3: geocodifica endereço completo ───────────────────────────────────
function distanciaKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// quando a rua usada na busca veio de uma fonte indireta (CEP, cache, sugestão de pacote
// vizinho), o Google às vezes "corrige" o nome pra uma rua homônima/parecida em outro bairro
// inteiro — descarta o resultado se ficar longe demais do ponto conhecido do CEP
async function geocodificarValidado(enderecoCompleto, cepInfo, ctx) {
  const coord = await geocodificarEndereco(enderecoCompleto, ctx);
  if (coord && cepInfo && cepInfo.lat) {
    const d = distanciaKm(coord.lat, coord.lng, cepInfo.lat, cepInfo.lng);
    // se o ponto do CEP já foi corrigido manualmente, é uma referência precisa (não um
    // centroide aproximado do Google) — exige proximidade bem maior antes de confiar num
    // resultado de texto/cache que possa ser uma rua homônima errada
    const limite = cepInfo.manual ? 1 : 4;
    if (d > limite) {
      console.log(`[geocode] descartado (${d.toFixed(1)}km do CEP): ${enderecoCompleto}`);
      return null;
    }
  }
  return coord;
}

async function geocodificarEndereco(enderecoCompleto, ctx) {
  const query = encodeURIComponent(enderecoCompleto);
  const d = await httpsGet('maps.googleapis.com',
    `/maps/api/geocode/json?address=${query}&key=${(ctx && ctx.googleKey) || GOOGLE_KEY}&language=pt-BR&region=BR`
  );
  // chamada real ao Google (passou do cache de endereço) — conta no contador.
  // chave própria (plano) é registrada com tipo separado: não gasta crédito nem entra no custo do admin
  logGoogleCall(ctx && ctx.usuario, ctx && ctx.cep, (ctx && ctx.googleKey) ? 'geocoding_propria' : 'geocoding');
  // chave recusada / sem cota / faturamento desligado → registra no ctx pra avisar o usuário
  if (ctx && (d.status === 'REQUEST_DENIED' || d.status === 'OVER_QUERY_LIMIT' || d.status === 'OVER_DAILY_LIMIT')) {
    ctx.googleErro = { status: d.status, msg: d.error_message || '' };
    console.error(`[google] chave recusada (${d.status}): ${d.error_message || ''}`);
  }
  if (d.status !== 'OK' || !d.results[0]) return null;
  const r = d.results[0];
  const comps = r.address_components;
  const get = type => (comps.find(c => c.types.includes(type)) || {}).long_name || '';
  return {
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
    enderecoFormatado: r.formatted_address,
    logradouro: get('route'),
    bairro: get('sublocality_level_1') || get('sublocality') || get('neighborhood'),
    cidade: get('administrative_area_level_2'),
    precisao: r.geometry.location_type
  };
}

// ─── CORREÇÕES DE NOME DE RUA (lista global "errado → certo") ──────────────────
const CFG_NOMES_KEY = 'cfg:nomes';

async function getCorrecoesNome() {
  const v = await supabaseGet(CFG_NOMES_KEY);
  return Array.isArray(v) ? v : [];
}
async function setCorrecoesNome(lista) {
  await supabaseSet(CFG_NOMES_KEY, lista);
}

function escRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// substitui o nome errado pelo certo respeitando limite de "palavra" (com acento):
// "jacob" → "jacobe" NÃO afeta "jacobe" (que já está certo), graças aos lookarounds.
function aplicarCorrecoesNome(endereco, lista) {
  if (!endereco || !lista || !lista.length) return endereco;
  let out = endereco;
  for (const c of lista) {
    if (!c || !c.de || !c.para) continue;
    try {
      const re = new RegExp('(?<![\\p{L}\\p{N}])' + escRegex(c.de.trim()) + '(?![\\p{L}\\p{N}])', 'giu');
      out = out.replace(re, c.para);
    } catch(e) {
      // fallback sem lookaround/unicode caso o runtime não suporte
      const re = new RegExp('\\b' + escRegex(c.de.trim()) + '\\b', 'gi');
      out = out.replace(re, c.para);
    }
  }
  return out;
}

// ─── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // rotas de API que não exigem login (login/registro em si)
  const AUTH_PUBLICA = new Set(['/api/auth/login', '/api/auth/registrar', '/api/auth/verificar-email', '/api/auth/reenviar-email', '/api/pagamento/webhook', '/api/escala/dados']);
  // rotas que, além de logado, exigem admin
  const SOMENTE_ADMIN = new Set(['/api/cache/clear', '/api/pacotes/apagar', '/api/cep/excluir', '/api/nomes/remover', '/api/rotas/apagar', '/api/admin/google-usage', '/api/admin/cupons', '/api/admin/cupons/remover', '/api/admin/cnefe', '/api/admin/cnefe/importar', '/api/admin/cnefe/status', '/api/auth/pendentes', '/api/auth/usuarios', '/api/auth/creditos', '/api/auth/aprovar', '/api/auth/rejeitar']);

  if (pathname.indexOf('/api/') === 0 && !AUTH_PUBLICA.has(pathname)) {
    const usuarioAtual = await autenticar(req);
    if (!usuarioAtual) return json(res, 401, { error: 'Não autenticado' });
    if (SOMENTE_ADMIN.has(pathname) && !usuarioAtual.admin) return json(res, 403, { error: 'Apenas administradores podem fazer isso' });
    req.usuarioAtual = usuarioAtual;
  }

  // ─── AUTENTICAÇÃO: registro, login e aprovação ─────────────────────────────
  if (req.method === 'POST' && pathname === '/api/auth/registrar') {
    const body = await readBody(req);
    const usuario = (body.usuario || '').trim().toLowerCase();
    const senha = body.senha || '';
    const email = (body.email || '').trim().toLowerCase();
    if (!usuario || senha.length < 4) return json(res, 400, { error: 'Usuário obrigatório e senha com pelo menos 4 caracteres' });
    // com o e-mail configurado, ele é obrigatório e válido (é o que confirma a conta)
    if (EMAIL_ATIVO && !emailValido(email)) return json(res, 400, { error: 'Informe um e-mail válido para confirmar o cadastro' });
    const lista = await getUsuarios();
    if (lista.some(u => u.usuario === usuario)) return json(res, 409, { error: 'Usuário já existe' });
    // primeiro usuário cadastrado no sistema nasce admin e já aprovado, pra alguém
    // conseguir entrar e aprovar os próximos
    const ehPrimeiro = lista.length === 0;
    // código de indicação (opcional): guarda quem indicou pra aplicar os 20% no 1º pagamento
    const refCode = String(body.ref || '').trim().toUpperCase();
    const padrinho = refCode ? acharPorRefCode(lista, refCode) : null;
    const indicadoPor = (padrinho && padrinho.usuario !== usuario) ? padrinho.refCode : null;
    // cadastro automático: aprovado na hora (sem admin). O e-mail confirmado é o gate.
    const novo = {
      usuario, senhaHash: hashSenha(senha),
      email: email || null,
      emailVerificado: EMAIL_ATIVO ? ehPrimeiro : true, // se e-mail não configurado, não exige
      status: 'aprovado',
      admin: ehPrimeiro,
      creditos: CREDITOS_BOAS_VINDAS, // créditos grátis pra testar
      indicadoPor, // refCode de quem indicou (ou null)
      criadoEm: new Date().toISOString()
    };
    let emailEnviado = false;
    if (EMAIL_ATIVO && !novo.emailVerificado) {
      const r = await enviarCodigoEmail(novo);
      emailEnviado = !!(r && r.ok);
      if (!emailEnviado) console.error('[auth] falha ao enviar e-mail de confirmação:', r && (r.body || r.motivo));
    }
    lista.push(novo);
    await setUsuarios(lista);
    console.log(`[auth] registro: ${usuario}${ehPrimeiro ? ' (primeiro usuário → admin)' : ` (auto-aprovado, +${CREDITOS_BOAS_VINDAS} créditos)`}${novo.emailVerificado ? '' : ' — aguardando confirmação de e-mail'}`);
    return json(res, 200, { ok: true, pendente: false, creditosGratis: CREDITOS_BOAS_VINDAS, precisaEmail: EMAIL_ATIVO && !novo.emailVerificado, emailEnviado });
  }

  // ─── AUTENTICAÇÃO: confirma o código de e-mail ─────────────────────────────
  if (req.method === 'POST' && pathname === '/api/auth/verificar-email') {
    const body = await readBody(req);
    const usuario = (body.usuario || '').trim().toLowerCase();
    const codigo = String(body.codigo || '').trim();
    const lista = await getUsuarios();
    const u = lista.find(x => x.usuario === usuario);
    if (!u) return json(res, 404, { error: 'Usuário não encontrado' });
    if (u.emailVerificado) return json(res, 200, { ok: true, jaConfirmado: true });
    if (!u.emailCodigoHash || !u.emailCodigoExp || Date.now() > u.emailCodigoExp) {
      return json(res, 400, { error: 'Código expirado. Reenvie um novo código.' });
    }
    if (hashCodigo(codigo) !== u.emailCodigoHash) return json(res, 400, { error: 'Código incorreto.' });
    u.emailVerificado = true;
    delete u.emailCodigoHash; delete u.emailCodigoExp;
    await setUsuarios(lista);
    console.log(`[auth] e-mail confirmado: ${usuario}`);
    return json(res, 200, { ok: true, pendente: u.status !== 'aprovado' });
  }

  // ─── AUTENTICAÇÃO: reenvia o código de e-mail ──────────────────────────────
  if (req.method === 'POST' && pathname === '/api/auth/reenviar-email') {
    const body = await readBody(req);
    const usuario = (body.usuario || '').trim().toLowerCase();
    const lista = await getUsuarios();
    const u = lista.find(x => x.usuario === usuario);
    if (!u) return json(res, 404, { error: 'Usuário não encontrado' });
    if (u.emailVerificado) return json(res, 200, { ok: true, jaConfirmado: true });
    if (!EMAIL_ATIVO || !u.email) return json(res, 400, { error: 'E-mail não disponível para este usuário.' });
    const r = await enviarCodigoEmail(u);
    await setUsuarios(lista);
    if (!(r && r.ok)) return json(res, 502, { error: 'Não foi possível reenviar o e-mail agora.' });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readBody(req);
    const usuario = (body.usuario || '').trim().toLowerCase();
    const senha = body.senha || '';
    // proteção contra força bruta: bloqueia depois de muitas senhas erradas
    const chaveLogin = ipDoRequest(req) + '|' + usuario;
    const bloqueadoAte = loginBloqueadoAte(chaveLogin);
    if (bloqueadoAte) {
      const min = Math.ceil((bloqueadoAte - Date.now()) / 60000);
      return json(res, 429, { error: `Muitas tentativas erradas. Tente de novo em ${min} minuto(s).` });
    }
    const lista = await getUsuarios();
    const u = lista.find(x => x.usuario === usuario);
    if (!u || !senhaConfere(senha, u.senhaHash)) {
      registrarFalhaLogin(chaveLogin);
      return json(res, 401, { error: 'Usuário ou senha inválidos' });
    }
    delete loginFalhas[chaveLogin]; // acertou a senha — zera o contador
    if (u.emailVerificado === false) return json(res, 403, { error: 'Confirme seu e-mail antes de entrar.', emailNaoVerificado: true, usuario: u.usuario });
    if (u.status !== 'aprovado') return json(res, 403, { error: 'Cadastro ainda não foi aprovado por um administrador' });
    const saldoLogin = await saldoCreditos(u);
    return json(res, 200, {
      ok: true, token: gerarToken(u.usuario, u.admin), usuario: u.usuario, admin: !!u.admin,
      creditos: saldoLogin === Infinity ? null : Math.max(0, saldoLogin),
      planoAtivo: !!(u.planoProprio && u.planoAte && u.planoAte > Date.now()),
      planoAte: u.planoAte || null
    });
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const lista = await getUsuarios();
    const u = lista.find(x => x.usuario === req.usuarioAtual.usuario);
    const saldo = await saldoCreditos(u);
    return json(res, 200, {
      usuario: req.usuarioAtual.usuario, admin: req.usuarioAtual.admin,
      creditos: saldo === Infinity ? null : Math.max(0, saldo), // null = ilimitado (admin)
      planoProprio: !!(u && u.planoProprio),
      planoAte: (u && u.planoAte) || null,
      planoAtivo: !!(u && u.planoProprio && u.planoAte && u.planoAte > Date.now()),
      indicacaoDesconto: descontoIndicacao(u), // 20 se tem desconto de indicação disponível
      temGoogleKey: !!(u && u.googleKey),
      temAnthropicKey: !!(u && u.anthropicKey)
    });
  }

  // ─── ROTEIRIZAÇÃO por ruas reais (OSRM) — ordena os pontos de uma rota ──────
  // Responde { ok:true, ordem:[...] } ou { ok:false }. O cliente cai no 2-opt
  // local quando ok:false, então nunca quebra a roteirização.
  if (req.method === 'POST' && pathname === '/api/otimizar') {
    const body = await readBody(req);
    const pts = Array.isArray(body.pontos) ? body.pontos.filter(p => p && p.lat && p.lng) : [];
    if (pts.length < 3) return json(res, 200, { ok: false, error: 'poucos pontos' });
    try {
      const t0 = Date.now();
      const ordem = await otimizarOSRM(pts, body.ini || null, body.fim || null);
      return json(res, 200, { ok: true, ordem, ms: Date.now() - t0, n: pts.length });
    } catch (e) {
      return json(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
  }

  // traçado da rota PELAS RUAS (geometria do OSRM) — pra desenhar a linha certa
  if (req.method === 'POST' && pathname === '/api/rota-linha') {
    const body = await readBody(req);
    const pts = Array.isArray(body.pontos) ? body.pontos.filter(p => p && p.lat && p.lng) : [];
    if (pts.length < 2) return json(res, 200, { ok: false });
    try {
      const geo = await osrmRoute(pts.map(p => [p.lng, p.lat]));
      // OSRM devolve [lng,lat]; o mapa (Leaflet) quer [lat,lng]
      return json(res, 200, { ok: true, linha: geo.map(c => [c[1], c[0]]) });
    } catch (e) {
      return json(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
  }

  // teste rápido do OSRM (admin) — confirma que o servidor alcança o motor de rotas
  if (req.method === 'GET' && pathname === '/api/otimizar/teste') {
    try {
      const t0 = Date.now();
      const ordem = await otimizarOSRM(
        [{ lat: -27.60, lng: -48.66 }, { lat: -27.59, lng: -48.55 }, { lat: -27.61, lng: -48.62 }],
        null, null);
      return json(res, 200, { ok: true, ordem, ms: Date.now() - t0, osrm: OSRM_URL });
    } catch (e) {
      return json(res, 200, { ok: false, error: String((e && e.message) || e), osrm: OSRM_URL });
    }
  }

  // ─── CHAVES: o usuário salva as próprias chaves de API (plano próprio) ──────
  if (req.method === 'POST' && pathname === '/api/auth/chaves') {
    const body = await readBody(req);
    const lista = await getUsuarios();
    const u = lista.find(x => x.usuario === req.usuarioAtual.usuario);
    if (!u) return json(res, 404, { error: 'Usuário não encontrado' });
    // envia "" pra limpar; undefined mantém o que já tem
    if (typeof body.googleKey === 'string') u.googleKey = body.googleKey.trim();
    if (typeof body.anthropicKey === 'string') u.anthropicKey = body.anthropicKey.trim();
    await setUsuarios(lista);
    console.log(`[chaves] ${u.usuario} atualizou suas chaves de API`);
    return json(res, 200, { ok: true, temGoogleKey: !!u.googleKey, temAnthropicKey: !!u.anthropicKey });
  }

  // ─── CHAVES: testa uma chave do Google (geocodifica um endereço conhecido) ──
  if (req.method === 'POST' && pathname === '/api/chaves/testar') {
    const body = await readBody(req);
    const gkey = (body.googleKey || '').trim();
    if (!gkey) return json(res, 400, { error: 'Informe a chave do Google para testar.' });
    try {
      const d = await httpsGet('maps.googleapis.com',
        `/maps/api/geocode/json?address=${encodeURIComponent('Avenida Paulista, São Paulo')}&key=${gkey}&language=pt-BR`);
      if (d.status === 'OK') return json(res, 200, { ok: true });
      const msg = d.error_message || d.status || 'chave inválida';
      return json(res, 200, { ok: false, erro: msg });
    } catch(e) { return json(res, 200, { ok: false, erro: e.message }); }
  }

  // ─── CRÉDITOS: admin recarrega o saldo de um usuário ───────────────────────
  if (req.method === 'POST' && pathname === '/api/auth/creditos') {
    const body = await readBody(req);
    const usuario = (body.usuario || '').trim().toLowerCase();
    const adicionar = Number(body.adicionar);
    if (!Number.isFinite(adicionar)) return json(res, 400, { error: 'adicionar inválido' });
    const lista = await getUsuarios();
    const u = lista.find(x => x.usuario === usuario);
    if (!u) return json(res, 404, { error: 'Usuário não encontrado' });
    u.creditos = Math.max(0, (Number(u.creditos) || 0) + adicionar);
    await setUsuarios(lista);
    const usado = await carregarUsoGeocoding(usuario);
    console.log(`[creditos] ${usuario}: +${adicionar} (total comprado ${u.creditos}, por ${req.usuarioAtual.usuario})`);
    return json(res, 200, { ok: true, comprados: u.creditos, saldo: Math.max(0, u.creditos - usado) });
  }

  // ─── CUPONS: admin cria/lista/remove ────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/admin/cupons') {
    return json(res, 200, { cupons: await getCupons() });
  }
  if (req.method === 'POST' && pathname === '/api/admin/cupons') {
    const body = await readBody(req);
    const codigo = String(body.codigo || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const pct = Number(body.pct);
    const usosMax = Math.max(0, parseInt(body.usosMax) || 0); // 0 = ilimitado
    if (codigo.length < 3) return json(res, 400, { error: 'Código precisa de pelo menos 3 letras/números' });
    if (!Number.isFinite(pct) || pct < 1 || pct > 99) return json(res, 400, { error: 'Desconto deve ser entre 1% e 99%' });
    const lista = await getCupons();
    if (lista.some(c => c.codigo === codigo)) return json(res, 409, { error: 'Já existe um cupom com esse código' });
    lista.push({ codigo, pct, usosMax, usados: 0, criadoEm: new Date().toISOString() });
    await setCupons(lista);
    console.log(`[cupom] criado: ${codigo} (${pct}%, ${usosMax || '∞'} usos) por ${req.usuarioAtual.usuario}`);
    return json(res, 200, { ok: true, cupons: lista });
  }
  if (req.method === 'POST' && pathname === '/api/admin/cupons/remover') {
    const body = await readBody(req);
    const codigo = String(body.codigo || '').trim().toUpperCase();
    const lista = (await getCupons()).filter(c => c.codigo !== codigo);
    await setCupons(lista);
    return json(res, 200, { ok: true, cupons: lista });
  }

  // ─── CUPOM: comprador valida antes de pagar (qualquer usuário logado) ───────
  if (req.method === 'POST' && pathname === '/api/pagamento/cupom') {
    const body = await readBody(req);
    const c = await validarCupom(body.codigo);
    if (!c) return json(res, 404, { error: 'Cupom inválido ou esgotado' });
    return json(res, 200, { ok: true, codigo: c.codigo, pct: c.pct });
  }

  // ─── PAGAMENTO: o que está à venda (só o plano mensal — créditos são só de teste) ──
  if (req.method === 'GET' && pathname === '/api/pagamento/pacotes') {
    return json(res, 200, { pacotes: [], plano: PLANO_MENSAL, ativo: !!MERCADOPAGO_TOKEN });
  }

  // ─── PAGAMENTO: cria um PIX avulso (paga 1 mês do plano) no Mercado Pago ────
  if (req.method === 'POST' && pathname === '/api/pagamento/criar') {
    if (!MERCADOPAGO_TOKEN) return json(res, 503, { error: 'Pagamento ainda não configurado pelo administrador.' });
    const body = await readBody(req);
    const usuario = req.usuarioAtual.usuario;
    // só o plano mensal é vendável por PIX (não vendemos mais pacotes de crédito)
    const ehPlano = body.pacoteId === PLANO_MENSAL.id;
    const pacote = ehPlano ? PLANO_MENSAL : null;
    if (!pacote) return json(res, 400, { error: 'Pacote inválido' });
    let descricao = 'PackScan — plano mensal (chave própria)';
    // cupom de desconto (validado de novo aqui, nunca confia só no frontend)
    const cupom = await validarCupom(body.cupom);
    let precoFinal = precoComCupom(pacote.preco, cupom);
    if (cupom) descricao += ` (cupom ${cupom.codigo} -${cupom.pct}%)`;
    // desconto de indicação (20%) — não acumula com cupom, usa o maior desconto
    const meRec = (await getUsuarios()).find(x => x.usuario === usuario);
    const pctInd = descontoIndicacao(meRec);
    if (pctInd && (!cupom || cupom.pct < pctInd)) {
      precoFinal = Math.max(0.01, Math.round(pacote.preco * (1 - pctInd/100) * 100) / 100);
      descricao = `PackScan — plano mensal (indicação -${pctInd}%)`;
    }
    try {
      const idemKey = crypto.randomBytes(16).toString('hex'); // MP exige X-Idempotency-Key
      const mp = await mpRequest('POST', '/v1/payments', {
        transaction_amount: precoFinal,
        description: descricao,
        payment_method_id: 'pix',
        payer: { email: emailPagador(usuario) }
      }, { 'X-Idempotency-Key': idemKey });
      if (mp.status >= 300 || !mp.body || !mp.body.id) {
        console.error('[pagamento criar]', mp.status, JSON.stringify(mp.body));
        // devolve o motivo real do Mercado Pago pra facilitar o diagnóstico
        const b = mp.body || {};
        const detalhe = b.message || (b.cause && b.cause[0] && (b.cause[0].description || b.cause[0].code)) || ('HTTP ' + mp.status);
        return json(res, 502, { error: 'Mercado Pago recusou: ' + detalhe });
      }
      const id = String(mp.body.id);
      const rec = ehPlano
        ? { usuario, tipo: 'plano', dias: PLANO_MENSAL.dias, preco: precoFinal, cupom: cupom ? cupom.codigo : null, status: 'pendente' }
        : { usuario, tipo: 'creditos', creditos: pacote.creditos, preco: precoFinal, cupom: cupom ? cupom.codigo : null, status: 'pendente' };
      await supabaseSet('pay:' + id, rec);
      const td = (mp.body.point_of_interaction && mp.body.point_of_interaction.transaction_data) || {};
      return json(res, 200, { id, qrBase64: td.qr_code_base64 || '', copiaECola: td.qr_code || '' });
    } catch(e) {
      console.error('[pagamento criar]', e.message);
      return json(res, 502, { error: 'Erro ao falar com o Mercado Pago.' });
    }
  }

  // ─── PAGAMENTO: consulta status (frontend faz polling) ─────────────────────
  if (req.method === 'GET' && pathname === '/api/pagamento/status') {
    const id = (parsedUrl.query.id || '').toString();
    let rec = await supabaseGet('pay:' + id);
    if (!rec) return json(res, 404, { error: 'Pagamento não encontrado' });
    if (rec.usuario !== req.usuarioAtual.usuario && !req.usuarioAtual.admin) return json(res, 403, { error: 'Não autorizado' });
    // se ainda pendente, confirma direto no Mercado Pago
    if (rec.status !== 'creditado' && MERCADOPAGO_TOKEN) {
      try {
        const mp = await mpRequest('GET', '/v1/payments/' + id);
        if (mp.body && mp.body.status === 'approved') rec = await creditarPagamento(id);
      } catch(e) { console.error('[pagamento status]', e.message); }
    }
    return json(res, 200, { status: rec.status });
  }

  // ─── ASSINATURA: cria a assinatura recorrente no cartão (Mercado Pago) ─────
  // devolve init_point (link do checkout hospedado do MP) — sem PCI, o cartão é
  // digitado no ambiente do Mercado Pago.
  if (req.method === 'POST' && pathname === '/api/pagamento/assinar') {
    if (!MERCADOPAGO_TOKEN) return json(res, 503, { error: 'Pagamento ainda não configurado pelo administrador.' });
    const usuario = req.usuarioAtual.usuario;
    const base = process.env.APP_URL || ('https://' + (req.headers.host || 'packscan-noma.onrender.com'));
    // desconto de indicação (20%) aplicado à mensalidade enquanto assinar pelo link
    const meRec = (await getUsuarios()).find(x => x.usuario === usuario);
    const pctInd = descontoIndicacao(meRec);
    const valorMensal = pctInd ? Math.round(PLANO_MENSAL.preco * (1 - pctInd/100) * 100) / 100 : PLANO_MENSAL.preco;
    try {
      const mp = await mpRequest('POST', '/preapproval', {
        reason: pctInd ? `PackScan — plano mensal (indicação -${pctInd}%)` : 'PackScan — plano mensal',
        external_reference: usuario,
        payer_email: emailPagador(usuario),
        back_url: base + '/?assinatura=ok',
        auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: valorMensal, currency_id: 'BRL' },
        status: 'pending'
      });
      if (mp.status >= 300 || !mp.body || !mp.body.id) {
        console.error('[assinar]', mp.status, JSON.stringify(mp.body));
        const b = mp.body || {};
        const detalhe = b.message || (b.cause && b.cause[0] && (b.cause[0].description || b.cause[0].code)) || ('HTTP ' + mp.status);
        return json(res, 502, { error: 'Mercado Pago recusou: ' + detalhe });
      }
      await supabaseSet('sub:' + mp.body.id, { usuario, status: 'pendente', criadoEm: Date.now() });
      await supabaseSet('usub:' + usuario, { id: String(mp.body.id) });
      return json(res, 200, { id: String(mp.body.id), init_point: mp.body.init_point || mp.body.sandbox_init_point || '' });
    } catch(e) {
      console.error('[assinar]', e.message);
      return json(res, 502, { error: 'Erro ao falar com o Mercado Pago.' });
    }
  }

  // ─── ASSINATURA: status da assinatura do usuário logado ────────────────────
  if (req.method === 'GET' && pathname === '/api/pagamento/assinatura') {
    const usuario = req.usuarioAtual.usuario;
    const ref = await supabaseGet('usub:' + usuario);
    if (!ref || !ref.id) return json(res, 200, { assinada: false });
    let sub = await supabaseGet('sub:' + ref.id) || {};
    // reconcilia com o MP (pode ter sido autorizada sem o webhook chegar ainda)
    if (MERCADOPAGO_TOKEN && sub.status !== 'cancelled') {
      try {
        const mp = await mpRequest('GET', '/preapproval/' + ref.id);
        if (mp.body && mp.body.status) {
          if (mp.body.status === 'authorized' && sub.status !== 'authorized') { await ativarPlano(usuario, 30); await confirmarIndicacao(usuario); }
          sub = { ...sub, status: mp.body.status };
          await supabaseSet('sub:' + ref.id, sub);
        }
      } catch(e) { console.error('[assinatura status]', e.message); }
    }
    return json(res, 200, { assinada: sub.status === 'authorized', status: sub.status || 'pendente', id: ref.id });
  }

  // ─── ASSINATURA: cancelar a recorrência (o plano segue válido até vencer) ──
  if (req.method === 'POST' && pathname === '/api/pagamento/cancelar') {
    const usuario = req.usuarioAtual.usuario;
    const ref = await supabaseGet('usub:' + usuario);
    if (!ref || !ref.id) return json(res, 404, { error: 'Nenhuma assinatura ativa.' });
    if (!MERCADOPAGO_TOKEN) return json(res, 503, { error: 'Pagamento não configurado.' });
    try {
      const mp = await mpRequest('PUT', '/preapproval/' + ref.id, { status: 'cancelled' });
      if (mp.status >= 300) return json(res, 502, { error: 'Não foi possível cancelar no Mercado Pago.' });
      await supabaseSet('sub:' + ref.id, { usuario, status: 'cancelled' });
      return json(res, 200, { ok: true });
    } catch(e) { console.error('[cancelar]', e.message); return json(res, 502, { error: 'Erro ao cancelar.' }); }
  }

  // ─── INDICAÇÃO: código, link e progresso do usuário logado ─────────────────
  if (req.method === 'GET' && pathname === '/api/referral') {
    const usuario = req.usuarioAtual.usuario;
    const code = await garantirRefCode(usuario);
    const u = (await getUsuarios()).find(x => x.usuario === usuario) || {};
    const base = process.env.APP_URL || ('https://' + (req.headers.host || 'packscan-noma.onrender.com'));
    const pendentes = u.refPendentes || 0;
    return json(res, 200, {
      code,
      link: `${base}/?ref=${code}`,
      pct: INDICACAO_PCT,
      total: u.refTotal || 0,                       // indicações confirmadas (histórico)
      mesesGratis: u.refMesesGratis || 0,           // meses grátis já ganhos
      pendentes,                                     // rumo ao próximo mês grátis
      faltam: INDICACOES_POR_MES_GRATIS - pendentes, // quantas faltam pro próximo mês grátis
      meta: INDICACOES_POR_MES_GRATIS
    });
  }

  // ─── PAGAMENTO: webhook do Mercado Pago (público) ──────────────────────────
  if (pathname === '/api/pagamento/webhook') {
    // o MP avisa via POST {type,data:{id}} ou via querystring ?type=...&data.id=...
    let body = {};
    if (req.method === 'POST') { try { body = await readBody(req); } catch(e) {} }
    const tipo = body.type || parsedUrl.query.type || parsedUrl.query.topic;
    const idRaw = String((body.data && body.data.id) || parsedUrl.query['data.id'] || parsedUrl.query.id || '');
    try {
      if (tipo === 'payment' && /^\d+$/.test(idRaw) && MERCADOPAGO_TOKEN) {
        // PIX avulso
        const mp = await mpRequest('GET', '/v1/payments/' + idRaw);
        if (mp.body && mp.body.status === 'approved') await creditarPagamento(idRaw);
      } else if ((tipo === 'subscription_preapproval' || tipo === 'preapproval') && idRaw && MERCADOPAGO_TOKEN) {
        // assinatura autorizada/cancelada
        const mp = await mpRequest('GET', '/preapproval/' + idRaw);
        const p = mp.body || {};
        const usuario = p.external_reference;
        if (usuario) {
          const rec = (await supabaseGet('sub:' + idRaw)) || { usuario };
          if (p.status === 'authorized') {
            if (rec.status !== 'authorized') { await ativarPlano(usuario, 30); await confirmarIndicacao(usuario); console.log(`[assinatura] autorizada: ${usuario}`); }
            await supabaseSet('sub:' + idRaw, { ...rec, usuario, status: 'authorized' });
          } else if (p.status === 'cancelled' || p.status === 'paused') {
            await supabaseSet('sub:' + idRaw, { ...rec, usuario, status: p.status });
          }
        }
      } else if (tipo === 'subscription_authorized_payment' && idRaw && MERCADOPAGO_TOKEN) {
        // cobrança recorrente mensal aprovada → estende +30 dias (idempotente)
        const mp = await mpRequest('GET', '/authorized_payments/' + idRaw);
        const ap = mp.body || {};
        const aprovado = ap.status === 'processed' || (ap.payment && ap.payment.status === 'approved');
        if (aprovado && ap.preapproval_id) {
          const rec = await supabaseGet('sub:' + ap.preapproval_id);
          if (rec && rec.usuario) {
            const key = 'apay:' + idRaw;
            if (!(await supabaseGet(key))) {
              await ativarPlano(rec.usuario, 30);
              await supabaseSet(key, { done: true });
              console.log(`[assinatura] cobrança recorrente: ${rec.usuario} +30 dias`);
            }
          }
        }
      }
    } catch(e) { console.error('[pagamento webhook]', e.message); }
    // sempre 200 pro MP parar de reenviar
    return json(res, 200, { ok: true });
  }

  // ─── PAINEL ADMIN: uso da Google Geocoding API no mês atual ────────────────
  if (req.method === 'GET' && pathname === '/api/admin/google-usage') {
    const LIMITE = 10000;
    // início do mês atual (UTC) — o filtro por data faz a contagem "zerar" todo mês
    // sem apagar nada do histórico
    const agora = new Date();
    const inicioMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1)).toISOString();

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return json(res, 200, { totalMes: 0, limiteGratuito: LIMITE, restante: LIMITE, percentUsado: 0, custoTotalUsd: 0, porUsuario: [], porApi: [], semBanco: true });
    }

    try {
      // pagina por todas as linhas do mês (operação rara) e agrega em memória —
      // evita depender de view/RPC e de permissão sobre auth.users
      const porUsuarioMap = {}, porApiMap = {};
      let offset = 0;
      const PAGINA = 1000;
      while (true) {
        const r = await supabaseRequest('GET',
          `/rest/v1/google_api_log?created_at=gte.${encodeURIComponent(inicioMes)}&select=usuario,api_type,input_tokens,output_tokens&order=id.asc&limit=${PAGINA}&offset=${offset}`
        );
        if (r.status >= 300 || !Array.isArray(r.body)) {
          console.error('[google-usage]', r.status, JSON.stringify(r.body));
          break;
        }
        for (const row of r.body) {
          const u = row.usuario || '(desconhecido)';
          const a = row.api_type || 'geocoding';
          if (!porUsuarioMap[u]) porUsuarioMap[u] = { total: 0, geoCount: 0, inputTokens: 0, outputTokens: 0 };
          porUsuarioMap[u].total++;
          if (a === 'geocoding') porUsuarioMap[u].geoCount++;
          else if (a === 'anthropic') {
            porUsuarioMap[u].inputTokens += row.input_tokens || 0;
            porUsuarioMap[u].outputTokens += row.output_tokens || 0;
          }
          if (!porApiMap[a]) porApiMap[a] = { total: 0, inputTokens: 0, outputTokens: 0 };
          porApiMap[a].total++;
          porApiMap[a].inputTokens += row.input_tokens || 0;
          porApiMap[a].outputTokens += row.output_tokens || 0;
        }
        if (r.body.length < PAGINA) break;
        offset += PAGINA;
      }

      // ── estimativa de custo (US$) ───────────────────────────────────────
      // Google Geocoding: 10.000 grátis/mês, depois US$ 0,005 por requisição
      // Anthropic (claude-haiku-4-5): US$ 1,00 / 1M tokens de entrada, US$ 5,00 / 1M de saída
      const PRECO_GOOGLE = 0.005;
      const ANTHROPIC_IN = 1.0 / 1e6, ANTHROPIC_OUT = 5.0 / 1e6;

      const geoCount = porApiMap['geocoding'] ? porApiMap['geocoding'].total : 0;
      let custoTotalUsd = 0;

      const porApi = Object.keys(porApiMap).map(a => {
        const m = porApiMap[a];
        let custoUsd = 0;
        if (a === 'geocoding') {
          // conta como se NÃO houvesse cota grátis: custo desde a 1ª requisição
          custoUsd = m.total * PRECO_GOOGLE;
        } else if (a === 'anthropic') {
          custoUsd = m.inputTokens * ANTHROPIC_IN + m.outputTokens * ANTHROPIC_OUT;
        }
        custoTotalUsd += custoUsd;
        return { api_type: a, total: m.total, inputTokens: m.inputTokens, outputTokens: m.outputTokens, custoUsd };
      }).sort((x, y) => y.total - x.total);

      const porUsuario = Object.keys(porUsuarioMap)
        .map(u => {
          const m = porUsuarioMap[u];
          const custoUsd = m.geoCount * PRECO_GOOGLE + m.inputTokens * ANTHROPIC_IN + m.outputTokens * ANTHROPIC_OUT;
          return { usuario: u, total: m.total, custoUsd };
        })
        .sort((a, b) => b.custoUsd - a.custoUsd || b.total - a.total);

      return json(res, 200, {
        // a barra de "free" continua sendo só do Google (Anthropic não tem cota grátis mensal)
        totalMes: geoCount,
        limiteGratuito: LIMITE,
        restante: Math.max(0, LIMITE - geoCount),
        percentUsado: Math.round((geoCount / LIMITE) * 100),
        custoTotalUsd,
        porUsuario,
        porApi
      });
    } catch(e) {
      console.error('[google-usage]', e.message);
      return json(res, 500, { error: e.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/auth/pendentes') {
    const lista = await getUsuarios();
    return json(res, 200, { pendentes: lista.filter(u => u.status === 'pendente').map(u => ({ usuario: u.usuario, criadoEm: u.criadoEm })) });
  }

  // lista todos os usuários com status, admin, validade e saldo de créditos (admin)
  if (req.method === 'GET' && pathname === '/api/auth/usuarios') {
    const lista = await getUsuarios();
    const out = [];
    for (const u of lista) {
      const comprados = Number(u.creditos) || 0;
      const usado = u.admin ? 0 : await carregarUsoGeocoding(u.usuario);
      out.push({
        usuario: u.usuario, status: u.status, admin: !!u.admin,
        criadoEm: u.criadoEm || null,
        email: u.email || null,
        emailVerificado: u.emailVerificado !== false,
        creditosComprados: comprados, creditosUsados: usado,
        saldo: u.admin ? null : Math.max(0, comprados - usado),
        planoAtivo: !!(u.planoProprio && u.planoAte && u.planoAte > Date.now()),
        planoAte: u.planoAte || null,
        temGoogleKey: !!u.googleKey,
        indicacoes: u.refTotal || 0,          // quantos indicados dele já pagaram
        indicacoesMesesGratis: u.refMesesGratis || 0, // meses grátis ganhos
        indicadoPor: u.indicadoPor ? ((lista.find(x => x.refCode === u.indicadoPor) || {}).usuario || u.indicadoPor) : null
      });
    }
    return json(res, 200, { usuarios: out });
  }

  if (req.method === 'POST' && pathname === '/api/auth/aprovar') {
    const body = await readBody(req);
    const usuario = (body.usuario || '').trim().toLowerCase();
    const lista = await getUsuarios();
    const u = lista.find(x => x.usuario === usuario);
    if (!u) return json(res, 404, { error: 'Usuário não encontrado' });
    u.status = 'aprovado';
    await setUsuarios(lista);
    console.log(`[auth] aprovado: ${usuario} (por ${req.usuarioAtual.usuario})`);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/auth/rejeitar') {
    const body = await readBody(req);
    const usuario = (body.usuario || '').trim().toLowerCase();
    const lista = await getUsuarios();
    const filtrada = lista.filter(x => x.usuario !== usuario);
    await setUsuarios(filtrada);
    console.log(`[auth] rejeitado/removido: ${usuario} (por ${req.usuarioAtual.usuario})`);
    return json(res, 200, { ok: true });
  }

  // ─── BANCO LOCAL CNEFE: lista de cidades disponíveis (admin) ──────────────
  if (req.method === 'GET' && pathname === '/api/admin/cnefe') {
    return json(res, 200, { cidades: CNEFE_CIDADES.map(c => ({ cod: c.cod, nome: c.nome })) });
  }
  // ─── BANCO LOCAL CNEFE: importa uma cidade EM SEGUNDO PLANO (admin) ────────
  // a carga leva 1-2 min; rodar sincronamente estoura o tempo do navegador ("Load
  // failed"). Então inicia o job e o frontend consulta /status até terminar.
  if (req.method === 'POST' && pathname === '/api/admin/cnefe/importar') {
    const body = await readBody(req);
    const cidade = CNEFE_CIDADES.find(c => c.cod === String(body.cod || ''));
    if (!cidade) return json(res, 400, { error: 'Cidade inválida' });
    if (_cnefeJobs[cidade.cod] && _cnefeJobs[cidade.cod].estado === 'rodando') {
      return json(res, 200, { ok: true, jaRodando: true });
    }
    _cnefeJobs[cidade.cod] = { estado: 'rodando', feito: 0, total: 0, cidade: cidade.nome };
    // roda sem await — responde na hora
    (async () => {
      try {
        console.log(`[cnefe] importando ${cidade.nome}…`);
        const resumo = await importarCnefe(cidade, null, _cnefeJobs[cidade.cod]);
        _cnefeJobs[cidade.cod].estado = 'ok';
        _cnefeJobs[cidade.cod].enderecos = resumo.enderecos;
        _cnefeJobs[cidade.cod].cidade = cidade.nome;
        console.log(`[cnefe] ✓ ${cidade.nome}: ${resumo.enderecos} endereços`);
      } catch(e) {
        _cnefeJobs[cidade.cod].estado = 'erro';
        _cnefeJobs[cidade.cod].error = e.message;
        _cnefeJobs[cidade.cod].cidade = cidade.nome;
        console.error('[cnefe] erro:', e.message);
      }
    })();
    return json(res, 200, { ok: true, iniciado: true });
  }
  // ─── BANCO LOCAL CNEFE: progresso da importação (admin) ────────────────────
  if (req.method === 'GET' && pathname === '/api/admin/cnefe/status') {
    const cod = (parsedUrl.query.cod || '').toString();
    return json(res, 200, _cnefeJobs[cod] || { estado: 'nenhum' });
  }

  // ─── EXCLUIR REFERÊNCIA DE CEP (lat/lng salvos manualmente) — admin ────────
  if (req.method === 'POST' && pathname === '/api/cep/excluir') {
    const body = await readBody(req);
    const cepDigits = (body.cep || '').replace(/\D/g, '');
    if (cepDigits.length !== 8) return json(res, 400, { error: 'cep (8 dígitos) obrigatório' });
    await supabaseDelete('cep:' + cepDigits);
    console.log(`[cep-excluir] ${cepDigits} (por ${req.usuarioAtual.usuario})`);
    return json(res, 200, { ok: true });
  }

  // página principal
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    fs.readFile(path.join(__dirname, 'packscan.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  // ─── PWA: manifest, service worker e ícones (instalar na tela inicial) ─────
  if (req.method === 'GET' && pathname === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify({
      name: 'PackScan', short_name: 'PackScan',
      description: 'Roteirização e bipagem de entregas',
      start_url: '/', scope: '/', display: 'standalone',
      background_color: '#0f1117', theme_color: '#0f1117', orientation: 'portrait',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
      ]
    }));
  }
  if (req.method === 'GET' && (pathname === '/icon-192.png' || pathname === '/icon-512.png' || pathname === '/icon-180.png')) {
    return fs.readFile(path.join(__dirname, pathname.slice(1)), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' });
      res.end(data);
    });
  }
  if (req.method === 'GET' && pathname === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' });
    // service worker mínimo: só habilita a instalação (network-first, sem cache
    // agressivo pra nunca servir versão velha do app)
    return res.end("self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});");
  }

  // página scanner (câmera mobile)
  if (req.method === 'GET' && pathname === '/scanner') {
    fs.readFile(path.join(__dirname, 'scanner.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  // ─── ESCALA (app separado, sem login, só por link direto) ─────────────────
  if (req.method === 'GET' && (pathname === '/escala' || pathname === '/escala/' || pathname === '/escala/index.html')) {
    fs.readFile(path.join(__dirname, 'escala', 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  // ─── ESCALA: dados compartilhados (sem login) ─────────────────────────────
  // Guarda a escala inteira numa chave central do banco -> todo mundo vê o mesmo.
  if (req.method === 'GET' && pathname === '/api/escala/dados') {
    const dados = await supabaseGet('escala:dados');
    return json(res, 200, { dados: dados || null });
  }
  if (req.method === 'POST' && pathname === '/api/escala/dados') {
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return json(res, 400, { error: 'corpo inválido' });
    const dados = {
      motoristas: Array.isArray(body.motoristas) ? body.motoristas : [],
      regioes:    Array.isArray(body.regioes)    ? body.regioes    : [],
      folgas:     Array.isArray(body.folgas)     ? body.folgas     : [],
      atualizadoEm: new Date().toISOString()
    };
    await supabaseSet('escala:dados', dados);
    return json(res, 200, { ok: true, atualizadoEm: dados.atualizadoEm });
  }

  // ─── SALVAR CORREÇÃO MANUAL ───────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/geocode/correcao') {
    const body = await readBody(req);
    const { cacheKey, lat, lng, enderecoNormalizado, precisao, enderecoFormatado } = body;
    if (!cacheKey || !lat || !lng) return json(res, 400, { error: 'cacheKey, lat, lng obrigatórios' });
    const coord = { lat, lng, enderecoNormalizado, enderecoFormatado, precisao: precisao||'MANUAL', fromCache: false };
    await supabaseSet('end:'+cacheKey, coord);
    console.log(`[correcao] ${cacheKey.substring(0,40)} → ${lat},${lng}`);
    return json(res, 200, { ok: true });
  }

  // ─── SALVAR CORREÇÃO DE CEP (referência manual no mapa) ──────────────────
  if (req.method === 'POST' && pathname === '/api/cep/corrigir') {
    const body = await readBody(req);
    const cepDigits = (body.cep || '').replace(/\D/g, '');
    const { lat, lng } = body;
    if (cepDigits.length !== 8 || !lat || !lng) return json(res, 400, { error: 'cep (8 dígitos), lat, lng obrigatórios' });
    const cepKey = 'cep:' + cepDigits;
    const anterior = (await supabaseGet(cepKey)) || { rua: '', bairro: '', cidade: '' };
    const ruaCorrigida = (body.rua || '').trim();
    const atualizado = { ...anterior, lat, lng, manual: true, rua: ruaCorrigida || anterior.rua || '' };
    await supabaseSet(cepKey, atualizado);
    console.log(`[cep-correcao] ${cepDigits} → ${lat},${lng}`);
    return json(res, 200, { ok: true });
  }

  // ─── BUSCAR RUA AUTOMATICAMENTE PELO CEP (via ViaCEP/Correios, sem usar o mapa) ──
  if (req.method === 'POST' && pathname === '/api/cep/autocompletar') {
    const body = await readBody(req);
    const cepDigits = (body.cep || '').replace(/\D/g, '');
    if (cepDigits.length !== 8) return json(res, 400, { error: 'cep (8 dígitos) obrigatório' });
    try {
      const viaCep = await buscarRuaViaCep(cepDigits);
      if (!viaCep) return json(res, 404, { error: 'CEP sem logradouro cadastrado nos Correios' });
      const cepKey = 'cep:' + cepDigits;
      const anterior = (await supabaseGet(cepKey)) || { rua: '', bairro: '', cidade: '' };
      const atualizado = { ...anterior, rua: viaCep.rua, bairro: anterior.bairro || viaCep.bairro || '', cidade: anterior.cidade || viaCep.cidade || '' };
      await supabaseSet(cepKey, atualizado);
      console.log(`[cep-autocompletar] ${cepDigits} → ${viaCep.rua}`);
      return json(res, 200, { ok: true, rua: viaCep.rua, bairro: atualizado.bairro, cidade: atualizado.cidade });
    } catch(e) {
      console.error('[cep-autocompletar]', e.message);
      return json(res, 502, { error: 'Erro ao consultar ViaCEP' });
    }
  }

  // ─── LOOKUP DE CEP (ponto de referência atual, p/ a aba Corrigir CEP) ─────
  // leve: só resolve o CEP (cache → manual → Google), sem passar pela IA de endereço
  if (req.method === 'POST' && pathname === '/api/cep/lookup') {
    const body = await readBody(req);
    const cepDigits = (body.cep || '').replace(/\D/g, '');
    if (cepDigits.length !== 8) return json(res, 400, { error: 'cep (8 dígitos) obrigatório' });
    const info = await ruaPeloCep(cepDigits);
    if (info && info.lat) {
      return json(res, 200, {
        lat: info.lat, lng: info.lng,
        rua: info.rua || '', bairro: info.bairro || '', cidade: info.cidade || '',
        manual: !!info.manual
      });
    }
    return json(res, 404, { error: 'CEP sem referência no mapa ainda' });
  }

  // ─── CORREÇÕES DE NOME DE RUA ─────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/nomes') {
    return json(res, 200, { correcoes: await getCorrecoesNome() });
  }
  if (req.method === 'POST' && pathname === '/api/nomes') {
    const body = await readBody(req);
    const de = (body.de || '').trim();
    const para = (body.para || '').trim();
    if (!de || !para) return json(res, 400, { error: 'de e para obrigatórios' });
    const lista = await getCorrecoesNome();
    const filtrada = lista.filter(c => (c.de || '').toLowerCase() !== de.toLowerCase());
    filtrada.push({ de, para });
    await setCorrecoesNome(filtrada);
    console.log(`[nome] "${de}" → "${para}"`);
    return json(res, 200, { ok: true, correcoes: filtrada });
  }
  if (req.method === 'POST' && pathname === '/api/nomes/remover') {
    const body = await readBody(req);
    const de = (body.de || '').trim();
    const lista = await getCorrecoesNome();
    const filtrada = lista.filter(c => (c.de || '').toLowerCase() !== de.toLowerCase());
    await setCorrecoesNome(filtrada);
    return json(res, 200, { ok: true, correcoes: filtrada });
  }

  // ─── POST /api/geocode ────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/geocode') {
    const body = await readBody(req);
    const { bairro, cidade, cep } = body;
    // aplica correções de nome de rua ANTES de tudo, pra a busca e o cache já
    // usarem o nome certo (vale pra pacotes atuais e futuros)
    const endereco = aplicarCorrecoesNome(body.endereco, await getCorrecoesNome());
    if (!endereco && !cep) return json(res, 400, { error: 'endereco ou cep obrigatório' });

    // chave do cache
    const cacheKey = 'end:' + `${cep || ''}|${endereco || ''}`.toLowerCase().trim();

    // contexto pro contador de uso do Google (quem pediu + qual CEP); usado só quando
    // há cache miss e o Google é de fato chamado
    const ctx = { usuario: req.usuarioAtual ? req.usuarioAtual.usuario : null, cep: cep ? cep.replace(/\D/g,'') : null };

    // MODO TESTE: só o banco local (CNEFE), sem cache e sem Google — mostra a cobertura pura
    if (body.soLocal) {
      const cepD = (cep || '').replace(/\D/g, '');
      const numT = numeroDoTexto(endereco);
      const loc = (cepD.length === 8 && numT) ? await buscarCnefe(cepD, numT) : null;
      if (loc) {
        const enderecoNormalizado = `${loc.logradouro}, ${numT}, ${loc.cidade}, SC, Brasil`;
        return json(res, 200, { lat: loc.lat, lng: loc.lng, enderecoFormatado: enderecoNormalizado, enderecoNormalizado, logradouro: loc.logradouro, bairro: loc.bairro, cidade: loc.cidade, precisao: 'CNEFE', complemento: numT, fromCache: false });
      }
      return json(res, 404, { error: 'não está no banco local (CNEFE)', soLocal: true });
    }

    // verifica cache Supabase (a menos que "forcar" peça pra ignorar e regeocodificar)
    const cached = body.forcar ? null : await supabaseGet(cacheKey);
    if (cached) {
      console.log(`[cache] ${(endereco||cep||'').substring(0,35)}`);
      return json(res, 200, { ...cached, fromCache: true });
    }

    // gate: cache hit (acima) não consome. Daqui pra baixo vai bater no Google.
    // Três caminhos: admin (ilimitado, chaves globais) | plano com chave própria
    // (usa as chaves do usuário, sem gastar créditos) | créditos pré-pagos.
    {
      const usuarios = await getUsuarios();
      const meuRec = usuarios.find(u => u.usuario === (req.usuarioAtual && req.usuarioAtual.usuario));
      const planoAtivo = meuRec && meuRec.planoProprio && meuRec.planoAte && meuRec.planoAte > Date.now();
      if (meuRec && meuRec.admin) {
        // admin usa as chaves globais, sem limite
      } else if (meuRec && meuRec.planoProprio && !planoAtivo) {
        return json(res, 402, { error: 'Seu plano mensal expirou. Renove por R$ 24,90 para continuar.', planoExpirado: true });
      } else if (planoAtivo) {
        if (!meuRec.googleKey) return json(res, 402, { error: 'Configure sua chave de API do Google para usar seu plano.', semChaves: true });
        ctx.googleKey = meuRec.googleKey;
        ctx.anthropicKey = meuRec.anthropicKey || '';
        ctx.forcarChavePropria = true; // não usa a chave de IA global (custo é do usuário)
      } else {
        const saldo = await saldoCreditos(meuRec);
        if (saldo <= 0) return json(res, 402, { error: 'Seus créditos de teste acabaram. Assine o plano mensal para continuar.', semCreditos: true });
      }
    }

    try {
      // forcarEndereco: geocodifica direto sem passar pelo CEP
      if (body.forcarEndereco && endereco) {
        const coord = await geocodificarEndereco(`${endereco}, SC, Brasil`, ctx);
        if (coord) {
          await supabaseSet(cacheKey, { ...coord, enderecoNormalizado: endereco });
          return json(res, 200, { ...coord, enderecoNormalizado: endereco, fromCache: false });
        }
        return json(res, 404, { error: 'Endereço não encontrado' });
      }

      // ATALHO: banco local (CNEFE) por CEP + número — instantâneo, grátis, preciso.
      // Se achar, nem toca no Google/IA. É a fonte de verdade pras cidades já importadas.
      const cepDig0 = (cep || '').replace(/\D/g, '');
      const num0 = numeroDoTexto(endereco);
      if (cepDig0.length === 8 && num0) {
        const local = await buscarCnefe(cepDig0, num0);
        if (local) {
          const enderecoNormalizado = `${local.logradouro}, ${num0}, ${local.cidade}, SC, Brasil`;
          const resultado = { lat: local.lat, lng: local.lng, enderecoFormatado: enderecoNormalizado, enderecoNormalizado, logradouro: local.logradouro, bairro: local.bairro, cidade: local.cidade, precisao: 'CNEFE', ruaCep: local.logradouro, complemento: num0, fromCache: false };
          await supabaseSet(cacheKey, resultado);
          console.log(`[geocode] ✓ CNEFE ${enderecoNormalizado.substring(0,50)}`);
          return json(res, 200, resultado);
        }
      }

      // fluxo: CEP → rua (referência) → IA extrai rua-do-texto + complemento → geocodifica
      const cepInfo = cep ? await ruaPeloCep(cep.replace(/\D/g,''), ctx) : { rua:'', bairro:'', cidade:'' };
      let ruaCep = cepInfo.rua;
      const info = await extrairInfoIA(endereco, ruaCep, ctx);
      const complemento = info.complemento || 'S/N';
      const cidadeValida = cidade && !/^\d+$/.test(cidade) ? cidade : '';
      const cidadeFinal = cepInfo.cidade || cidadeValida || 'São José';

      let enderecoFinal, coord;

      // PRINCIPAL: rua vinda do CEP (Correios/Google) + complemento. É a fonte de verdade —
      // primeiro puxa a rua pelo CEP, depois soma o número/complemento. Sem adivinhação.
      if (ruaCep) {
        enderecoFinal = `${ruaCep}, ${complemento}, ${cidadeFinal}, SC, Brasil`;
        coord = await geocodificarValidado(enderecoFinal, cepInfo, ctx);
      }

      // fallback: só se o CEP NÃO tem rua (CEP de bairro), aí sim usa a rua que veio escrita
      // no próprio texto da planilha — ainda validando distância pra não casar rua homônima longe
      if (!coord && !ruaCep && info.rua) {
        enderecoFinal = `${info.rua}, ${complemento}, ${cidadeFinal}, SC, Brasil`;
        coord = await geocodificarValidado(enderecoFinal, cepInfo, ctx);
      }

      // fallback 1.4: nem o texto nem o Google sabem a rua do CEP — busca no CACHE
      // (qualquer pacote já geocodificado antes pra esse CEP, de qualquer importação)
      if (!coord && !ruaCep && cep) {
        const ruaCache = await buscarRuaApreendidaPorCep(cep);
        if (ruaCache) {
          enderecoFinal = `${ruaCache}, ${complemento}, ${cidadeFinal}, SC, Brasil`;
          coord = await geocodificarValidado(enderecoFinal, cepInfo, ctx);
          if (coord) await supabaseSet('cep:' + cep.replace(/\D/g,''), { ...cepInfo, rua: ruaCache, cidade: cidadeFinal });
        }
      }

      // fallback 1.5: nem o texto, nem o Google, nem o cache sabem a rua do CEP — usa a
      // rua de outro pacote do MESMO CEP no lote atual (frontend manda em ruaSugerida),
      // já que é muito comum o mesmo CEP cobrir só uma rua e o motorista escrever a rua
      // só uma vez por lote
      const ruaSugerida = (body.ruaSugerida || '').trim();
      if (!coord && !ruaCep && ruaSugerida) {
        enderecoFinal = `${ruaSugerida}, ${complemento}, ${cidadeFinal}, SC, Brasil`;
        coord = await geocodificarValidado(enderecoFinal, cepInfo, ctx);
        if (coord && cep) {
          // aprende essa rua pro CEP, beneficia próximos lotes também
          await supabaseSet('cep:' + cep.replace(/\D/g,''), { ...cepInfo, rua: ruaSugerida, cidade: cidadeFinal });
        }
      }

      // fallback 2: complemento contém nome de comércio/condomínio identificável — busca direto
      if (!coord && complemento && complemento !== 'S/N' && !/^\d/.test(complemento)) {
        enderecoFinal = `${complemento}, ${bairro||''}, ${cidadeFinal}, SC, Brasil`;
        coord = await geocodificarValidado(enderecoFinal, cepInfo, ctx);
      }

      // fallback 3: endereço bruto completo, limpo (cobre casos que a IA não capturou bem)
      if (!coord && /^(rua|av|avenida|travessa|alameda|estrada)/i.test(endereco)) {
        const endLimpo = endereco
          .replace(/portão|portao|branco|preto|referencia|ref\.|obs\.|entregar|fachada|descendo|subindo/gi, '')
          .replace(/\s{2,}/g,' ').trim();
        enderecoFinal = `${endLimpo}, ${cidadeFinal}, SC, Brasil`;
        coord = await geocodificarValidado(enderecoFinal, cepInfo, ctx);
      }

      // fallback 3.6: nada bateu até aqui (texto, rua do Google pro CEP, cache, sugestão) —
      // confirma direto com os Correios (ViaCEP) qual é o nome oficial da rua do CEP antes de
      // desistir pro ponto manual/aproximado; cobre os casos em que o Google sabia ALGUMA rua
      // pro CEP (errada/genérica) e por isso nunca chegou a consultar o ViaCEP em ruaPeloCep
      if (!coord && cep) {
        const cepDigitsLimpo = cep.replace(/\D/g,'');
        const ruaOficial = await buscarRuaViaCep(cepDigitsLimpo);
        if (ruaOficial && ruaOficial.rua && ruaOficial.rua !== ruaCep) {
          enderecoFinal = `${ruaOficial.rua}, ${complemento}, ${cidadeFinal}, SC, Brasil`;
          coord = await geocodificarValidado(enderecoFinal, cepInfo, ctx);
          if (coord) {
            ruaCep = ruaOficial.rua;
            await supabaseSet('cep:' + cepDigitsLimpo, { ...cepInfo, rua: ruaOficial.rua, cidade: cidadeFinal });
            console.log(`[geocode] rua corrigida via ViaCEP pro CEP ${cepDigitsLimpo}: ${ruaOficial.rua}`);
          }
        }
      }

      // fallback 3.5: nenhuma tentativa de rua deu num resultado confiável, mas o CEP já
      // foi corrigido manualmente no mapa — usa esse ponto direto, é mais confiável que um
      // chute novo do Google em cima do CEP cru
      if (!coord && cepInfo.manual && cepInfo.lat) {
        coord = { lat: cepInfo.lat, lng: cepInfo.lng, enderecoFormatado: `CEP ${cep} (referência manual)`, precisao: 'CEP_MANUAL', cidade: cidadeFinal };
      }

      // fallback 4: CEP + complemento
      if (!coord && cep) {
        const cepFmt = `${cep.substring(0,5)}-${cep.substring(5)}`;
        enderecoFinal = `${cepFmt}, ${complemento}, ${cidadeFinal}, SC, Brasil`;
        coord = await geocodificarValidado(enderecoFinal, cepInfo, ctx);
      }

      // fallback 5 (último recurso): coordenada aproximada do CEP — fica marcado pra corrigir
      if (!coord && cepInfo.lat) {
        coord = { lat: cepInfo.lat, lng: cepInfo.lng, enderecoFormatado: `CEP ${cep}`, precisao: 'APPROXIMATE', cidade: cidadeFinal };
      }

      if (!coord) {
        // se o Google recusou a chave própria do usuário, avisa claramente (não é erro de endereço)
        if (ctx.googleErro) {
          const st = ctx.googleErro.status;
          const msgChave = st === 'REQUEST_DENIED'
            ? 'O Google recusou sua chave. Ative a "Geocoding API" e configure o faturamento (billing) no projeto do Google Cloud.'
            : 'Sua chave do Google atingiu o limite de consultas (cota). Verifique o faturamento/limites no Google Cloud.';
          console.log(`[geocode] falha por chave Google (${st}): ${(endereco || cep || '').substring(0,30)}`);
          return json(res, 402, { error: msgChave, chaveGoogleRuim: true, googleStatus: st });
        }
        console.log(`[geocode] não encontrado: ${(endereco || cep || '').substring(0,40)}`);
        return json(res, 404, { error: 'Endereço não encontrado', enderecoFinal });
      }

      // antes de cair pro bairro na exibição, confirma uma última vez com os Correios se eles
      // sabem o nome da rua do CEP — evita mostrar só o bairro quando dá pra mostrar a rua certa
      if (!info.rua && !coord.logradouro && !ruaCep && cep) {
        const ruaOficialDisplay = await buscarRuaViaCep(cep.replace(/\D/g,''));
        if (ruaOficialDisplay && ruaOficialDisplay.rua) {
          ruaCep = ruaOficialDisplay.rua;
          await supabaseSet('cep:' + cep.replace(/\D/g,''), { ...cepInfo, rua: ruaOficialDisplay.rua, cidade: cidadeFinal });
        }
      }

      // exibição final pro motorista: NUNCA mostra o CEP cru.
      // prioridade: rua do texto > rua devolvida pelo Google > rua do CEP > bairro > último recurso (CEP só se não houver mais nada)
      const ruaParaExibir = info.rua || coord.logradouro || ruaCep || '';
      if (ruaParaExibir) {
        enderecoFinal = `${ruaParaExibir}, ${complemento}, ${cidadeFinal}, SC, Brasil`;
      } else if (bairro) {
        enderecoFinal = `${bairro}, ${complemento}, ${cidadeFinal}, SC, Brasil`;
      } else {
        enderecoFinal = `CEP ${cep} (sem rua identificada — corrigir manualmente)`;
      }

      const resultado = { ...coord, cidade: coord.cidade || cidadeFinal, enderecoNormalizado: enderecoFinal, ruaCep, ruaTexto: info.rua, complemento, fromCache: false };
      await supabaseSet(cacheKey, resultado);
      console.log(`[geocode] ✓ ${enderecoFinal.substring(0,55)} (${coord.precisao})`);
      return json(res, 200, resultado);

    } catch(e) {
      console.error(`[geocode] erro: ${e.message}`);
      return json(res, 500, { error: e.message });
    }
  }

  // ─── STATUS CACHE ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/cache') {
    const total = Object.keys(memoriaCache).length;
    return json(res, 200, { memoriaCache: total, supabase: !!SUPABASE_URL });
  }

  // ─── LIMPAR CACHE ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/cache/clear') {
    await supabaseClear();
    return json(res, 200, { ok: true });
  }

  // ─── PACOTES (importação do dia — separada POR USUÁRIO) ───────────────────
  // cada usuário tem sua própria importação salva (chave "pacotes:<usuario>");
  // um cliente não vê nem sobrescreve os dados de outro
  if (req.method === 'POST' && pathname === '/api/pacotes/salvar') {
    const body = await readBody(req);
    if (!body || !body.pacotes) return json(res, 400, { error: 'pacotes obrigatório' });
    await supabaseSet('pacotes:' + req.usuarioAtual.usuario, {
      pacotes: body.pacotes,
      arquivo: body.arquivo || '',
      total: body.pacotes.length,
      salvoEm: new Date().toISOString()
    });
    console.log(`[pacotes] ${body.pacotes.length} pacotes salvos (${req.usuarioAtual.usuario})`);
    return json(res, 200, { ok: true, total: body.pacotes.length });
  }

  if (req.method === 'GET' && pathname === '/api/pacotes/carregar') {
    const d = await supabaseGet('pacotes:' + req.usuarioAtual.usuario);
    if (d && d.pacotes) return json(res, 200, { pacotes: d.pacotes, arquivo: d.arquivo, salvoEm: d.salvoEm, total: d.total });
    return json(res, 200, { pacotes: [], salvoEm: null });
  }

  // admin apaga a própria importação, ou a de outro usuário passando {usuario}
  if (req.method === 'POST' && pathname === '/api/pacotes/apagar') {
    const body = await readBody(req);
    const alvo = ((body && body.usuario) || req.usuarioAtual.usuario).trim().toLowerCase();
    await supabaseDelete('pacotes:' + alvo);
    console.log(`[pacotes] importação apagada (${alvo}, por ${req.usuarioAtual.usuario})`);
    return json(res, 200, { ok: true });
  }

  // ─── ROTAS (separadas POR USUÁRIO, persistidas no Supabase) ────────────────
  // antes ficavam num arquivo local do servidor, que se perdia a cada deploy
  if (req.method === 'POST' && pathname === '/api/rotas/salvar') {
    const body = await readBody(req);
    if (!body || !body.rotas) return json(res, 400, { error: 'rotas obrigatório' });
    await supabaseSet('rotas:' + req.usuarioAtual.usuario, { rotas: body.rotas, salvoEm: new Date().toISOString() });
    console.log(`[rotas] ${body.rotas.length} rotas salvas (${req.usuarioAtual.usuario})`);
    return json(res, 200, { ok: true, total: body.rotas.length });
  }

  if (req.method === 'GET' && pathname === '/api/rotas/carregar') {
    const d = await supabaseGet('rotas:' + req.usuarioAtual.usuario);
    return json(res, 200, (d && d.rotas) ? d : { rotas: [], salvoEm: null });
  }

  // admin apaga as próprias rotas, ou as de outro usuário passando {usuario}
  if (req.method === 'POST' && pathname === '/api/rotas/apagar') {
    const body = await readBody(req);
    const alvo = ((body && body.usuario) || req.usuarioAtual.usuario).trim().toLowerCase();
    await supabaseDelete('rotas:' + alvo);
    console.log(`[rotas] apagadas (${alvo}, por ${req.usuarioAtual.usuario})`);
    return json(res, 200, { ok: true });
  }

  // ─── SESSÃO DE TRABALHO (sincronização automática entre aparelhos) ─────────
  // o app envia o dia de trabalho inteiro (pacotes + bipagens + rotas) a cada
  // mudança; qualquer aparelho logado na MESMA conta recupera ao entrar/recarregar
  if (req.method === 'POST' && pathname === '/api/sessao/salvar') {
    const body = await readBody(req);
    if (!body || !body.estado) return json(res, 400, { error: 'estado obrigatório' });
    await supabaseSet('sessao:' + req.usuarioAtual.usuario, body.estado);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && pathname === '/api/sessao/carregar') {
    const d = await supabaseGet('sessao:' + req.usuarioAtual.usuario);
    return json(res, 200, { estado: d || null });
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => console.log(`✅ PackScan na porta ${PORT} | Supabase: ${SUPABASE_URL ? 'conectado' : 'não configurado'}`));
