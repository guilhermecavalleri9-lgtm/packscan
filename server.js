const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
// NUNCA deixe chave fixa no código (o repositório pode vazar). Só variável de ambiente.
const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY || '';
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
// catálogo de planos por tipo de conta. rotas = limite de rotas liberado ao pagar.
const PLANOS = [
  { id: 'plano_mensal',    tipo: 'motorista', nome: 'Mensal',  preco: 24.90, dias: 30, rotas: 2,
    itens: ['Roteirize até 2 rotas', 'Modo motorista com GPS', 'Aviso ao cliente no WhatsApp'] },
  { id: 'empresa_starter', tipo: 'empresa',   nome: 'Starter', preco: 390.00, dias: 30, rotas: 10,
    itens: ['Até 10 rotas por dia', 'Roteirização + endereço', 'Bipagem por câmera e por código', 'Áreas de rota salvas'] },
  { id: 'empresa_frota',   tipo: 'empresa',   nome: 'Frota',   preco: 990.00, dias: 30, rotas: 50, destaque: true,
    itens: ['Até 50 rotas por dia', 'Tudo do Starter', 'Integração com Circuit', 'Aviso ao cliente no WhatsApp', 'Escala de motoristas'] }
];
function acharPlano(id) { return PLANOS.find(p => p.id === String(id || '')) || null; }
// créditos de boas-vindas pra testar o sistema ao se registrar
const CREDITOS_BOAS_VINDAS = 0;   // sem créditos de teste — agora o teste é por tempo
const TRIAL_DIAS = 3;             // período de teste grátis (dias)
function trialStatus(u){
  const ate = u && u.trialAte ? u.trialAte : 0;
  const ativo = ate > Date.now();
  return { ativo, ate: ate || null, diasRestantes: ativo ? Math.ceil((ate - Date.now())/86400000) : 0 };
}
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

// timeout obrigatório: sem ele, uma chamada travada no Google/ViaCEP deixa a
// geocodificação presa pra sempre (o lote nunca termina).
const HTTP_TIMEOUT_MS = 15000;
function httpsGet(hostname, reqPath) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname, path: reqPath, headers: { 'User-Agent': 'PackScan/3.0' }, timeout: HTTP_TIMEOUT_MS }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout em ' + hostname)); });
    req.on('error', reject);
  });
}

function httpsPost(hostname, reqPath, headers, payload) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(payload);
    const req = https.request(
      { hostname, path: reqPath, method: 'POST', headers: { ...headers, 'Content-Length': buf.length }, timeout: HTTP_TIMEOUT_MS },
      r => { let data = ''; r.on('data', c => data += c); r.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } }); }
    );
    req.on('timeout', () => { req.destroy(new Error('timeout em ' + hostname)); });
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
// cache em memória do bairros.json já gzipado (gerado na 1ª requisição)
let _bairrosGz = null;
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
    const req = https.request({ hostname: 'api.mercadopago.com', path: mpPath, method, headers, timeout: HTTP_TIMEOUT_MS }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => { let p; try { p = data ? JSON.parse(data) : {}; } catch(e) { p = data; } resolve({ status: r.statusCode, body: p }); });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout na requisição')); });
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
async function ativarPlano(usuario, dias, planoId) {
  const lista = await getUsuarios();
  const u = lista.find(x => x.usuario === usuario);
  if (!u) return false;
  const base = (u.planoAte && u.planoAte > Date.now()) ? u.planoAte : Date.now();
  u.planoProprio = true;
  u.planoAte = base + (dias || 30) * 24 * 60 * 60 * 1000;
  // plano pago define o limite de rotas e o tipo de conta (empresa/motorista)
  const pl = acharPlano(planoId);
  if (pl) {
    u.planoId = pl.id;
    u.limiteRotas = pl.rotas;
    if (pl.tipo === 'empresa') u.tipoConta = 'empresa';
  }
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
  // só credita se for do MESMO tipo de conta (motorista↔motorista, empresa↔empresa)
  const mesmoTipo = padrinho && ((padrinho.tipoConta || 'motorista') === (u.tipoConta || 'motorista'));
  if (padrinho && padrinho.usuario !== u.usuario && mesmoTipo) {
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
    await ativarPlano(rec.usuario, rec.dias || 30, rec.planoId);
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
    const req = https.request({ hostname: host, path, method, headers, timeout: HTTP_TIMEOUT_MS }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; }
        catch(e) { parsed = data; }
        resolve({ status: r.statusCode, body: parsed, headers: r.headers });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout na requisição')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── AUTENTICAÇÃO ───────────────────────────────────────────────────────────
const crypto = require('crypto');
// Segredo que assina os tokens de login. Se ficasse um valor fixo no código, qualquer
// pessoa com acesso ao repositório poderia forjar um token de admin. Sem a variável de
// ambiente, gera um segredo aleatório a cada boot (seguro, mas desloga todo mundo a cada deploy).
const AUTH_SECRET = process.env.AUTH_SECRET || (() => {
  console.warn('[auth] AUTH_SECRET não definido — gerando segredo aleatório (todos serão deslogados a cada deploy). Defina AUTH_SECRET no ambiente!');
  return crypto.randomBytes(48).toString('hex');
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
const EMAIL_ATIVO = !!(BREVO_API_KEY && BREVO_SENDER); // dá pra enviar e-mail?
// CHAVE GERAL da confirmação de e-mail no cadastro. Está DESLIGADA: o Brevo está
// barrando as chamadas vindas do IP do Render, então ninguém conseguia receber o
// código e o cadastro ficava travado. Pra religar, basta definir a variável de
// ambiente VERIFICAR_EMAIL=on (nada mais precisa mudar). O envio de e-mail em si
// continua ligado — é o mesmo caminho usado pelo "esqueci minha senha".
const EXIGIR_EMAIL = EMAIL_ATIVO && String(process.env.VERIFICAR_EMAIL || '').toLowerCase() === 'on';
const EMAIL_CODIGO_VALIDADE_MS = 15 * 60 * 1000; // 15 minutos
function emailValido(e) { return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(e || '').trim()); }
function gerarCodigo6() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
// O hash do código de 6 dígitos NÃO pode depender do AUTH_SECRET: quando ele não
// está definido no ambiente, um novo é sorteado a cada reinício do servidor e
// todo código pendente passa a dar "Código incorreto". Por isso cada código
// carrega o próprio sal aleatório, guardado junto no usuário.
function novoSal() { return crypto.randomBytes(12).toString('hex'); }
function hashCodigo(c, sal) { return crypto.createHash('sha256').update(String(c) + '|' + String(sal || AUTH_SECRET)).digest('hex'); }
// confere o código aceitando também o formato antigo (sem sal), pra não invalidar
// os códigos já enviados na hora do deploy
function codigoConfere(codigo, hashSalvo, sal) {
  if (!hashSalvo) return false;
  if (sal && hashCodigo(codigo, sal) === hashSalvo) return true;
  return hashCodigo(codigo, AUTH_SECRET) === hashSalvo;
}

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
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': payload.length },
      timeout: HTTP_TIMEOUT_MS
    }, resp => {
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => {
        if (resp.statusCode >= 300) console.error('[email] Brevo respondeu ' + resp.statusCode + ':', d);
        resolve({ ok: resp.statusCode < 300, status: resp.statusCode, body: d });
      });
    });
    r.on('timeout', () => { r.destroy(new Error('timeout na API do Brevo')); });
    r.on('error', e => { console.error('[email] erro ao falar com o Brevo:', e.message); resolve({ ok: false, motivo: e.message }); });
    r.write(payload); r.end();
  });
}

// gera um código novo pro usuário, salva o hash+validade e dispara o e-mail
async function enviarCodigoEmail(u) {
  const codigo = gerarCodigo6();
  u.emailCodigoSal = novoSal();
  u.emailCodigoHash = hashCodigo(codigo, u.emailCodigoSal);
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
// nome de rua "vazio" do IBGE (ex: "TRAVESSA SEM DENOMINACAO 7", "RUA SEM DENOMINACAO 2")
function ruaSemNome(rua) {
  return !rua || /sem\s*denomina/i.test(String(rua));
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

// ─── POOL DE CHAVES DO GOOGLE ─────────────────────────────────────────────────
// chaves cadastradas pelo admin. Rotaciona a cada GK_TROCA requisições; se uma chave
// falha (sem cota) pula pra próxima; se está inválida (recusada) remove automático.
const GK_KEY = 'cfg:googlekeys';
const GK_TROCA = 50;
let _gkLista = null, _gkIdx = 0, _gkCount = 0;
async function gkCarregar() {
  if (_gkLista) return _gkLista;
  const v = await supabaseGet(GK_KEY);
  _gkLista = (Array.isArray(v) ? v : []).filter(k => k && k.key);
  return _gkLista;
}
async function gkSalvar() { _gkLista = (_gkLista || []).filter(k => k && k.key); await supabaseSet(GK_KEY, _gkLista); }
async function gkAtual() {
  const lista = await gkCarregar();
  if (!lista.length) return null;
  if (_gkIdx >= lista.length) _gkIdx = 0;
  if (_gkCount >= GK_TROCA) { _gkCount = 0; _gkIdx = (_gkIdx + 1) % lista.length; } // trocou de chave
  return lista[_gkIdx];
}
function gkAvancar() { const n = _gkLista ? _gkLista.length : 0; if (n) { _gkIdx = (_gkIdx + 1) % n; _gkCount = 0; } }

// limite de rotas por tipo de conta: motorista até 2; empresa até o limite do plano
// (guardado em u.limiteRotas, padrão 10); admin sem limite prático.
function limiteRotasDe(u) {
  if (!u) return 2;
  if (u.admin) return 99;
  if (u.tipoConta === 'empresa') return Number(u.limiteRotas) || 10;
  return 2;
}

// prazo pro dono arrumar a chave antes de bloquear o acesso dele
const PRAZO_CHAVE_MS = 72 * 60 * 60 * 1000; // 72 horas
function statusChaveUsuario(u) {
  const cs = u && u.chaveStatus;
  if (!cs || cs.ok !== false || !cs.desde) return { problema: false };
  const prazoAte = cs.desde + PRAZO_CHAVE_MS;
  const agora = Date.now();
  return {
    problema: true,
    motivo: cs.motivo || '',
    desde: cs.desde,
    prazoAte,
    bloqueado: agora > prazoAte,
    horasRestantes: Math.max(0, Math.ceil((prazoAte - agora) / 3600000))
  };
}
// (desativado) não marca mais os usuários — sem aviso e sem bloqueio.
async function gkFlagProblema(usuario, motivo) { /* no-op */ }
async function gkRemover(keyStr) {
  if (!_gkLista) return;
  _gkLista = _gkLista.filter(k => k.key !== keyStr);
  _gkIdx = 0; _gkCount = 0;
  await gkSalvar();
  console.warn(`[gkeys] chave removida automaticamente (inválida): …${String(keyStr).slice(-6)}`);
}

// GET no Geocoding do Google usando o POOL (rotação/failover/auto-remoção).
// reqPathSemKey já vem com "?...": esta função só acrescenta &key=.
async function googleGeocodePool(reqPathSemKey, ctx) {
  // usuário com chave própria (plano antigo) ainda é respeitado; senão, usa o pool
  if (ctx && ctx.googleKey) {
    return await httpsGet('maps.googleapis.com', reqPathSemKey + '&key=' + ctx.googleKey);
  }
  const lista = await gkCarregar();
  if (!lista.length) {
    // sem pool: cai na chave global do sistema, se houver
    return await httpsGet('maps.googleapis.com', reqPathSemKey + '&key=' + GOOGLE_KEY);
  }
  const tentativas = lista.length;
  for (let t = 0; t < tentativas; t++) {
    const atual = await gkAtual();
    if (!atual) break;
    let d;
    try { d = await httpsGet('maps.googleapis.com', reqPathSemKey + '&key=' + atual.key); }
    catch(e) { gkAvancar(); continue; } // erro de rede nessa chave → tenta a próxima
    if (d.status === 'REQUEST_DENIED') {
      // chave de um usuário → avisa o dono e dá o prazo (não remove); manual sem dono → remove
      if (atual.origem) { await gkFlagProblema(atual.origem, d.error_message || 'Chave recusada'); gkAvancar(); }
      else { await gkRemover(atual.key); }
      continue;
    }
    if (d.status === 'OVER_QUERY_LIMIT' || d.status === 'OVER_DAILY_LIMIT') { gkAvancar(); continue; } // sem cota → pula
    _gkCount++; // requisição válida contou nesta chave (troca a cada GK_TROCA)
    return d;
  }
  return { status: 'ALL_KEYS_FAILED', results: [] };
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
    const d = await googleGeocodePool(
      `/maps/api/geocode/json?address=${query}&language=pt-BR&region=BR`, ctx
    );
    // chamada real ao Google (passou do cache de CEP) — conta no contador.
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
  const d = await googleGeocodePool(
    `/maps/api/geocode/json?address=${query}&language=pt-BR&region=BR`, ctx
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
// ─── JOGO DA VELHA INFINITO ───────────────────────────────────────────────────
// App separado (/jogodavelha), sem login, dois celulares na mesma sala.
// Regra: cada jogador só pode ter 3 peças no tabuleiro. Ao colocar a 4ª, a peça
// mais antiga dele some — por isso nunca dá "velha", o jogo é infinito.
// O estado das salas mora só na memória do servidor (partida é coisa passageira).
const JV_MAX_PECAS  = 3;
const JV_LIMPA_MS   = 3 * 60 * 60 * 1000; // salas paradas há 3h somem
const JV_ESPERA_MS  = 25000;              // long-poll: segura a resposta até 25s
const JV_ONLINE_MS  = 45000;              // sem dar sinal nesse tempo = offline
const JV_LINHAS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const jvSalas = new Map();

function jvCodigo() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem I/O/0/1 (confunde na tela)
  let cod;
  do {
    cod = '';
    for (let i = 0; i < 4; i++) cod += alfabeto[crypto.randomInt(alfabeto.length)];
  } while (jvSalas.has(cod));
  return cod;
}

function jvNovaSala(codigo) {
  return {
    codigo, criadaEm: Date.now(), mexidoEm: Date.now(), versao: 1,
    jogadores: { X: null, O: null },
    tab: new Array(9).fill(null),
    ordem: { X: [], O: [] },
    vez: 'X', vencedor: null, linha: null,
    placar: { X: 0, O: 0 }, rodada: 1,
    revanche: { X: false, O: false },
    esperando: []
  };
}

function jvOnline(sala, j) {
  const p = sala.jogadores[j];
  return !!p && (Date.now() - p.visto) < JV_ONLINE_MS;
}

function jvPublico(sala) {
  return {
    codigo: sala.codigo, versao: sala.versao, maxPecas: JV_MAX_PECAS,
    tab: sala.tab, ordem: sala.ordem, vez: sala.vez,
    vencedor: sala.vencedor, linha: sala.linha,
    placar: sala.placar, rodada: sala.rodada, revanche: sala.revanche,
    nomes:  { X: sala.jogadores.X ? sala.jogadores.X.nome : null,
              O: sala.jogadores.O ? sala.jogadores.O.nome : null },
    online: { X: jvOnline(sala, 'X'), O: jvOnline(sala, 'O') }
  };
}

// acorda todo mundo que está segurando o long-poll dessa sala
function jvAcordar(sala) {
  const fila = sala.esperando;
  sala.esperando = [];
  for (const w of fila) {
    clearTimeout(w.timer);
    try { json(w.res, 200, { ok: true, jogo: jvPublico(sala) }); } catch (e) {}
  }
}

function jvMudou(sala) {
  sala.versao++;
  sala.mexidoEm = Date.now();
  jvAcordar(sala);
}

function jvLimpar() {
  const agora = Date.now();
  for (const [cod, sala] of jvSalas) {
    if (agora - sala.mexidoEm > JV_LIMPA_MS) { jvAcordar(sala); jvSalas.delete(cod); }
  }
}

function jvVitoria(tab, j) {
  for (const l of JV_LINHAS) if (tab[l[0]] === j && tab[l[1]] === j && tab[l[2]] === j) return l;
  return null;
}

function jvNovaRodada(sala, comeca) {
  sala.tab = new Array(9).fill(null);
  sala.ordem = { X: [], O: [] };
  sala.vez = comeca;
  sala.vencedor = null; sala.linha = null;
  sala.revanche = { X: false, O: false };
  sala.rodada++;
}

// acha o jogador dono do token (e marca que ele deu sinal de vida)
function jvQuem(sala, token) {
  if (!token) return null;
  for (const j of ['X', 'O']) {
    if (sala.jogadores[j] && sala.jogadores[j].token === token) {
      sala.jogadores[j].visto = Date.now();
      return j;
    }
  }
  return null;
}

function jvNome(txt, padrao) {
  const n = String(txt || '').trim().slice(0, 14);
  return n || padrao;
}

// ─── COBRAS E ESCADAS ─────────────────────────────────────────────────────────
// App separado (/cobras), sem login, de 2 a 4 jogadores, cada um no seu celular
// (ou vários no mesmo aparelho). Um dado só — com dois a partida acabava rápido
// demais. Pra chegar tem que tirar o número certinho; passou, fica onde está.
// As salas moram só na memória do servidor, igual as do jogo da velha.
const CE_MAX_JOGADORES = 4;
const CE_LIMPA_MS  = 6 * 60 * 60 * 1000;
const CE_ESPERA_MS = 25000;
const CE_ONLINE_MS = 45000;
const CE_SOZINHO_MS = 10000;   // passou disso sem jogar, o servidor joga sozinho
const CE_CORES = [
  { cor: '#22d3ee', nome: 'Ciano'   },
  { cor: '#fb7185', nome: 'Rosa'    },
  { cor: '#facc15', nome: 'Amarelo' },
  { cor: '#34d399', nome: 'Verde'   }
];
const ceSalas = new Map();

// Tabuleiros, do menorzinho ao maratona. `seed` deixa o sorteio de cobras e
// escadas sempre igual: quem escolhe "Grandão" pega sempre o mesmo desenho.
const CE_TABULEIROS = [
  { id:'corrida',  nome:'Corridinha',   cols:5,  linhas:4,  seed:101, tempo:'~2 min' },
  { id:'rapido',   nome:'Rapidinho',    cols:6,  linhas:5,  seed:202, tempo:'~3 min' },
  { id:'meio',     nome:'Clássico 50',  cols:10, linhas:5,  seed:303, tempo:'~5 min' },
  { id:'classico', nome:'Clássico 100', cols:10, linhas:10, fixo:true, tempo:'~10 min' },
  { id:'grandao',  nome:'Grandão 144',  cols:12, linhas:12, seed:505, tempo:'~15 min' },
  { id:'epico',    nome:'Épico 225',    cols:15, linhas:15, seed:606, tempo:'~20 min' },
  { id:'maratona', nome:'Maratona 400', cols:20, linhas:20, seed:707, tempo:'~40 min' }
];

// o tabuleiro clássico de 100 casas, com o desenho tradicional
const CE_CLASSICO = {
  escadas: { 1:38, 4:14, 9:31, 21:42, 28:84, 36:44, 51:67, 71:91, 80:100 },
  cobras:  { 16:6, 47:26, 49:11, 56:53, 62:19, 64:60, 87:24, 93:73, 95:75, 98:78 }
};

function ceRandom(semente) { // gerador com semente (mulberry32)
  var s = semente >>> 0;
  return function() {
    s = (s + 0x6D2B79F5) >>> 0;
    var t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ceLinha(casa, cols) { return Math.floor((casa - 1) / cols); }

// o tabuleiro é uma cobrinha: a linha de baixo vai pra direita, a de cima volta.
// cePos diz em que linha/coluna a casa está; ceCasa faz o caminho de volta.
function cePos(casa, cols) {
  var r = Math.floor((casa - 1) / cols), i = (casa - 1) % cols;
  return { r: r, x: (r % 2 === 0) ? i : (cols - 1 - i) };
}
function ceCasa(r, x, cols) {
  var i = (r % 2 === 0) ? x : (cols - 1 - x);
  return r * cols + i + 1;
}

// sorteia cobras e escadas que não se atropelam: nenhuma casa é ponta de duas
// coisas ao mesmo tempo, então não tem como entrar em looping infinito.
function ceDesenhar(def) {
  var total = def.cols * def.linhas;
  if (def.fixo) return { escadas: Object.assign({}, CE_CLASSICO.escadas), cobras: Object.assign({}, CE_CLASSICO.cobras) };
  var rnd = ceRandom(def.seed), usadas = {}, escadas = {}, cobras = {};
  var quantas = Math.max(2, Math.round(total / 11));

  // O salto é medido em LINHAS, não em casas soltas: assim a escada/cobra sai
  // curtinha no desenho (1 a 3 linhas, no máximo 3 colunas de lado) mesmo no
  // tabuleiro de 400 casas — senão vira um espaguete atravessando tudo.
  function sorteia(sobe) {
    var de = 2 + Math.floor(rnd() * (total - 3));
    var pos = cePos(de, def.cols);
    var linhas = 1 + Math.floor(rnd() * 3);
    var r = pos.r + (sobe ? linhas : -linhas);
    if (r < 0 || r >= def.linhas) return null;
    var x = pos.x + (Math.floor(rnd() * 7) - 3);
    x = Math.max(0, Math.min(def.cols - 1, x));
    var para = ceCasa(r, x, def.cols);
    if (para <= 1 || para >= total || de <= 1 || de >= total) return null;
    if (sobe ? para <= de : para >= de) return null;
    if (usadas[de] || usadas[para]) return null;
    return { de: de, para: para };
  }

  for (var t = 0, n = 0; n < quantas && t < 6000; t++) {
    var e = sorteia(true);
    if (!e) continue;
    escadas[e.de] = e.para; usadas[e.de] = 1; usadas[e.para] = 1; n++;
  }
  for (var t2 = 0, m = 0; m < quantas && t2 < 6000; t2++) {
    var c = sorteia(false);
    if (!c) continue;
    cobras[c.de] = c.para; usadas[c.de] = 1; usadas[c.para] = 1; m++;
  }
  return { escadas: escadas, cobras: cobras };
}

function ceTabuleiro(id) {
  var def = CE_TABULEIROS.filter(function(t){ return t.id === id; })[0] || CE_TABULEIROS[2];
  var desenho = ceDesenhar(def);
  return {
    id: def.id, nome: def.nome, cols: def.cols, linhas: def.linhas,
    total: def.cols * def.linhas, tempo: def.tempo,
    escadas: desenho.escadas, cobras: desenho.cobras
  };
}

function ceCodigo() {
  var alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var cod;
  do {
    cod = '';
    for (var i = 0; i < 4; i++) cod += alfabeto[crypto.randomInt(alfabeto.length)];
  } while (ceSalas.has(cod));
  return cod;
}

function ceNovaSala(codigo, tabuleiroId) {
  return {
    codigo: codigo, criadaEm: Date.now(), mexidoEm: Date.now(), versao: 1,
    tab: ceTabuleiro(tabuleiroId),
    jogadores: [], proximoId: 1, donoId: null,
    estado: 'lobby',            // lobby | jogando | fim
    vezId: null, prazo: 0, relogio: null, assinatura: null,
    ultimaJogada: null, seq: 0, log: [],
    esperando: []
  };
}

function ceAtivos(sala) { return sala.jogadores.filter(function(p){ return !p.colocacao; }); }
function ceAchar(sala, id) { return sala.jogadores.filter(function(p){ return p.id === id; })[0] || null; }

function ceQuem(sala, token) { // dono do token (e marca que deu sinal de vida)
  if (!token) return null;
  var p = sala.jogadores.filter(function(j){ return j.token === token; })[0];
  if (!p) return null;
  p.visto = Date.now();
  return p;
}

function cePublico(sala) {
  return {
    codigo: sala.codigo, versao: sala.versao, estado: sala.estado,
    tab: sala.tab, maxJogadores: CE_MAX_JOGADORES,
    tabuleiros: CE_TABULEIROS.map(function(t){
      return { id:t.id, nome:t.nome, cols:t.cols, linhas:t.linhas, casas:t.cols*t.linhas, tempo:t.tempo };
    }),
    donoId: sala.donoId, vezId: sala.vezId,
    prazoMs: sala.prazo ? Math.max(0, sala.prazo - Date.now()) : 0, sozinhoMs: CE_SOZINHO_MS,
    ultimaJogada: sala.ultimaJogada, seq: sala.seq, log: sala.log.slice(-12),
    jogadores: sala.jogadores.map(function(p){
      return { id:p.id, nome:p.nome, cor:p.cor, casa:p.casa, colocacao:p.colocacao,
               online: (Date.now() - p.visto) < CE_ONLINE_MS };
    })
  };
}

function ceAcordar(sala) {
  var fila = sala.esperando;
  sala.esperando = [];
  for (var i = 0; i < fila.length; i++) {
    clearTimeout(fila[i].timer);
    try { json(fila[i].res, 200, { ok: true, jogo: cePublico(sala) }); } catch (e) {}
  }
}
// Relógio da vez: quem enrolar mais de 10s leva uma jogada automática. Mora no
// servidor porque é ele que sabe a hora certa mesmo com o celular dormindo, e
// porque assim todo mundo vê a mesma contagem.
function ceArmarRelogio(sala) {
  var assinatura = (sala.estado === 'jogando' && sala.vezId) ? (sala.vezId + ':' + sala.seq) : null;
  if (assinatura === sala.assinatura) return;   // mesma vez de antes: não reinicia a contagem
  clearTimeout(sala.relogio);
  sala.relogio = null; sala.assinatura = assinatura; sala.prazo = 0;
  if (!assinatura) return;
  sala.prazo = Date.now() + CE_SOZINHO_MS;
  sala.relogio = setTimeout(function(){
    if (sala.estado !== 'jogando') return;
    ceJogada(sala, true);
    ceMudou(sala);
  }, CE_SOZINHO_MS);
}
function ceMudou(sala) { sala.versao++; sala.mexidoEm = Date.now(); ceArmarRelogio(sala); ceAcordar(sala); }
function ceLimpar() {
  var agora = Date.now();
  ceSalas.forEach(function(sala, cod) {
    if (agora - sala.mexidoEm > CE_LIMPA_MS) { clearTimeout(sala.relogio); ceAcordar(sala); ceSalas.delete(cod); }
  });
}

// quem joga depois de `id` (pula quem já terminou)
function ceProximo(sala, id) {
  var ativos = ceAtivos(sala);
  if (!ativos.length) return null;
  var ordem = sala.jogadores.map(function(p){ return p.id; });
  var i = ordem.indexOf(id);
  for (var v = 1; v <= ordem.length; v++) {
    var cand = ceAchar(sala, ordem[(i + v) % ordem.length]);
    if (cand && !cand.colocacao) return cand.id;
  }
  return ativos[0].id;
}

// a jogada inteira: o dado, o caminho andado e o que aconteceu no fim
function ceJogada(sala, automatica) {
  var p = ceAchar(sala, sala.vezId);
  var total = sala.tab.total;
  var dado = 1 + crypto.randomInt(6);
  var passos = [], partiu = p.casa, alvo = p.casa + dado;
  var texto = p.nome + ' tirou ' + dado;

  if (alvo > total) {                       // não deu o número certinho, não sai do lugar
    texto += ' — precisava de ' + (total - p.casa) + ' pra chegar, ficou na ' + p.casa;
  } else {
    passos.push({ tipo:'anda', de:partiu, para:alvo });
    p.casa = alvo;
    texto += ', foi pra ' + p.casa;
  }

  // se ficou parado não mexe em escada nem cobra (ele já estava nessa casa)
  if (passos.length && sala.tab.escadas[p.casa]) {
    var cima = sala.tab.escadas[p.casa];
    passos.push({ tipo:'escada', de:p.casa, para:cima });
    texto += ' 🪜 subiu pra ' + cima;
    p.casa = cima;
  } else if (passos.length && sala.tab.cobras[p.casa]) {
    var baixo = sala.tab.cobras[p.casa];
    passos.push({ tipo:'cobra', de:p.casa, para:baixo });
    texto += ' 🐍 escorregou pra ' + baixo;
    p.casa = baixo;
  }

  var terminou = p.casa === total;
  if (terminou) {
    p.colocacao = sala.jogadores.filter(function(j){ return j.colocacao; }).length + 1;
    texto += ' — chegou em ' + p.colocacao + 'º!';
  }

  if (automatica) texto += ' ⏱️';
  sala.seq++;
  sala.ultimaJogada = { id:p.id, nome:p.nome, cor:p.cor, dado:dado, automatica: !!automatica,
                        passos:passos, seq:sala.seq, texto:texto };
  sala.log.push(texto);
  if (sala.log.length > 40) sala.log = sala.log.slice(-40);

  var restam = ceAtivos(sala);
  if (restam.length <= 1) {                 // sobrou um: ele fica em último e acaba
    if (restam.length === 1) restam[0].colocacao = sala.jogadores.length;
    sala.estado = 'fim';
    sala.vezId = null;
    sala.log.push('Fim de jogo!');
  } else {
    sala.vezId = ceProximo(sala, p.id);
  }
}

function ceReiniciar(sala, tabuleiroId) {
  if (tabuleiroId) sala.tab = ceTabuleiro(tabuleiroId);
  sala.jogadores.forEach(function(p){ p.casa = 0; p.colocacao = 0; });
  sala.estado = 'jogando';
  sala.vezId = sala.jogadores.length ? sala.jogadores[0].id : null;
  sala.ultimaJogada = null; sala.seq = 0;
  sala.log = ['Partida nova no tabuleiro ' + sala.tab.nome + '!'];
}

// ─── LUDO ─────────────────────────────────────────────────────────────────────
// App separado (/ludo), sem login, de 2 a 4 jogadores, cada um no seu celular
// (ou vários no mesmo). Um dado: precisa de 6 pra tirar peão da casa, 6 joga de
// novo (três seguidos perde a vez), cair em cima de peão adversário manda ele
// pra casa, e a chegada é exata.
//
// A posição do peão é um passo de 0 a 56, não uma coordenada:
//   -1        = na casa (base)
//   0 a 50    = volta no percurso; a casa física é percurso[(inicio + passo) % 52]
//   51 a 55   = reta final da cor
//   56        = chegou no meio
// Assim o servidor não precisa saber desenho nenhum: pra saber se dois peões
// estão na mesma casa basta comparar (inicio + passo) % 52.
const LU_MAX_JOGADORES = 4;
const LU_LIMPA_MS  = 6 * 60 * 60 * 1000;
const LU_ESPERA_MS = 25000;
const LU_ONLINE_MS = 45000;
const LU_SOZINHO_MS = 10000;   // passou disso sem jogar, o servidor joga sozinho
const LU_PASSOS    = 56;   // passo final = chegada no meio
const LU_PEOES     = 4;
const LU_SEGURAS   = [0, 8, 13, 21, 26, 34, 39, 47]; // saídas + estrelas: não come ninguém aí

const LU_LADOS = [
  { id:'vermelho', nome:'Vermelho', cor:'#ef4444', inicio:0  },
  { id:'verde',    nome:'Verde',    cor:'#22c55e', inicio:13 },
  { id:'amarelo',  nome:'Amarelo',  cor:'#eab308', inicio:26 },
  { id:'azul',     nome:'Azul',     cor:'#3b82f6', inicio:39 }
];
// com 2 jogadores dá pra jogar em cantos opostos, que é como se joga na mesa
const LU_ESCOLHA = { 2: ['vermelho','amarelo'], 3: ['vermelho','verde','amarelo'],
                     4: ['vermelho','verde','amarelo','azul'] };

const luSalas = new Map();

function luLado(id) { return LU_LADOS.filter(function(l){ return l.id === id; })[0] || LU_LADOS[0]; }
function luCodigo() {
  var alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', cod;
  do {
    cod = '';
    for (var i = 0; i < 4; i++) cod += alfabeto[crypto.randomInt(alfabeto.length)];
  } while (luSalas.has(cod));
  return cod;
}

function luNovaSala(codigo) {
  return {
    codigo: codigo, criadaEm: Date.now(), mexidoEm: Date.now(), versao: 1,
    jogadores: [], proximoId: 1, donoId: null,
    estado: 'lobby',              // lobby | jogando | fim
    vezId: null, fase: 'rolar',   // rolar | mover (quando dá pra escolher o peão)
    prazo: 0, relogio: null, assinatura: null,
    dado: null, lances: [], seis: 0,
    ultimaJogada: null, seq: 0, log: [],
    esperando: []
  };
}

function luAtivos(sala) { return sala.jogadores.filter(function(p){ return !p.colocacao; }); }
function luAchar(sala, id) { return sala.jogadores.filter(function(p){ return p.id === id; })[0] || null; }
function luQuem(sala, token) {
  if (!token) return null;
  var p = sala.jogadores.filter(function(j){ return j.token === token; })[0];
  if (!p) return null;
  p.visto = Date.now();
  return p;
}
function luProximo(sala, id) {
  var ordem = sala.jogadores.map(function(p){ return p.id; });
  var i = ordem.indexOf(id);
  for (var v = 1; v <= ordem.length; v++) {
    var cand = luAchar(sala, ordem[(i + v) % ordem.length]);
    if (cand && !cand.colocacao) return cand.id;
  }
  var ativos = luAtivos(sala);
  return ativos.length ? ativos[0].id : null;
}

// casa do percurso (0 a 51) onde o peão está, ou null se está na casa/reta final
function luCasaComum(p, passo) {
  if (passo < 0 || passo > 50) return null;
  return (luLado(p.lado).inicio + passo) % 52;
}

// que peões podem mexer com esse dado
function luLances(p, dado) {
  var podem = [];
  for (var i = 0; i < LU_PEOES; i++) {
    var passo = p.peoes[i];
    if (passo === -1) { if (dado === 6) podem.push(i); continue; }   // sair da casa só no 6
    if (passo === LU_PASSOS) continue;                               // já chegou
    if (passo + dado <= LU_PASSOS) podem.push(i);                    // chegada exata
  }
  return podem;
}

// mexe o peão e resolve o que acontece na casa onde ele parou
function luAplicar(sala, p, peao) {
  var dado = sala.dado, saiu = p.peoes[peao] === -1;
  var de = p.peoes[peao];
  var para = saiu ? 0 : de + dado;
  p.peoes[peao] = para;

  var texto = p.nome + ' tirou ' + dado + (saiu ? ' e tirou um peão da casa' : '');
  var comeu = [];
  var casa = luCasaComum(p, para);
  if (casa !== null && LU_SEGURAS.indexOf(casa) < 0) {
    sala.jogadores.forEach(function(outro){
      if (outro.id === p.id) return;
      for (var i = 0; i < LU_PEOES; i++) {
        if (luCasaComum(outro, outro.peoes[i]) === casa) {
          outro.peoes[i] = -1;
          comeu.push({ jogador: outro.id, peao: i, nome: outro.nome });
        }
      }
    });
  }
  if (comeu.length) texto += ' e comeu ' + comeu.map(function(c){ return c.nome; }).join(', ') + '! 😈';
  else if (!saiu) texto += (para === LU_PASSOS ? ' e botou um peão na chegada! 🎉'
                          : (para >= 51 ? ' e entrou na reta final' : ''));

  var terminou = p.peoes.every(function(x){ return x === LU_PASSOS; });
  if (terminou) {
    p.colocacao = sala.jogadores.filter(function(j){ return j.colocacao; }).length + 1;
    texto = p.nome + ' levou os 4 peões pra chegada — ' + p.colocacao + 'º lugar! 🏆';
  }

  if (sala.automatica) texto += ' ⏱️';
  sala.seq++;
  sala.ultimaJogada = { id:p.id, nome:p.nome, cor:p.cor, dado:dado, peao:peao, automatica: !!sala.automatica,
                        de:de, para:para, comeu:comeu, seq:sala.seq, texto:texto };
  sala.log.push(texto);
  if (sala.log.length > 40) sala.log = sala.log.slice(-40);

  // quem tira 6 joga de novo, mas três seguidos perde a vez
  var deNovo = (dado === 6) && !terminou && sala.seis < 2;
  if (dado === 6 && !terminou && !deNovo) sala.log.push('3 seis seguidos: ' + p.nome + ' perdeu a vez');
  sala.seis = deNovo ? sala.seis + 1 : 0;

  luFecharVez(sala, p, deNovo);
}

function luFecharVez(sala, p, deNovo) {
  sala.fase = 'rolar'; sala.dado = null; sala.lances = [];
  var restam = luAtivos(sala);
  if (restam.length <= 1) {
    if (restam.length === 1) restam[0].colocacao = sala.jogadores.length;
    sala.estado = 'fim'; sala.vezId = null;
    sala.log.push('Fim de jogo!');
    return;
  }
  sala.vezId = deNovo && !p.colocacao ? p.id : luProximo(sala, p.id);
}

function luJogada(sala) {
  var p = luAchar(sala, sala.vezId);
  var dado = 1 + crypto.randomInt(6);
  sala.dado = dado;
  var podem = luLances(p, dado);

  if (!podem.length) {                       // nada pra mexer: passa a vez
    sala.seq++;
    var texto = p.nome + ' tirou ' + dado + ' — sem jogada possível' + (sala.automatica ? ' ⏱️' : '');
    sala.ultimaJogada = { id:p.id, nome:p.nome, cor:p.cor, dado:dado, peao:null, automatica: !!sala.automatica,
                          de:null, para:null, comeu:[], seq:sala.seq, texto:texto };
    sala.log.push(texto);
    sala.seis = 0;
    luFecharVez(sala, p, false);
    return;
  }
  if (podem.length === 1) { luAplicar(sala, p, podem[0]); return; }  // só um jeito: já vai

  sala.fase = 'mover'; sala.lances = podem;   // escolhe o peão
  sala.seq++;
  sala.ultimaJogada = { id:p.id, nome:p.nome, cor:p.cor, dado:dado, peao:null, automatica: !!sala.automatica,
                        de:null, para:null, comeu:[], seq:sala.seq,
                        texto: p.nome + ' tirou ' + dado + ' — escolhendo o peão' };
}

function luComecar(sala) {
  var lados = LU_ESCOLHA[sala.jogadores.length] || LU_ESCOLHA[4];
  sala.jogadores.forEach(function(p, i){
    var l = luLado(lados[i]);
    p.lado = l.id; p.cor = l.cor;
    p.peoes = [-1,-1,-1,-1]; p.colocacao = 0;
  });
  sala.estado = 'jogando';
  sala.vezId = sala.jogadores[0].id;
  sala.fase = 'rolar'; sala.dado = null; sala.lances = []; sala.seis = 0;
  sala.ultimaJogada = null; sala.seq = 0;
  sala.log = ['Partida nova! Precisa de 6 pra tirar peão da casa.'];
}

function luPublico(sala) {
  return {
    codigo: sala.codigo, versao: sala.versao, estado: sala.estado,
    maxJogadores: LU_MAX_JOGADORES, passos: LU_PASSOS, peoes: LU_PEOES,
    seguras: LU_SEGURAS, lados: LU_LADOS,
    donoId: sala.donoId, vezId: sala.vezId, fase: sala.fase,
    dado: sala.dado, lances: sala.lances,
    prazoMs: sala.prazo ? Math.max(0, sala.prazo - Date.now()) : 0, sozinhoMs: LU_SOZINHO_MS,
    ultimaJogada: sala.ultimaJogada, seq: sala.seq, log: sala.log.slice(-12),
    jogadores: sala.jogadores.map(function(p){
      return { id:p.id, nome:p.nome, lado:p.lado, cor:p.cor, peoes:p.peoes.slice(),
               colocacao:p.colocacao, online: (Date.now() - p.visto) < LU_ONLINE_MS };
    })
  };
}

function luAcordar(sala) {
  var fila = sala.esperando;
  sala.esperando = [];
  for (var i = 0; i < fila.length; i++) {
    clearTimeout(fila[i].timer);
    try { json(fila[i].res, 200, { ok: true, jogo: luPublico(sala) }); } catch (e) {}
  }
}
// escolha automática quando o relógio estoura: chegar > comer > tirar da casa >
// o peão mais adiantado
function luEscolhaAuto(sala, p) {
  var dado = sala.dado, melhor = sala.lances[0], nota = -1;
  sala.lances.forEach(function(i){
    var de = p.peoes[i], para = (de === -1) ? 0 : de + dado, n;
    var casa = (para <= 50) ? (luLado(p.lado).inicio + para) % 52 : null;
    var come = casa !== null && LU_SEGURAS.indexOf(casa) < 0 && sala.jogadores.some(function(o){
      return o.id !== p.id && o.peoes.some(function(x){ return luCasaComum(o, x) === casa; });
    });
    if (para === LU_PASSOS) n = 100;
    else if (come) n = 80;
    else if (de === -1) n = 60;
    else n = 10 + para / 10;
    if (n > nota) { nota = n; melhor = i; }
  });
  return melhor;
}

// Relógio da vez: quem enrolar mais de 10s leva uma jogada automática. Mora no
// servidor porque é ele que sabe a hora certa mesmo com o celular dormindo, e
// porque assim todo mundo vê a mesma contagem.
function luArmarRelogio(sala) {
  var assinatura = (sala.estado === 'jogando' && sala.vezId) ? (sala.vezId + ':' + sala.fase + ':' + sala.seq) : null;
  if (assinatura === sala.assinatura) return;
  clearTimeout(sala.relogio);
  sala.relogio = null; sala.assinatura = assinatura; sala.prazo = 0;
  if (!assinatura) return;
  sala.prazo = Date.now() + LU_SOZINHO_MS;
  sala.relogio = setTimeout(function(){
    if (sala.estado !== 'jogando') return;
    var p = luAchar(sala, sala.vezId);
    if (!p) return;
    sala.automatica = true;
    if (sala.fase === 'mover') luAplicar(sala, p, luEscolhaAuto(sala, p));
    else luJogada(sala);
    sala.automatica = false;
    luMudou(sala);
  }, LU_SOZINHO_MS);
}
function luMudou(sala) { sala.versao++; sala.mexidoEm = Date.now(); luArmarRelogio(sala); luAcordar(sala); }
function luLimpar() {
  var agora = Date.now();
  luSalas.forEach(function(sala, cod) {
    if (agora - sala.mexidoEm > LU_LIMPA_MS) { clearTimeout(sala.relogio); luAcordar(sala); luSalas.delete(cod); }
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // rotas de API que não exigem login (login/registro em si)
  const AUTH_PUBLICA = new Set(['/api/auth/login', '/api/auth/registrar', '/api/auth/verificar-email', '/api/auth/reenviar-email', '/api/auth/esqueci', '/api/auth/redefinir', '/api/pagamento/webhook', '/api/escala/dados', '/api/financeiro/dados', '/api/jogodavelha/criar', '/api/jogodavelha/entrar', '/api/jogodavelha/estado', '/api/jogodavelha/jogar', '/api/jogodavelha/revanche', '/api/jogodavelha/zerar', '/api/jogodavelha/sair', '/api/cobras/criar', '/api/cobras/entrar', '/api/cobras/estado', '/api/cobras/tabuleiro', '/api/cobras/comecar', '/api/cobras/rolar', '/api/cobras/revanche', '/api/cobras/lobby', '/api/cobras/sair', '/api/ludo/criar', '/api/ludo/entrar', '/api/ludo/estado', '/api/ludo/comecar', '/api/ludo/rolar', '/api/ludo/mover', '/api/ludo/revanche', '/api/ludo/sair']);
  // rotas que, além de logado, exigem admin
  const SOMENTE_ADMIN = new Set(['/api/cache/clear', '/api/cep/excluir', '/api/nomes/remover', '/api/rotas/apagar', '/api/admin/google-usage', '/api/admin/cupons', '/api/admin/cupons/remover', '/api/admin/cnefe', '/api/admin/cnefe/importar', '/api/admin/cnefe/status', '/api/admin/gkeys', '/api/admin/gkeys/remover', '/api/admin/gkeys/importar-usuarios', '/api/admin/gkeys/testar', '/api/admin/gkeys/avisar', '/api/admin/email/testar', '/api/admin/gkeys/diagnostico', '/api/admin/gkeys/marcar', '/api/admin/correcoes', '/api/admin/correcoes/excluir', '/api/admin/correcoes/apagar-todas', '/api/admin/conta', '/api/endereco/ajeitar', '/api/auth/pendentes', '/api/auth/usuarios', '/api/auth/creditos', '/api/auth/aprovar', '/api/auth/rejeitar']);

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
    // tipo de conta: 'empresa' (frota, várias rotas) ou 'motorista' (individual, até 2 rotas)
    const tipoConta = body.tipoConta === 'empresa' ? 'empresa' : 'motorista';
    // indicação só vale entre contas DO MESMO TIPO (motorista indica motorista, empresa indica empresa)
    const mesmoTipo = padrinho && ((padrinho.tipoConta || 'motorista') === tipoConta);
    const indicadoPor = (padrinho && padrinho.usuario !== usuario && mesmoTipo) ? padrinho.refCode : null;
    const refIgnorado = !!(padrinho && !mesmoTipo);
    // cadastro automático: aprovado na hora (sem admin). O e-mail confirmado é o gate.
    const novo = {
      usuario, senhaHash: hashSenha(senha),
      email: email || null,
      tipoConta,
      emailVerificado: EXIGIR_EMAIL ? ehPrimeiro : true, // confirmação desligada = já entra liberado
      status: 'aprovado',
      admin: ehPrimeiro,
      creditos: 0,
      trialAte: ehPrimeiro ? 0 : (Date.now() + TRIAL_DIAS * 86400000), // 3 dias de teste grátis
      indicadoPor, // refCode de quem indicou (ou null)
      criadoEm: new Date().toISOString()
    };
    let emailEnviado = false;
    if (EXIGIR_EMAIL && !novo.emailVerificado) {
      const r = await enviarCodigoEmail(novo);
      emailEnviado = !!(r && r.ok);
      if (!emailEnviado) console.error('[auth] falha ao enviar e-mail de confirmação:', r && (r.body || r.motivo));
    }
    lista.push(novo);
    await setUsuarios(lista);
    console.log(`[auth] registro: ${usuario}${ehPrimeiro ? ' (primeiro usuário → admin)' : ` (auto-aprovado, teste ${TRIAL_DIAS} dias)`}${novo.emailVerificado ? '' : ' — aguardando confirmação de e-mail'}`);
    return json(res, 200, { ok: true, pendente: false, trialDias: TRIAL_DIAS, refIgnorado, precisaEmail: EXIGIR_EMAIL && !novo.emailVerificado, emailEnviado });
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
    if (!codigoConfere(codigo, u.emailCodigoHash, u.emailCodigoSal)) return json(res, 400, { error: 'Código incorreto.' });
    u.emailVerificado = true;
    delete u.emailCodigoHash; delete u.emailCodigoExp; delete u.emailCodigoSal;
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

  // ─── AUTENTICAÇÃO: esqueci minha senha — envia código por e-mail ───────────
  if (req.method === 'POST' && pathname === '/api/auth/esqueci') {
    const body = await readBody(req);
    const busca = String(body.usuario || '').trim().toLowerCase();
    if (!busca) return json(res, 400, { error: 'Informe seu usuário ou e-mail' });
    if (!EMAIL_ATIVO) return json(res, 503, { error: 'Redefinição por e-mail não está configurada. Fale com o suporte.' });
    const lista = await getUsuarios();
    // aceita usuário OU e-mail
    const u = lista.find(x => x.usuario === busca || (x.email && x.email.toLowerCase() === busca));
    // resposta sempre igual (não revela se a conta existe)
    const respostaGenerica = { ok: true, enviado: true };
    if (!u || !u.email || !emailValido(u.email)) {
      console.log(`[senha] pedido de reset sem conta/e-mail válido: ${busca.substring(0,40)}`);
      return json(res, 200, respostaGenerica);
    }
    // limite simples: 1 pedido por minuto por conta
    if (u.senhaCodigoExp && (u.senhaCodigoExp - EMAIL_CODIGO_VALIDADE_MS) > Date.now() - 60000) {
      return json(res, 200, { ...respostaGenerica, jaEnviado: true });
    }
    const codigo = gerarCodigo6();
    u.senhaCodigoSal = novoSal();
    u.senhaCodigoHash = hashCodigo(codigo, u.senhaCodigoSal);
    u.senhaCodigoExp = Date.now() + EMAIL_CODIGO_VALIDADE_MS;
    u.senhaCodigoTentativas = 0;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:460px;margin:0 auto;padding:24px;background:#0e1424;color:#e8ecf3;border-radius:12px">
        <div style="font-size:20px;font-weight:700;letter-spacing:1px;margin-bottom:8px">PACK<span style="color:#4f8ef7">SCAN</span></div>
        <p style="color:#aab3c5">Recebemos um pedido para <strong>redefinir a senha</strong> da conta <strong>${u.usuario}</strong>. Use o código abaixo:</p>
        <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#4f8ef7;text-align:center;margin:18px 0">${codigo}</div>
        <p style="color:#7b869c;font-size:13px">O código vale por 15 minutos. Se não foi você que pediu, ignore este e-mail — sua senha continua a mesma.</p>
      </div>`;
    const envio = await enviarEmailBrevo(u.email, 'Redefinir senha PackScan: ' + codigo, html);
    await setUsuarios(lista);
    if (!(envio && envio.ok)) console.error('[senha] falha ao enviar e-mail de reset:', envio && (envio.body || envio.motivo));
    console.log(`[senha] código de reset enviado para ${u.usuario}`);
    return json(res, 200, { ...respostaGenerica, usuario: u.usuario });
  }

  // ─── AUTENTICAÇÃO: redefinir a senha com o código ──────────────────────────
  if (req.method === 'POST' && pathname === '/api/auth/redefinir') {
    const body = await readBody(req);
    const busca = String(body.usuario || '').trim().toLowerCase();
    const codigo = String(body.codigo || '').trim();
    const senhaNova = String(body.senha || '');
    if (senhaNova.length < 4) return json(res, 400, { error: 'A nova senha precisa ter pelo menos 4 caracteres' });
    const lista = await getUsuarios();
    const u = lista.find(x => x.usuario === busca || (x.email && x.email.toLowerCase() === busca));
    if (!u || !u.senhaCodigoHash || !u.senhaCodigoExp) return json(res, 400, { error: 'Código inválido ou expirado. Peça um novo.' });
    if (Date.now() > u.senhaCodigoExp) {
      delete u.senhaCodigoHash; delete u.senhaCodigoExp; await setUsuarios(lista);
      return json(res, 400, { error: 'Código expirado. Peça um novo.' });
    }
    u.senhaCodigoTentativas = (u.senhaCodigoTentativas || 0) + 1;
    if (u.senhaCodigoTentativas > 6) {
      delete u.senhaCodigoHash; delete u.senhaCodigoExp; await setUsuarios(lista);
      return json(res, 429, { error: 'Muitas tentativas erradas. Peça um novo código.' });
    }
    if (!codigoConfere(codigo, u.senhaCodigoHash, u.senhaCodigoSal)) {
      await setUsuarios(lista);
      return json(res, 400, { error: 'Código incorreto.' });
    }
    u.senhaHash = hashSenha(senhaNova);
    delete u.senhaCodigoHash; delete u.senhaCodigoExp; delete u.senhaCodigoTentativas; delete u.senhaCodigoSal;
    u.emailVerificado = true; // quem recebeu o código no e-mail comprova que o e-mail é dele
    await setUsuarios(lista);
    console.log(`[senha] redefinida: ${u.usuario}`);
    return json(res, 200, { ok: true, usuario: u.usuario });
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
    // com a confirmação desligada, quem ficou preso por causa do Brevo entra normalmente
    if (EXIGIR_EMAIL && u.emailVerificado === false) return json(res, 403, { error: 'Confirme seu e-mail antes de entrar.', emailNaoVerificado: true, usuario: u.usuario });
    if (u.status !== 'aprovado') return json(res, 403, { error: 'Cadastro ainda não foi aprovado por um administrador' });
    const saldoLogin = await saldoCreditos(u);
    return json(res, 200, {
      ok: true, token: gerarToken(u.usuario, u.admin), usuario: u.usuario, admin: !!u.admin,
      creditos: saldoLogin === Infinity ? null : Math.max(0, saldoLogin),
      planoAtivo: !!(u.planoProprio && u.planoAte && u.planoAte > Date.now()),
      planoAte: u.planoAte || null,
      tipoConta: u.tipoConta || 'motorista',
      limiteRotas: limiteRotasDe(u),
      trial: trialStatus(u),
      chaveStatus: statusChaveUsuario(u)
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
      tipoConta: (u && u.tipoConta) || 'motorista',
      limiteRotas: limiteRotasDe(u),
      trial: trialStatus(u),
      indicacaoDesconto: descontoIndicacao(u), // 20 se tem desconto de indicação disponível
      chaveStatus: statusChaveUsuario(u),
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

  // ─── PAGAMENTO: o que está à venda — planos do tipo da conta (motorista/empresa) ──
  if (req.method === 'GET' && pathname === '/api/pagamento/pacotes') {
    const lista = await getUsuarios();
    const eu = lista.find(x => x.usuario === req.usuarioAtual.usuario);
    const tipo = (eu && eu.tipoConta) || 'motorista';
    const doTipo = PLANOS.filter(p => p.tipo === tipo);
    return json(res, 200, {
      pacotes: [], tipoConta: tipo,
      planos: doTipo,
      plano: doTipo[0] || PLANO_MENSAL, // compatibilidade
      ativo: !!MERCADOPAGO_TOKEN
    });
  }

  // ─── PAGAMENTO: cria um PIX avulso (paga 1 mês do plano) no Mercado Pago ────
  if (req.method === 'POST' && pathname === '/api/pagamento/criar') {
    if (!MERCADOPAGO_TOKEN) return json(res, 503, { error: 'Pagamento ainda não configurado pelo administrador.' });
    const body = await readBody(req);
    const usuario = req.usuarioAtual.usuario;
    // qualquer plano do catálogo (motorista ou empresa) pode ser pago por PIX
    const pacote = acharPlano(body.pacoteId);
    if (!pacote) return json(res, 400, { error: 'Plano inválido' });
    const ehPlano = true;
    let descricao = `PackScan — plano ${pacote.nome}`;
    // cupom de desconto (validado de novo aqui, nunca confia só no frontend)
    const cupom = await validarCupom(body.cupom);
    let precoFinal = precoComCupom(pacote.preco, cupom);
    if (cupom) descricao += ` (cupom ${cupom.codigo} -${cupom.pct}%)`;
    // desconto de indicação (20%) — não acumula com cupom, usa o maior desconto
    const meRec = (await getUsuarios()).find(x => x.usuario === usuario);
    const pctInd = descontoIndicacao(meRec);
    if (pctInd && (!cupom || cupom.pct < pctInd)) {
      precoFinal = Math.max(0.01, Math.round(pacote.preco * (1 - pctInd/100) * 100) / 100);
      descricao = `PackScan — plano ${pacote.nome} (indicação -${pctInd}%)`;
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
      const rec = { usuario, tipo: 'plano', planoId: pacote.id, dias: pacote.dias, preco: precoFinal, cupom: cupom ? cupom.codigo : null, status: 'pendente' };
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
    const bodyAss = await readBody(req);
    const base = process.env.APP_URL || ('https://' + (req.headers.host || 'packscan-noma.onrender.com'));
    // desconto de indicação (20%) aplicado à mensalidade enquanto assinar pelo link
    const meRec = (await getUsuarios()).find(x => x.usuario === usuario);
    // plano escolhido (motorista ou empresa); se não vier, usa o 1º do tipo da conta
    const tipoMe = (meRec && meRec.tipoConta) || 'motorista';
    const planoEsc = acharPlano(bodyAss && bodyAss.planoId) || PLANOS.find(p => p.tipo === tipoMe) || PLANO_MENSAL;
    const pctInd = descontoIndicacao(meRec);
    const valorMensal = pctInd ? Math.round(planoEsc.preco * (1 - pctInd/100) * 100) / 100 : planoEsc.preco;
    try {
      const mp = await mpRequest('POST', '/preapproval', {
        reason: `PackScan — plano ${planoEsc.nome}` + (pctInd ? ` (indicação -${pctInd}%)` : ''),
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
      await supabaseSet('sub:' + mp.body.id, { usuario, status: 'pendente', planoId: planoEsc.id, criadoEm: Date.now() });
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
          if (mp.body.status === 'authorized' && sub.status !== 'authorized') { await ativarPlano(usuario, 30, sub.planoId); await confirmarIndicacao(usuario); }
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
            if (rec.status !== 'authorized') { await ativarPlano(usuario, 30, rec.planoId); await confirmarIndicacao(usuario); console.log(`[assinatura] autorizada: ${usuario}`); }
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
              await ativarPlano(rec.usuario, 30, rec.planoId);
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
        tipoConta: u.tipoConta || 'motorista',
        limiteRotas: limiteRotasDe(u),
        planoId: u.planoId || null,
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

  // ─── POOL DE CHAVES GOOGLE: listar (admin) — mostra mascarado ─────────────
  if (req.method === 'GET' && pathname === '/api/admin/gkeys') {
    const lista = await gkCarregar();
    return json(res, 200, {
      trocaCada: GK_TROCA,
      chaves: lista.map((k, i) => ({
        indice: i,
        mascara: '…' + String(k.key).slice(-6),
        origem: k.origem || null,
        adicionadaEm: k.adicionadaEm || null,
        atual: i === _gkIdx
      }))
    });
  }
  // ─── POOL DE CHAVES GOOGLE: adicionar (admin) ─────────────────────────────
  if (req.method === 'POST' && pathname === '/api/admin/gkeys') {
    const body = await readBody(req);
    const key = String(body.key || '').trim();
    if (!key || key.length < 20) return json(res, 400, { error: 'Chave inválida' });
    await gkCarregar();
    if (_gkLista.some(k => k.key === key)) return json(res, 409, { error: 'Chave já cadastrada' });
    _gkLista.push({ key, adicionadaEm: new Date().toISOString() });
    await gkSalvar();
    console.log(`[gkeys] chave adicionada (…${key.slice(-6)}) por ${req.usuarioAtual.usuario}`);
    return json(res, 200, { ok: true, total: _gkLista.length });
  }
  // ─── POOL DE CHAVES GOOGLE: importar as chaves já cadastradas pelos usuários (admin) ──
  // o admin declara que tem autorização dos donos. Copia pro pool sem expor as chaves.
  if (req.method === 'POST' && pathname === '/api/admin/gkeys/importar-usuarios') {
    const usuarios = await getUsuarios();
    await gkCarregar();
    const existentes = new Set(_gkLista.map(k => k.key));
    let adicionadas = 0, jaExistiam = 0;
    for (const u of usuarios) {
      const k = (u.googleKey || '').trim();
      if (!k || k.length < 20) continue;
      if (existentes.has(k)) { jaExistiam++; continue; }
      existentes.add(k);
      _gkLista.push({ key: k, adicionadaEm: new Date().toISOString(), origem: u.usuario });
      adicionadas++;
    }
    if (adicionadas) await gkSalvar();
    console.log(`[gkeys] importadas dos usuários: +${adicionadas} (por ${req.usuarioAtual.usuario})`);
    return json(res, 200, { ok: true, adicionadas, jaExistiam, total: _gkLista.length });
  }
  // ─── POOL DE CHAVES GOOGLE: testar quais estão ativas (admin) ─────────────
  if (req.method === 'POST' && pathname === '/api/admin/gkeys/testar') {
    const lista = await gkCarregar();
    const out = [];
    for (const k of lista) {
      let status = 'ERRO', motivo = '';
      try {
        const d = await httpsGet('maps.googleapis.com',
          `/maps/api/geocode/json?address=${encodeURIComponent('Florianópolis, SC, Brasil')}&key=${k.key}`);
        motivo = d.error_message || '';
        if (d.status === 'OK') status = 'ATIVA';
        else if (d.status === 'REQUEST_DENIED') status = 'INVÁLIDA';
        else if (d.status === 'OVER_QUERY_LIMIT' || d.status === 'OVER_DAILY_LIMIT') status = 'SEM COTA';
        else status = d.status || 'ERRO';
      } catch(e) { status = 'ERRO'; motivo = e.message; }
      out.push({ mascara: '…' + String(k.key).slice(-6), origem: k.origem || null, status, ok: status === 'ATIVA', motivo });
    }
    // atualiza o status por usuário: INVÁLIDA marca problema (inicia o prazo de 72h);
    // ATIVA limpa. Assim o dono é avisado e tem 72h antes do bloqueio.
    const usuarios = await getUsuarios(); let mudou = false;
    for (const k of out) {
      if (!k.origem) continue;
      const u = usuarios.find(x => x.usuario === k.origem);
      if (!u) continue;
      if (k.status === 'INVÁLIDA') {
        if (!(u.chaveStatus && u.chaveStatus.ok === false && u.chaveStatus.desde)) {
          u.chaveStatus = { ok: false, motivo: k.motivo || 'Chave recusada pelo Google', desde: Date.now() }; mudou = true;
        }
      } else if (k.status === 'ATIVA') {
        if (!u.chaveStatus || u.chaveStatus.ok !== true) { u.chaveStatus = { ok: true }; mudou = true; }
      }
    }
    if (mudou) await setUsuarios(usuarios);
    return json(res, 200, { chaves: out, ativas: out.filter(x => x.ok).length, total: out.length });
  }
  // ─── POOL DE CHAVES GOOGLE: marcar usuários com chave pendente (inicia aviso+72h) (admin) ──
  if (req.method === 'POST' && pathname === '/api/admin/gkeys/marcar') {
    const body = await readBody(req);
    const ids = (Array.isArray(body.usuarios) ? body.usuarios : []).map(s => String(s || '').trim().toLowerCase()).filter(Boolean);
    if (!ids.length) return json(res, 400, { error: 'Nenhum usuário informado' });
    const motivo = String(body.motivo || 'Sua chave do Google precisa de ajuste (billing/Geocoding API).').trim();
    const usuarios = await getUsuarios();
    const marcados = [], naoEncontrados = [];
    for (const id of ids) {
      const u = usuarios.find(x => x.usuario === id || (x.email && x.email.toLowerCase() === id));
      if (!u) { naoEncontrados.push(id); continue; }
      // não reinicia o prazo se já estava marcado
      if (!(u.chaveStatus && u.chaveStatus.ok === false && u.chaveStatus.desde)) {
        u.chaveStatus = { ok: false, motivo, desde: Date.now() };
      }
      marcados.push(u.usuario);
    }
    await setUsuarios(usuarios);
    console.log(`[gkeys] marcados manualmente: ${marcados.length} (por ${req.usuarioAtual.usuario})`);
    return json(res, 200, { ok: true, marcados, naoEncontrados });
  }
  // ─── POOL DE CHAVES GOOGLE: diagnóstico — quem tem chave e se entrou no pool (admin) ──
  if (req.method === 'GET' && pathname === '/api/admin/gkeys/diagnostico') {
    const usuarios = await getUsuarios();
    const lista = await gkCarregar();
    const noPool = new Set(lista.map(k => k.key));
    const out = usuarios.map(u => {
      const k = (u.googleKey || '').trim();
      return {
        usuario: u.usuario,
        email: u.email || null,
        planoProprio: !!u.planoProprio,
        planoAtivo: !!(u.planoProprio && u.planoAte && u.planoAte > Date.now()),
        temChave: !!k,
        tamanhoChave: k.length,
        noPool: !!k && noPool.has(k)
      };
    });
    // ordena: plano primeiro, depois quem tem chave
    out.sort((a, b) => (b.planoProprio - a.planoProprio) || (b.temChave - a.temChave));
    return json(res, 200, {
      totalUsuarios: usuarios.length,
      comChave: out.filter(u => u.temChave).length,
      noPool: out.filter(u => u.noPool).length,
      chavesNoPool: lista.length,
      usuarios: out
    });
  }
  // ─── POOL DE CHAVES GOOGLE: avisar por e-mail os usuários com chave pendente (admin) ──
  // ─── DIAGNÓSTICO DO E-MAIL (admin) ────────────────────────────────────────
  // Mostra se o Brevo está configurado e manda um e-mail de teste, devolvendo a
  // resposta crua da API — é assim que se descobre por que o código não chega.
  if (req.method === 'POST' && pathname === '/api/admin/email/testar') {
    const body = await readBody(req);
    const para = String((body && body.para) || '').trim() || (req.usuarioAtual.email || '');
    const estado = {
      configurado: EMAIL_ATIVO,
      remetente: BREVO_SENDER || '(vazio)',
      chaveDefinida: !!BREVO_API_KEY,
      authSecretDefinido: !!process.env.AUTH_SECRET
    };
    if (!EMAIL_ATIVO) return json(res, 200, { ...estado, enviado: false, erro: 'BREVO_API_KEY e/ou BREVO_SENDER nao estao definidos no ambiente.' });
    if (!emailValido(para)) return json(res, 400, { ...estado, enviado: false, erro: 'Informe um e-mail valido para o teste.' });
    const r = await enviarEmailBrevo(para, 'Teste de e-mail PackScan', '<p>Se voce recebeu isso, o envio de e-mail esta funcionando.</p>');
    return json(res, 200, { ...estado, enviado: !!r.ok, status: r.status || null, resposta: r.body || r.motivo || '' });
  }

  if (req.method === 'POST' && pathname === '/api/admin/gkeys/avisar') {
    if (!EMAIL_ATIVO) return json(res, 503, { error: 'E-mail (Brevo) não configurado.' });
    const usuarios = await getUsuarios();
    const pendentes = usuarios.filter(u => u.chaveStatus && u.chaveStatus.ok === false);
    let enviados = 0; const semEmail = [];
    for (const u of pendentes) {
      if (!u.email || !emailValido(u.email)) { semEmail.push(u.usuario); continue; }
      const st = statusChaveUsuario(u);
      const prazoTxt = st.bloqueado ? 'O prazo já venceu e seu acesso foi bloqueado.' : `Você tem cerca de <strong>${st.horasRestantes}h</strong> (até ${new Date(st.prazoAte).toLocaleString('pt-BR')}) para resolver, senão o acesso será bloqueado.`;
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:22px;color:#1a2233">
          <div style="font-size:20px;font-weight:800;margin-bottom:6px">PACK<span style="color:#4f8ef7">SCAN</span></div>
          <h2 style="color:#c0392b;font-size:18px">⚠️ Sua chave do Google precisa de ajuste</h2>
          <p>Olá, ${u.usuario}. A sua chave do Google usada no PackScan está sendo recusada${u.chaveStatus.motivo ? (' (' + String(u.chaveStatus.motivo).substring(0,120) + ')') : ''}.</p>
          <p style="background:#fff4e5;border:1px solid #ffcc80;border-radius:8px;padding:10px;color:#a15c00">${prazoTxt}</p>
          <h3 style="font-size:15px;margin-top:18px">Como resolver (5 min)</h3>
          <p><strong>1. Ative o faturamento (billing)</strong><br>O Google exige um cartão, mas dentro da cota não cobra nada.<br>→ <a href="https://console.cloud.google.com/billing">console.cloud.google.com/billing</a> → Vincular conta de faturamento → adicione um cartão.</p>
          <p><strong>2. Ative a Geocoding API</strong><br>→ <a href="https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com">Abrir a Geocoding API</a> → confira o projeto certo no topo → clique em ATIVAR.</p>
          <p><strong>3. Se a chave tiver restrição de site</strong><br>APIs e Serviços → Credenciais → sua chave → Restrições de aplicativo → Nenhuma → Salvar.</p>
          <p style="background:#e8f7ee;border:1px solid #34c97e;border-radius:8px;padding:10px;color:#1e7a4b">✅ Pronto isso, avise o administrador pra revalidar. O aviso e o bloqueio somem sozinhos quando a chave voltar a funcionar.</p>
        </div>`;
      const r = await enviarEmailBrevo(u.email, '⚠️ PackScan: ajuste sua chave do Google', html);
      if (r && r.ok) enviados++; else semEmail.push(u.usuario + ' (falha no envio)');
    }
    console.log(`[gkeys] avisos enviados: ${enviados} (pendentes ${pendentes.length})`);
    return json(res, 200, { ok: true, enviados, pendentes: pendentes.length, semEmail });
  }
  // ─── POOL DE CHAVES GOOGLE: remover (admin) ───────────────────────────────
  if (req.method === 'POST' && pathname === '/api/admin/gkeys/remover') {
    const body = await readBody(req);
    await gkCarregar();
    const idx = parseInt(body.indice, 10);
    if (!isFinite(idx) || idx < 0 || idx >= _gkLista.length) return json(res, 400, { error: 'Índice inválido' });
    const rem = _gkLista.splice(idx, 1)[0];
    _gkIdx = 0; _gkCount = 0;
    await gkSalvar();
    console.log(`[gkeys] chave removida (…${String(rem.key).slice(-6)}) por ${req.usuarioAtual.usuario}`);
    return json(res, 200, { ok: true, total: _gkLista.length });
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
  // links diretos pras páginas de planos: /motoristas e /empresas (servem o mesmo app,
  // que abre a página de planos correspondente ao carregar)
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html'
      || pathname === '/motoristas' || pathname === '/motorista'
      || pathname === '/empresas' || pathname === '/empresa')) {
    fs.readFile(path.join(__dirname, 'packscan.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  // ─── contornos dos bairros (OpenStreetMap) ────────────────────────────────
  // Camada só visual do mapa: polígonos oficiais dos bairros da Grande
  // Florianópolis. Arquivo estático, servido gzipado e com cache longo.
  if (req.method === 'GET' && pathname === '/api/bairros') {
    if (_bairrosGz) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Cache-Control': 'public, max-age=86400' });
      return res.end(_bairrosGz);
    }
    return fs.readFile(path.join(__dirname, 'bairros.json'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('[]'); }
      _bairrosGz = zlib.gzipSync(data);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Cache-Control': 'public, max-age=86400' });
      res.end(_bairrosGz);
    });
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
  if (req.method === 'GET' && (pathname === '/icon-192.png' || pathname === '/icon-512.png' || pathname === '/icon-180.png' || pathname === '/icon-fin-192.png' || pathname === '/icon-fin-512.png' || pathname === '/icon-fin-180.png')) {
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

  // ─── FINANCEIRO (app separado, sem login, só por link direto) ─────────────
  if (req.method === 'GET' && (pathname === '/financeiro' || pathname === '/financeiro/' || pathname === '/financeiro/index.html')) {
    fs.readFile(path.join(__dirname, 'financeiro', 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  // ─── FINANCEIRO: dados compartilhados (sem login) ─────────────────────────
  // Guarda contas + cartões + pagamentos numa chave central -> todo mundo vê o mesmo.
  if (req.method === 'GET' && pathname === '/api/financeiro/dados') {
    const dados = await supabaseGet('financeiro:dados');
    return json(res, 200, { dados: dados || null });
  }
  if (req.method === 'POST' && pathname === '/api/financeiro/dados') {
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return json(res, 400, { error: 'corpo inválido' });
    const dados = {
      contas:  Array.isArray(body.contas)  ? body.contas  : [],
      cartoes: Array.isArray(body.cartoes) ? body.cartoes : [],
      pagas:   (body.pagas && typeof body.pagas === 'object' && !Array.isArray(body.pagas)) ? body.pagas : {},
      atualizadoEm: new Date().toISOString()
    };
    await supabaseSet('financeiro:dados', dados);
    return json(res, 200, { ok: true, atualizadoEm: dados.atualizadoEm });
  }

  // ─── FINANCEIRO: PWA próprio (instalar na tela inicial, abrir em tela cheia) ──
  if (req.method === 'GET' && pathname === '/financeiro/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify({
      name: 'Financeiro', short_name: 'Financeiro',
      description: 'Controle de contas e cartões',
      start_url: '/financeiro/', scope: '/financeiro/', display: 'standalone',
      background_color: '#820ad1', theme_color: '#820ad1', orientation: 'portrait',
      icons: [
        { src: '/icon-fin-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-fin-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-fin-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    }));
  }
  if (req.method === 'GET' && pathname === '/financeiro/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/financeiro/' });
    return res.end("self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});");
  }

  // ─── JOGO DA VELHA INFINITO (app separado, sem login, só por link direto) ──
  if (req.method === 'GET' && (pathname === '/jogodavelha' || pathname === '/jogodavelha/' || pathname === '/jogodavelha/index.html')) {
    fs.readFile(path.join(__dirname, 'jogodavelha', 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  // PWA próprio (dá pra instalar na tela inicial do celular)
  if (req.method === 'GET' && pathname === '/jogodavelha/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify({
      name: 'Jogo da Velha Infinito', short_name: 'Velha ∞',
      description: 'Jogo da velha infinito de 3 peças para dois celulares',
      start_url: '/jogodavelha/', scope: '/jogodavelha/', display: 'standalone',
      background_color: '#0e1020', theme_color: '#0e1020', orientation: 'portrait',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }
      ]
    }));
  }
  if (req.method === 'GET' && pathname === '/jogodavelha/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/jogodavelha/' });
    return res.end("self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});");
  }

  // criar sala -> quem cria joga de X
  if (req.method === 'POST' && pathname === '/api/jogodavelha/criar') {
    jvLimpar();
    const body = await readBody(req);
    const sala = jvNovaSala(jvCodigo());
    const token = crypto.randomBytes(12).toString('hex');
    sala.jogadores.X = { token, nome: jvNome(body.nome, 'Jogador 1'), visto: Date.now() };
    jvSalas.set(sala.codigo, sala);
    return json(res, 200, { ok: true, codigo: sala.codigo, jogador: 'X', token, jogo: jvPublico(sala) });
  }

  // entrar numa sala pelo código (ou voltar pra ela, se o celular já era dali)
  if (req.method === 'POST' && pathname === '/api/jogodavelha/entrar') {
    const body = await readBody(req);
    const codigo = String(body.codigo || '').trim().toUpperCase();
    const sala = jvSalas.get(codigo);
    if (!sala) return json(res, 404, { error: 'Sala não encontrada. Confira o código.' });

    let jogador = jvQuem(sala, body.token);
    let token = body.token;
    if (jogador) {
      // reconexão: mesmo celular voltando pra partida
      sala.jogadores[jogador].nome = jvNome(body.nome, sala.jogadores[jogador].nome);
    } else {
      jogador = !sala.jogadores.O ? 'O' : (!sala.jogadores.X ? 'X' : null);
      if (!jogador) return json(res, 403, { error: 'Essa sala já tem dois jogadores.' });
      token = crypto.randomBytes(12).toString('hex');
      sala.jogadores[jogador] = { token, nome: jvNome(body.nome, jogador === 'X' ? 'Jogador 1' : 'Jogador 2'), visto: Date.now() };
    }
    jvMudou(sala);
    return json(res, 200, { ok: true, codigo: sala.codigo, jogador, token, jogo: jvPublico(sala) });
  }

  // estado da sala — long-poll: só responde quando muda algo (ou depois de 25s)
  if (req.method === 'GET' && pathname === '/api/jogodavelha/estado') {
    const codigo = String(parsedUrl.query.codigo || '').trim().toUpperCase();
    const sala = jvSalas.get(codigo);
    if (!sala) return json(res, 404, { error: 'Sala não encontrada.' });
    jvQuem(sala, parsedUrl.query.token);
    const visto = parseInt(parsedUrl.query.v, 10);
    if (!(visto === sala.versao)) return json(res, 200, { ok: true, jogo: jvPublico(sala) });

    const espera = { res, timer: null };
    espera.timer = setTimeout(() => {
      sala.esperando = sala.esperando.filter(w => w !== espera);
      try { json(res, 200, { ok: true, jogo: jvPublico(sala) }); } catch (e) {}
    }, JV_ESPERA_MS);
    req.on('close', () => {
      clearTimeout(espera.timer);
      sala.esperando = sala.esperando.filter(w => w !== espera);
    });
    sala.esperando.push(espera);
    return;
  }

  // jogar numa casa (0..8)
  if (req.method === 'POST' && pathname === '/api/jogodavelha/jogar') {
    const body = await readBody(req);
    const sala = jvSalas.get(String(body.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 404, { error: 'Sala não encontrada.' });
    const j = jvQuem(sala, body.token);
    if (!j) return json(res, 403, { error: 'Você não está nessa partida.' });
    if (!sala.jogadores.X || !sala.jogadores.O) return json(res, 400, { error: 'Esperando o outro jogador entrar.' });
    if (sala.vencedor) return json(res, 400, { error: 'A rodada já acabou.' });
    if (sala.vez !== j) return json(res, 400, { error: 'Não é sua vez.' });
    const casa = parseInt(body.casa, 10);
    if (!(casa >= 0 && casa <= 8)) return json(res, 400, { error: 'Casa inválida.' });
    if (sala.tab[casa]) return json(res, 400, { error: 'Essa casa já está ocupada.' });

    // peça além do limite: a mais antiga desse jogador sai do tabuleiro
    if (sala.ordem[j].length >= JV_MAX_PECAS) {
      const antiga = sala.ordem[j].shift();
      sala.tab[antiga] = null;
    }
    sala.tab[casa] = j;
    sala.ordem[j].push(casa);

    const linha = jvVitoria(sala.tab, j);
    if (linha) {
      sala.vencedor = j; sala.linha = linha; sala.placar[j]++;
    } else {
      sala.vez = (j === 'X') ? 'O' : 'X';
    }
    jvMudou(sala);
    return json(res, 200, { ok: true, jogo: jvPublico(sala) });
  }

  // revanche: só começa a rodada nova quando os dois pedirem (quem perdeu começa)
  if (req.method === 'POST' && pathname === '/api/jogodavelha/revanche') {
    const body = await readBody(req);
    const sala = jvSalas.get(String(body.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 404, { error: 'Sala não encontrada.' });
    const j = jvQuem(sala, body.token);
    if (!j) return json(res, 403, { error: 'Você não está nessa partida.' });
    if (!sala.vencedor) return json(res, 400, { error: 'A rodada ainda está rolando.' });
    sala.revanche[j] = true;
    if (sala.revanche.X && sala.revanche.O) jvNovaRodada(sala, sala.vencedor === 'X' ? 'O' : 'X');
    jvMudou(sala);
    return json(res, 200, { ok: true, jogo: jvPublico(sala) });
  }

  // zerar o placar (sem sair da sala)
  if (req.method === 'POST' && pathname === '/api/jogodavelha/zerar') {
    const body = await readBody(req);
    const sala = jvSalas.get(String(body.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 404, { error: 'Sala não encontrada.' });
    const j = jvQuem(sala, body.token);
    if (!j) return json(res, 403, { error: 'Você não está nessa partida.' });
    sala.placar = { X: 0, O: 0 };
    sala.rodada = 0;
    jvNovaRodada(sala, 'X');
    jvMudou(sala);
    return json(res, 200, { ok: true, jogo: jvPublico(sala) });
  }

  // sair da sala (libera a vaga; se ficar vazia, a sala some)
  if (req.method === 'POST' && pathname === '/api/jogodavelha/sair') {
    const body = await readBody(req);
    const sala = jvSalas.get(String(body.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 200, { ok: true });
    const j = jvQuem(sala, body.token);
    if (j) {
      sala.jogadores[j] = null;
      jvMudou(sala);
      if (!sala.jogadores.X && !sala.jogadores.O) jvSalas.delete(sala.codigo);
    }
    return json(res, 200, { ok: true });
  }

  // ─── JOGOS: tela inicial com a escolha do jogo ────────────────────────────
  if (req.method === 'GET' && (pathname === '/jogos' || pathname === '/jogos/' || pathname === '/jogos/index.html')) {
    fs.readFile(path.join(__dirname, 'jogos', 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/jogos/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify({
      name: 'Jogos', short_name: 'Jogos', description: 'Jogo da velha infinito e cobras e escadas',
      start_url: '/jogos/', scope: '/', display: 'standalone',
      background_color: '#0e1020', theme_color: '#0e1020', orientation: 'portrait',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }
      ]
    }));
  }

  // ─── COBRAS E ESCADAS (app separado, sem login, só por link direto) ───────
  if (req.method === 'GET' && (pathname === '/cobras' || pathname === '/cobras/' || pathname === '/cobras/index.html')) {
    fs.readFile(path.join(__dirname, 'cobras', 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/cobras/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify({
      name: 'Cobras e Escadas', short_name: 'Cobras',
      description: 'Cobras e escadas com 1 dado, de 2 a 4 jogadores',
      start_url: '/cobras/', scope: '/cobras/', display: 'standalone',
      background_color: '#0e1020', theme_color: '#0e1020', orientation: 'portrait',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }
      ]
    }));
  }
  if (req.method === 'GET' && pathname === '/cobras/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/cobras/' });
    return res.end("self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});");
  }

  // criar sala -> quem cria é o dono (escolhe tabuleiro e começa a partida)
  if (req.method === 'POST' && pathname === '/api/cobras/criar') {
    ceLimpar();
    const body = await readBody(req);
    const sala = ceNovaSala(ceCodigo(), String(body.tabuleiro || 'meio'));
    const token = crypto.randomBytes(12).toString('hex');
    const p = { id: sala.proximoId++, token, nome: jvNome(body.nome, 'Jogador 1'),
                cor: CE_CORES[0].cor, casa: 0, colocacao: 0, visto: Date.now() };
    sala.jogadores.push(p);
    sala.donoId = p.id;
    sala.log.push(p.nome + ' criou a sala');
    ceSalas.set(sala.codigo, sala);
    return json(res, 200, { ok: true, codigo: sala.codigo, id: p.id, token, jogo: cePublico(sala) });
  }

  // entrar: sem token entra como jogador novo (serve também pra pôr mais de um
  // jogador no mesmo celular); com token conhecido, é só reconexão.
  if (req.method === 'POST' && pathname === '/api/cobras/entrar') {
    const body = await readBody(req);
    const sala = ceSalas.get(String(body.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 404, { error: 'Sala não encontrada. Confira o código.' });

    const velho = ceQuem(sala, body.token);
    if (velho) {
      velho.nome = jvNome(body.nome, velho.nome);
      ceMudou(sala);
      return json(res, 200, { ok: true, codigo: sala.codigo, id: velho.id, token: velho.token, jogo: cePublico(sala) });
    }
    if (sala.estado !== 'lobby') return json(res, 403, { error: 'Essa partida já começou.' });
    if (sala.jogadores.length >= CE_MAX_JOGADORES) return json(res, 403, { error: 'Essa sala já tem 4 jogadores.' });

    const token = crypto.randomBytes(12).toString('hex');
    const p = { id: sala.proximoId++, token, nome: jvNome(body.nome, 'Jogador ' + (sala.jogadores.length + 1)),
                cor: CE_CORES[sala.jogadores.length].cor, casa: 0, colocacao: 0, visto: Date.now() };
    sala.jogadores.push(p);
    sala.log.push(p.nome + ' entrou');
    ceMudou(sala);
    return json(res, 200, { ok: true, codigo: sala.codigo, id: p.id, token, jogo: cePublico(sala) });
  }

  // estado — long-poll: só responde quando muda algo (ou depois de 25s)
  if (req.method === 'GET' && pathname === '/api/cobras/estado') {
    const sala = ceSalas.get(String(parsedUrl.query.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 404, { error: 'Sala não encontrada.' });
    String(parsedUrl.query.token || '').split(',').forEach(function(t){ ceQuem(sala, t); });
    const visto = parseInt(parsedUrl.query.v, 10);
    if (visto !== sala.versao) return json(res, 200, { ok: true, jogo: cePublico(sala) });

    const espera = { res, timer: null };
    espera.timer = setTimeout(() => {
      sala.esperando = sala.esperando.filter(w => w !== espera);
      try { json(res, 200, { ok: true, jogo: cePublico(sala) }); } catch (e) {}
    }, CE_ESPERA_MS);
    req.on('close', () => {
      clearTimeout(espera.timer);
      sala.esperando = sala.esperando.filter(w => w !== espera);
    });
    sala.esperando.push(espera);
    return;
  }

  // dono troca o tabuleiro (só no lobby)
  if (req.method === 'POST' && pathname === '/api/cobras/tabuleiro') {
    const body = await readBody(req);
    const sala = ceSalas.get(String(body.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 404, { error: 'Sala não encontrada.' });
    const p = ceQuem(sala, body.token);
    if (!p) return json(res, 403, { error: 'Você não está nessa partida.' });
    if (p.id !== sala.donoId) return json(res, 403, { error: 'Só quem criou a sala escolhe o tabuleiro.' });
    if (sala.estado !== 'lobby') return json(res, 400, { error: 'A partida já começou.' });
    sala.tab = ceTabuleiro(String(body.tabuleiro || ''));
    ceMudou(sala);
    return json(res, 200, { ok: true, jogo: cePublico(sala) });
  }

  // dono começa a partida (mínimo 2 jogadores)
  if (req.method === 'POST' && pathname === '/api/cobras/comecar') {
    const body = await readBody(req);
    const sala = ceSalas.get(String(body.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 404, { error: 'Sala não encontrada.' });
    const p = ceQuem(sala, body.token);
    if (!p) return json(res, 403, { error: 'Você não está nessa partida.' });
    if (p.id !== sala.donoId) return json(res, 403, { error: 'Só quem criou a sala começa a partida.' });
    if (sala.jogadores.length < 2) return json(res, 400, { error: 'Precisa de pelo menos 2 jogadores.' });
    ceReiniciar(sala, null);
    ceMudou(sala);
    return json(res, 200, { ok: true, jogo: cePublico(sala) });
  }

  // rolar os dois dados (só na sua vez)
  if (req.method === 'POST' && pathname === '/api/cobras/rolar') {
    const body = await readBody(req);
    const sala = ceSalas.get(String(body.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 404, { error: 'Sala não encontrada.' });
    const p = ceQuem(sala, body.token);
    if (!p) return json(res, 403, { error: 'Você não está nessa partida.' });
    if (sala.estado !== 'jogando') return json(res, 400, { error: 'A partida não está rolando.' });
    if (sala.vezId !== p.id) return json(res, 400, { error: 'Não é sua vez.' });
    ceJogada(sala);
    ceMudou(sala);
    return json(res, 200, { ok: true, jogo: cePublico(sala) });
  }

  // jogar de novo com a mesma turma / voltar pro lobby pra trocar de tabuleiro
  if (req.method === 'POST' && pathname === '/api/cobras/revanche') {
    const body = await readBody(req);
    const sala = ceSalas.get(String(body.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 404, { error: 'Sala não encontrada.' });
    const p = ceQuem(sala, body.token);
    if (!p) return json(res, 403, { error: 'Você não está nessa partida.' });
    ceReiniciar(sala, null);
    ceMudou(sala);
    return json(res, 200, { ok: true, jogo: cePublico(sala) });
  }
  if (req.method === 'POST' && pathname === '/api/cobras/lobby') {
    const body = await readBody(req);
    const sala = ceSalas.get(String(body.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 404, { error: 'Sala não encontrada.' });
    const p = ceQuem(sala, body.token);
    if (!p) return json(res, 403, { error: 'Você não está nessa partida.' });
    if (p.id !== sala.donoId) return json(res, 403, { error: 'Só quem criou a sala mexe nisso.' });
    sala.estado = 'lobby';
    sala.jogadores.forEach(function(j){ j.casa = 0; j.colocacao = 0; });
    sala.vezId = null; sala.ultimaJogada = null; sala.seq = 0;
    sala.log = ['De volta pra escolha do tabuleiro'];
    ceMudou(sala);
    return json(res, 200, { ok: true, jogo: cePublico(sala) });
  }

  // sair (libera a vaga; se a sala esvaziar, some)
  if (req.method === 'POST' && pathname === '/api/cobras/sair') {
    const body = await readBody(req);
    const sala = ceSalas.get(String(body.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 200, { ok: true });
    String(body.token || '').split(',').forEach(function(tk){
      const p = ceQuem(sala, tk);
      if (!p) return;
      const eraVez = sala.vezId === p.id;
      const proximo = eraVez ? ceProximo(sala, p.id) : sala.vezId;
      sala.jogadores = sala.jogadores.filter(function(j){ return j.id !== p.id; });
      sala.log.push(p.nome + ' saiu');
      if (sala.donoId === p.id && sala.jogadores.length) sala.donoId = sala.jogadores[0].id;
      sala.vezId = (proximo === p.id) ? (sala.jogadores[0] ? sala.jogadores[0].id : null) : proximo;
      if (sala.estado === 'jogando' && ceAtivos(sala).length <= 1) { sala.estado = 'fim'; sala.vezId = null; }
    });
    if (!sala.jogadores.length) { clearTimeout(sala.relogio); ceAcordar(sala); ceSalas.delete(sala.codigo); return json(res, 200, { ok: true }); }
    ceMudou(sala);
    return json(res, 200, { ok: true });
  }

  // ─── LUDO (app separado, sem login, só por link direto) ───────────────────
  if (req.method === 'GET' && (pathname === '/ludo' || pathname === '/ludo/' || pathname === '/ludo/index.html')) {
    fs.readFile(path.join(__dirname, 'ludo', 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/ludo/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify({
      name: 'Ludo', short_name: 'Ludo', description: 'Ludo de 2 a 4 jogadores, cada um no seu celular',
      start_url: '/ludo/', scope: '/ludo/', display: 'standalone',
      background_color: '#0e1020', theme_color: '#0e1020', orientation: 'portrait',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }
      ]
    }));
  }
  if (req.method === 'GET' && pathname === '/ludo/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/ludo/' });
    return res.end("self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});");
  }

  if (req.method === 'POST' && pathname === '/api/ludo/criar') {
    luLimpar();
    const body = await readBody(req);
    const sala = luNovaSala(luCodigo());
    const token = crypto.randomBytes(12).toString('hex');
    const lado = LU_LADOS[0];
    const p = { id: sala.proximoId++, token, nome: jvNome(body.nome, 'Jogador 1'),
                lado: lado.id, cor: lado.cor, peoes: [-1,-1,-1,-1], colocacao: 0, visto: Date.now() };
    sala.jogadores.push(p);
    sala.donoId = p.id;
    sala.log.push(p.nome + ' criou a sala');
    luSalas.set(sala.codigo, sala);
    return json(res, 200, { ok: true, codigo: sala.codigo, id: p.id, token, jogo: luPublico(sala) });
  }

  // sem token entra como jogador novo (serve pra pôr mais gente no mesmo
  // celular); com token conhecido é só reconexão
  if (req.method === 'POST' && pathname === '/api/ludo/entrar') {
    const body = await readBody(req);
    const sala = luSalas.get(String(body.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 404, { error: 'Sala não encontrada. Confira o código.' });
    const velho = luQuem(sala, body.token);
    if (velho) {
      velho.nome = jvNome(body.nome, velho.nome);
      luMudou(sala);
      return json(res, 200, { ok: true, codigo: sala.codigo, id: velho.id, token: velho.token, jogo: luPublico(sala) });
    }
    if (sala.estado !== 'lobby') return json(res, 403, { error: 'Essa partida já começou.' });
    if (sala.jogadores.length >= LU_MAX_JOGADORES) return json(res, 403, { error: 'Essa sala já tem 4 jogadores.' });
    const token = crypto.randomBytes(12).toString('hex');
    const lado = LU_LADOS[sala.jogadores.length];
    const p = { id: sala.proximoId++, token, nome: jvNome(body.nome, 'Jogador ' + (sala.jogadores.length + 1)),
                lado: lado.id, cor: lado.cor, peoes: [-1,-1,-1,-1], colocacao: 0, visto: Date.now() };
    sala.jogadores.push(p);
    sala.log.push(p.nome + ' entrou');
    luMudou(sala);
    return json(res, 200, { ok: true, codigo: sala.codigo, id: p.id, token, jogo: luPublico(sala) });
  }

  if (req.method === 'GET' && pathname === '/api/ludo/estado') {
    const sala = luSalas.get(String(parsedUrl.query.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 404, { error: 'Sala não encontrada.' });
    String(parsedUrl.query.token || '').split(',').forEach(function(t){ luQuem(sala, t); });
    const visto = parseInt(parsedUrl.query.v, 10);
    if (visto !== sala.versao) return json(res, 200, { ok: true, jogo: luPublico(sala) });
    const espera = { res, timer: null };
    espera.timer = setTimeout(() => {
      sala.esperando = sala.esperando.filter(w => w !== espera);
      try { json(res, 200, { ok: true, jogo: luPublico(sala) }); } catch (e) {}
    }, LU_ESPERA_MS);
    req.on('close', () => {
      clearTimeout(espera.timer);
      sala.esperando = sala.esperando.filter(w => w !== espera);
    });
    sala.esperando.push(espera);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/ludo/comecar') {
    const body = await readBody(req);
    const sala = luSalas.get(String(body.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 404, { error: 'Sala não encontrada.' });
    const p = luQuem(sala, body.token);
    if (!p) return json(res, 403, { error: 'Você não está nessa partida.' });
    if (p.id !== sala.donoId) return json(res, 403, { error: 'Só quem criou a sala começa a partida.' });
    if (sala.jogadores.length < 2) return json(res, 400, { error: 'Precisa de pelo menos 2 jogadores.' });
    luComecar(sala);
    luMudou(sala);
    return json(res, 200, { ok: true, jogo: luPublico(sala) });
  }

  if (req.method === 'POST' && pathname === '/api/ludo/rolar') {
    const body = await readBody(req);
    const sala = luSalas.get(String(body.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 404, { error: 'Sala não encontrada.' });
    const p = luQuem(sala, body.token);
    if (!p) return json(res, 403, { error: 'Você não está nessa partida.' });
    if (sala.estado !== 'jogando') return json(res, 400, { error: 'A partida não está rolando.' });
    if (sala.vezId !== p.id) return json(res, 400, { error: 'Não é sua vez.' });
    if (sala.fase !== 'rolar') return json(res, 400, { error: 'Escolhe o peão primeiro.' });
    luJogada(sala);
    luMudou(sala);
    return json(res, 200, { ok: true, jogo: luPublico(sala) });
  }

  if (req.method === 'POST' && pathname === '/api/ludo/mover') {
    const body = await readBody(req);
    const sala = luSalas.get(String(body.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 404, { error: 'Sala não encontrada.' });
    const p = luQuem(sala, body.token);
    if (!p) return json(res, 403, { error: 'Você não está nessa partida.' });
    if (sala.estado !== 'jogando') return json(res, 400, { error: 'A partida não está rolando.' });
    if (sala.vezId !== p.id) return json(res, 400, { error: 'Não é sua vez.' });
    if (sala.fase !== 'mover') return json(res, 400, { error: 'Rola o dado primeiro.' });
    const peao = parseInt(body.peao, 10);
    if (sala.lances.indexOf(peao) < 0) return json(res, 400, { error: 'Esse peão não pode mexer com esse dado.' });
    luAplicar(sala, p, peao);
    luMudou(sala);
    return json(res, 200, { ok: true, jogo: luPublico(sala) });
  }

  if (req.method === 'POST' && pathname === '/api/ludo/revanche') {
    const body = await readBody(req);
    const sala = luSalas.get(String(body.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 404, { error: 'Sala não encontrada.' });
    const p = luQuem(sala, body.token);
    if (!p) return json(res, 403, { error: 'Você não está nessa partida.' });
    if (sala.jogadores.length < 2) return json(res, 400, { error: 'Precisa de pelo menos 2 jogadores.' });
    luComecar(sala);
    luMudou(sala);
    return json(res, 200, { ok: true, jogo: luPublico(sala) });
  }

  if (req.method === 'POST' && pathname === '/api/ludo/sair') {
    const body = await readBody(req);
    const sala = luSalas.get(String(body.codigo || '').trim().toUpperCase());
    if (!sala) return json(res, 200, { ok: true });
    String(body.token || '').split(',').forEach(function(tk){
      const p = luQuem(sala, tk);
      if (!p) return;
      const proximo = (sala.vezId === p.id) ? luProximo(sala, p.id) : sala.vezId;
      sala.jogadores = sala.jogadores.filter(function(j){ return j.id !== p.id; });
      sala.log.push(p.nome + ' saiu');
      if (sala.donoId === p.id && sala.jogadores.length) sala.donoId = sala.jogadores[0].id;
      sala.vezId = (proximo === p.id) ? (sala.jogadores[0] ? sala.jogadores[0].id : null) : proximo;
      sala.fase = 'rolar'; sala.dado = null; sala.lances = [];
      if (sala.estado === 'jogando' && luAtivos(sala).length <= 1) { sala.estado = 'fim'; sala.vezId = null; }
    });
    if (!sala.jogadores.length) { clearTimeout(sala.relogio); luAcordar(sala); luSalas.delete(sala.codigo); return json(res, 200, { ok: true }); }
    luMudou(sala);
    return json(res, 200, { ok: true });
  }

  // ─── LISTAR CORREÇÕES MANUAIS (admin) — endereços arrastados + CEPs corrigidos ──
  if (req.method === 'GET' && pathname === '/api/admin/correcoes') {
    const out = [];
    try {
      // endereços corrigidos à mão (end: com precisão MANUAL)
      const rEnd = await supabaseRequest('GET',
        `/rest/v1/geo_cache?cache_key=like.${encodeURIComponent('end:*')}&${encodeURIComponent('coord_data->>precisao')}=eq.MANUAL&select=cache_key,coord_data&limit=1000`);
      if (Array.isArray(rEnd.body)) for (const row of rEnd.body) {
        const c = row.coord_data || {};
        out.push({ tipo: 'endereço', cacheKey: row.cache_key, chave: String(row.cache_key).replace(/^end:/, ''), lat: c.lat, lng: c.lng, endereco: c.enderecoNormalizado || c.enderecoFormatado || '' });
      }
      // CEPs corrigidos à mão (cep: com manual=true)
      const rCep = await supabaseRequest('GET',
        `/rest/v1/geo_cache?cache_key=like.${encodeURIComponent('cep:*')}&${encodeURIComponent('coord_data->>manual')}=eq.true&select=cache_key,coord_data&limit=1000`);
      if (Array.isArray(rCep.body)) for (const row of rCep.body) {
        const c = row.coord_data || {};
        out.push({ tipo: 'CEP', cacheKey: row.cache_key, chave: String(row.cache_key).replace(/^cep:/, ''), lat: c.lat, lng: c.lng, endereco: (c.rua || '') + (c.cidade ? (', ' + c.cidade) : '') });
      }
    } catch(e) { console.error('[correcoes]', e.message); return json(res, 502, { error: 'Erro ao listar: ' + e.message }); }
    return json(res, 200, { correcoes: out, total: out.length });
  }
  // ─── APAGAR TODAS AS CORREÇÕES MANUAIS (admin) ────────────────────────────
  if (req.method === 'POST' && pathname === '/api/admin/correcoes/apagar-todas') {
    let apagadas = 0;
    try {
      // conta e apaga os endereços manuais (end: precisão MANUAL)
      const rEnd = await supabaseRequest('GET',
        `/rest/v1/geo_cache?cache_key=like.${encodeURIComponent('end:*')}&${encodeURIComponent('coord_data->>precisao')}=eq.MANUAL&select=cache_key&limit=5000`);
      if (Array.isArray(rEnd.body)) apagadas += rEnd.body.length;
      await supabaseRequest('DELETE',
        `/rest/v1/geo_cache?cache_key=like.${encodeURIComponent('end:*')}&${encodeURIComponent('coord_data->>precisao')}=eq.MANUAL`);
      // conta e apaga os CEPs manuais (cep: manual=true)
      const rCep = await supabaseRequest('GET',
        `/rest/v1/geo_cache?cache_key=like.${encodeURIComponent('cep:*')}&${encodeURIComponent('coord_data->>manual')}=eq.true&select=cache_key&limit=5000`);
      if (Array.isArray(rCep.body)) apagadas += rCep.body.length;
      await supabaseRequest('DELETE',
        `/rest/v1/geo_cache?cache_key=like.${encodeURIComponent('cep:*')}&${encodeURIComponent('coord_data->>manual')}=eq.true`);
      // limpa o cache em memória dos que eram manuais
      for (const k in memoriaCache) {
        const v = memoriaCache[k];
        if (v && ((k.indexOf('end:') === 0 && v.precisao === 'MANUAL') || (k.indexOf('cep:') === 0 && v.manual === true))) delete memoriaCache[k];
      }
    } catch(e) { console.error('[correcoes apagar-todas]', e.message); return json(res, 502, { error: 'Erro ao apagar: ' + e.message }); }
    console.log(`[correcoes] TODAS apagadas: ${apagadas} (por ${req.usuarioAtual.usuario})`);
    return json(res, 200, { ok: true, apagadas });
  }
  // ─── EXCLUIR UMA CORREÇÃO MANUAL (admin) ──────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/admin/correcoes/excluir') {
    const body = await readBody(req);
    const ck = String(body.cacheKey || '');
    if (!/^(end:|cep:)/.test(ck)) return json(res, 400, { error: 'cacheKey inválido' });
    await supabaseDelete(ck);
    console.log(`[correcoes] excluída ${ck.substring(0,45)} (por ${req.usuarioAtual.usuario})`);
    return json(res, 200, { ok: true });
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

  // ─── AJEITAR ENDEREÇO SEM GEOCODIFICAR (admin — p/ jogar no Circuit) ──────
  // puxa a rua (CNEFE → CEP/Correios → texto) + complemento, sem coordenada nem numeração.
  if (req.method === 'POST' && pathname === '/api/endereco/ajeitar') {
    const body = await readBody(req);
    const endereco = aplicarCorrecoesNome(body.endereco, await getCorrecoesNome());
    const cepD = (body.cep || '').replace(/\D/g, '');
    const num = numeroDoTexto(endereco);
    const ctx = { usuario: req.usuarioAtual.usuario, cep: cepD };
    const cepInfo = cepD.length === 8 ? await ruaPeloCep(cepD, ctx) : { rua: '', cidade: '' };
    let rua = '';
    // 1) rua exata da casa no CNEFE (grátis), se tiver nome de verdade
    if (cepD.length === 8 && num) {
      const loc = await buscarCnefe(cepD, num);
      if (loc && !ruaSemNome(loc.logradouro)) rua = loc.logradouro;
    }
    const info = await extrairInfoIA(endereco, cepInfo.rua || '', ctx);
    if (!rua) rua = info.rua || cepInfo.rua || '';           // 2) rua do CEP  3) rua do texto
    const complemento = info.complemento || 'S/N';
    const cidadeValida = body.cidade && !/^\d+$/.test(body.cidade) ? body.cidade : '';
    const cidadeFinal = cepInfo.cidade || cidadeValida || 'São José';
    const cepFmt = cepD.length === 8 ? `${cepD.slice(0,5)}-${cepD.slice(5)}` : (body.cep || '');
    const enderecoNormalizado = rua
      ? `${rua}, ${complemento}, ${cidadeFinal}, SC, Brasil`
      : `${complemento}, ${cidadeFinal}, SC, Brasil`;
    return json(res, 200, { enderecoNormalizado, rua, complemento, cidade: cidadeFinal, cep: cepFmt });
  }

  // ─── ADMIN: definir tipo de conta e limite de rotas de um usuário ─────────
  if (req.method === 'POST' && pathname === '/api/admin/conta') {
    const body = await readBody(req);
    const alvo = String(body.usuario || '').trim().toLowerCase();
    const lista = await getUsuarios();
    const u = lista.find(x => x.usuario === alvo);
    if (!u) return json(res, 404, { error: 'Usuário não encontrado' });
    if (body.tipoConta === 'empresa' || body.tipoConta === 'motorista') u.tipoConta = body.tipoConta;
    if (body.limiteRotas != null) {
      const n = parseInt(body.limiteRotas, 10);
      if (isFinite(n) && n >= 1 && n <= 99) u.limiteRotas = n;
    }
    if (body.diasPlano != null) {
      const d = parseInt(body.diasPlano, 10);
      if (isFinite(d) && d > 0) { u.planoProprio = true; u.planoAte = Date.now() + d * 86400000; }
    }
    await setUsuarios(lista);
    console.log(`[admin-conta] ${alvo}: tipo=${u.tipoConta} limite=${u.limiteRotas || '-'} (por ${req.usuarioAtual.usuario})`);
    return json(res, 200, { ok: true, tipoConta: u.tipoConta, limiteRotas: limiteRotasDe(u) });
  }

  // ─── ZONAS SALVAS (polígonos de rota reutilizáveis) — por usuário ─────────
  // empresa desenha as áreas uma vez e reaproveita todo dia.
  if (req.method === 'GET' && pathname === '/api/zonas') {
    const z = await supabaseGet('zonas:' + req.usuarioAtual.usuario);
    return json(res, 200, { zonas: Array.isArray(z) ? z : [] });
  }
  if (req.method === 'POST' && pathname === '/api/zonas') {
    const body = await readBody(req);
    const zonas = (Array.isArray(body.zonas) ? body.zonas : []).slice(0, 60).map(z => ({
      nome: String(z.nome || 'Rota').substring(0, 40),
      cor: String(z.cor || '#4f8ef7').substring(0, 12),
      latlngs: (Array.isArray(z.latlngs) ? z.latlngs : []).slice(0, 400)
        .map(p => [Number(p[0]), Number(p[1])]).filter(p => isFinite(p[0]) && isFinite(p[1]))
    })).filter(z => z.latlngs.length >= 3);
    await supabaseSet('zonas:' + req.usuarioAtual.usuario, zonas);
    console.log(`[zonas] ${req.usuarioAtual.usuario}: ${zonas.length} zona(s) salva(s)`);
    return json(res, 200, { ok: true, total: zonas.length });
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
        // plano ativo: usa o POOL de chaves do admin (não pede mais chave do usuário)
      } else if (trialStatus(meuRec).ativo) {
        // período de teste grátis (3 dias) ainda válido — usa o pool normalmente
      } else {
        return json(res, 402, { error: 'Seu teste grátis acabou. Assine um plano para continuar.', trialAcabou: true });
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
      // Se achar com nome de rua DE VERDADE, nem toca no Google. Se o CNEFE só tem
      // "SEM DENOMINAÇÃO" (rua/beco sem nome oficial no IBGE), guarda a coordenada como
      // reserva e tenta o Google primeiro, pra pegar um nome melhor.
      const cepDig0 = (cep || '').replace(/\D/g, '');
      const num0 = numeroDoTexto(endereco);
      let cnefeReserva = null;
      if (cepDig0.length === 8 && num0) {
        const local = await buscarCnefe(cepDig0, num0);
        if (local) {
          if (ruaSemNome(local.logradouro)) {
            cnefeReserva = { ...local, numero: num0 }; // sem nome → tenta Google antes
          } else {
            const enderecoNormalizado = `${local.logradouro}, ${num0}, ${local.cidade}, SC, Brasil`;
            const resultado = { lat: local.lat, lng: local.lng, enderecoFormatado: enderecoNormalizado, enderecoNormalizado, logradouro: local.logradouro, bairro: local.bairro, cidade: local.cidade, precisao: 'CNEFE', ruaCep: local.logradouro, complemento: num0, fromCache: false };
            await supabaseSet(cacheKey, resultado);
            console.log(`[geocode] ✓ CNEFE ${enderecoNormalizado.substring(0,50)}`);
            return json(res, 200, resultado);
          }
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

      // fallback 4.5: o Google não achou nome melhor, mas o CNEFE tinha a coordenada exata
      // da casa (só sem nome oficial da rua) — usa esse ponto, é bem mais preciso que o CEP.
      if (!coord && cnefeReserva) {
        const nomeRua = info.rua || cnefeReserva.logradouro;
        const enderecoNormalizado = `${nomeRua}, ${cnefeReserva.numero}, ${cnefeReserva.cidade}, SC, Brasil`;
        coord = { lat: cnefeReserva.lat, lng: cnefeReserva.lng, enderecoFormatado: enderecoNormalizado, enderecoNormalizado, logradouro: nomeRua, bairro: cnefeReserva.bairro, cidade: cnefeReserva.cidade, precisao: 'CNEFE', complemento: cnefeReserva.numero };
        console.log(`[geocode] ✓ CNEFE (reserva, sem nome) ${enderecoNormalizado.substring(0,50)}`);
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
      // planilha sem coluna de endereço: o ponto é do nível da RUA (não da casa) — marca
      // pra aparecer como impreciso na lista e no mapa
      if (!endereco) { resultado.precisao = 'SEM_NUMERO'; resultado.semEndereco = true; }
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
    // qualquer um pode apagar a PRÓPRIA importação; só o admin pode apagar a de outro
    const pedido = (body && body.usuario) ? String(body.usuario).trim().toLowerCase() : '';
    const alvo = (pedido && req.usuarioAtual.admin) ? pedido : req.usuarioAtual.usuario.trim().toLowerCase();
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
