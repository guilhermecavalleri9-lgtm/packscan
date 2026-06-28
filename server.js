const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY || 'AIzaSyCHRl5eRHAfw0-WVEBj0wC5tpbJ81265gk';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const ROTAS_FILE = path.join(__dirname, 'rotas_salvas.json');

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

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { return {}; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data)); } catch(e) {}
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
        resolve({ status: r.statusCode, body: parsed });
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

function base64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function base64urlDecode(str) { return Buffer.from(str.replace(/-/g,'+').replace(/_/g,'/'), 'base64'); }

function gerarToken(usuario, admin, expiraEm) {
  // exp do token = padrão 7 dias, mas nunca depois da validade de acesso do usuário (se houver)
  let exp = Date.now() + TOKEN_VALIDADE_MS;
  if (expiraEm && expiraEm < exp) exp = expiraEm;
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

async function ruaPeloCep(cep) {
  if (!cep || cep.length !== 8) return { rua: '', bairro: '', cidade: '' };
  const cepKey = 'cep:' + cep;
  const cached = await supabaseGet(cepKey);
  if (cached && (cached.rua || cached.manual)) { console.log(`[cep-cache] ${cep}`); return cached; }

  let resultado = cached || { rua: '', bairro: '', cidade: '' };
  const cepFmt = `${cep.substring(0,5)}-${cep.substring(5)}`;
  const query = encodeURIComponent(`${cepFmt}, Brasil`);
  try {
    const d = await httpsGet('maps.googleapis.com',
      `/maps/api/geocode/json?address=${query}&key=${GOOGLE_KEY}&language=pt-BR&region=BR`
    );
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

async function extrairInfoIA(textoBruto, ruaCep) {
  textoBruto = textoBruto || '';
  if (!textoBruto.trim()) return { rua: '', complemento: 'S/N' };
  if (!ANTHROPIC_KEY) return extrairNumeroLocal(textoBruto);

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
      { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 150, messages: [{ role: 'user', content: prompt }] })
    );
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
async function geocodificarValidado(enderecoCompleto, cepInfo) {
  const coord = await geocodificarEndereco(enderecoCompleto);
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

async function geocodificarEndereco(enderecoCompleto) {
  const query = encodeURIComponent(enderecoCompleto);
  const d = await httpsGet('maps.googleapis.com',
    `/maps/api/geocode/json?address=${query}&key=${GOOGLE_KEY}&language=pt-BR&region=BR`
  );
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
  const AUTH_PUBLICA = new Set(['/api/auth/login', '/api/auth/registrar']);
  // rotas que, além de logado, exigem admin
  const SOMENTE_ADMIN = new Set(['/api/cache/clear', '/api/pacotes/apagar', '/api/cep/excluir', '/api/nomes/remover', '/api/rotas/apagar', '/api/auth/pendentes', '/api/auth/usuarios', '/api/auth/validade', '/api/auth/aprovar', '/api/auth/rejeitar']);

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
    if (!usuario || senha.length < 4) return json(res, 400, { error: 'Usuário obrigatório e senha com pelo menos 4 caracteres' });
    const lista = await getUsuarios();
    if (lista.some(u => u.usuario === usuario)) return json(res, 409, { error: 'Usuário já existe' });
    // primeiro usuário cadastrado no sistema nasce admin e já aprovado, pra alguém
    // conseguir entrar e aprovar os próximos
    const ehPrimeiro = lista.length === 0;
    lista.push({
      usuario, senhaHash: hashSenha(senha),
      status: ehPrimeiro ? 'aprovado' : 'pendente',
      admin: ehPrimeiro,
      criadoEm: new Date().toISOString()
    });
    await setUsuarios(lista);
    console.log(`[auth] registro: ${usuario}${ehPrimeiro ? ' (primeiro usuário → admin)' : ' (pendente)'}`);
    return json(res, 200, { ok: true, pendente: !ehPrimeiro });
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readBody(req);
    const usuario = (body.usuario || '').trim().toLowerCase();
    const senha = body.senha || '';
    const lista = await getUsuarios();
    const u = lista.find(x => x.usuario === usuario);
    if (!u || !senhaConfere(senha, u.senhaHash)) return json(res, 401, { error: 'Usuário ou senha inválidos' });
    if (u.status !== 'aprovado') return json(res, 403, { error: 'Cadastro ainda não foi aprovado por um administrador' });
    if (u.expiraEm && u.expiraEm < Date.now()) return json(res, 403, { error: 'Seu tempo de acesso expirou. Fale com o administrador.' });
    return json(res, 200, { ok: true, token: gerarToken(u.usuario, u.admin, u.expiraEm), usuario: u.usuario, admin: !!u.admin, expiraEm: u.expiraEm || null });
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const lista = await getUsuarios();
    const u = lista.find(x => x.usuario === req.usuarioAtual.usuario);
    // se o acesso expirou desde o último login, derruba a sessão
    if (u && u.expiraEm && u.expiraEm < Date.now()) return json(res, 401, { error: 'Acesso expirado' });
    return json(res, 200, { usuario: req.usuarioAtual.usuario, admin: req.usuarioAtual.admin, expiraEm: u ? (u.expiraEm || null) : null });
  }

  if (req.method === 'GET' && pathname === '/api/auth/pendentes') {
    const lista = await getUsuarios();
    return json(res, 200, { pendentes: lista.filter(u => u.status === 'pendente').map(u => ({ usuario: u.usuario, criadoEm: u.criadoEm })) });
  }

  // lista todos os usuários com status, admin e validade de acesso (admin)
  if (req.method === 'GET' && pathname === '/api/auth/usuarios') {
    const lista = await getUsuarios();
    return json(res, 200, { usuarios: lista.map(u => ({
      usuario: u.usuario, status: u.status, admin: !!u.admin,
      criadoEm: u.criadoEm || null, expiraEm: u.expiraEm || null
    })) });
  }

  // define a validade de acesso de um usuário: dias>0 = expira em N dias a partir de agora; dias=0 = sem limite (admin)
  if (req.method === 'POST' && pathname === '/api/auth/validade') {
    const body = await readBody(req);
    const usuario = (body.usuario || '').trim().toLowerCase();
    const dias = Number(body.dias);
    if (!Number.isFinite(dias) || dias < 0) return json(res, 400, { error: 'dias inválido' });
    const lista = await getUsuarios();
    const u = lista.find(x => x.usuario === usuario);
    if (!u) return json(res, 404, { error: 'Usuário não encontrado' });
    u.expiraEm = dias > 0 ? Date.now() + dias * 24 * 60 * 60 * 1000 : null;
    await setUsuarios(lista);
    console.log(`[auth] validade de ${usuario}: ${dias > 0 ? dias + ' dias' : 'sem limite'} (por ${req.usuarioAtual.usuario})`);
    return json(res, 200, { ok: true, expiraEm: u.expiraEm });
  }

  if (req.method === 'POST' && pathname === '/api/auth/aprovar') {
    const body = await readBody(req);
    const usuario = (body.usuario || '').trim().toLowerCase();
    const dias = Number(body.dias);
    const lista = await getUsuarios();
    const u = lista.find(x => x.usuario === usuario);
    if (!u) return json(res, 404, { error: 'Usuário não encontrado' });
    u.status = 'aprovado';
    if (Number.isFinite(dias) && dias > 0) u.expiraEm = Date.now() + dias * 24 * 60 * 60 * 1000;
    await setUsuarios(lista);
    console.log(`[auth] aprovado: ${usuario}${Number.isFinite(dias) && dias > 0 ? ' ('+dias+' dias)' : ''} (por ${req.usuarioAtual.usuario})`);
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // página scanner (câmera mobile)
  if (req.method === 'GET' && pathname === '/scanner') {
    fs.readFile(path.join(__dirname, 'scanner.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
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

    // verifica cache Supabase (a menos que "forcar" peça pra ignorar e regeocodificar)
    const cached = body.forcar ? null : await supabaseGet(cacheKey);
    if (cached) {
      console.log(`[cache] ${(endereco||cep||'').substring(0,35)}`);
      return json(res, 200, { ...cached, fromCache: true });
    }

    try {
      // forcarEndereco: geocodifica direto sem passar pelo CEP
      if (body.forcarEndereco && endereco) {
        const coord = await geocodificarEndereco(`${endereco}, SC, Brasil`);
        if (coord) {
          await supabaseSet(cacheKey, { ...coord, enderecoNormalizado: endereco });
          return json(res, 200, { ...coord, enderecoNormalizado: endereco, fromCache: false });
        }
        return json(res, 404, { error: 'Endereço não encontrado' });
      }

      // fluxo: CEP → rua (referência) → IA extrai rua-do-texto + complemento → geocodifica
      const cepInfo = cep ? await ruaPeloCep(cep.replace(/\D/g,'')) : { rua:'', bairro:'', cidade:'' };
      let ruaCep = cepInfo.rua;
      const info = await extrairInfoIA(endereco, ruaCep);
      const complemento = info.complemento || 'S/N';
      const cidadeValida = cidade && !/^\d+$/.test(cidade) ? cidade : '';
      const cidadeFinal = cepInfo.cidade || cidadeValida || 'São José';

      let enderecoFinal, coord;

      // melhor caso: rua MENCIONADA NO PRÓPRIO TEXTO (mais confiável que a rua do CEP,
      // que é só uma aproximação do Google e pode estar errada para a região) — mas ainda
      // valida distância, já que erro de digitação no texto pode casar com uma rua homônima
      // bem longe (ex: "Maria Saturnina de Jesus" → rua errada em outro bairro)
      if (info.rua) {
        enderecoFinal = `${info.rua}, ${complemento}, ${cidadeFinal}, SC, Brasil`;
        coord = await geocodificarValidado(enderecoFinal, cepInfo);
      }

      // fallback 1: rua do CEP + complemento (quando o texto não tinha nome de rua)
      if (!coord && ruaCep) {
        enderecoFinal = `${ruaCep}, ${complemento}, ${cidadeFinal}, SC, Brasil`;
        coord = await geocodificarValidado(enderecoFinal, cepInfo);
      }

      // fallback 1.4: nem o texto nem o Google sabem a rua do CEP — busca no CACHE
      // (qualquer pacote já geocodificado antes pra esse CEP, de qualquer importação)
      if (!coord && !ruaCep && cep) {
        const ruaCache = await buscarRuaApreendidaPorCep(cep);
        if (ruaCache) {
          enderecoFinal = `${ruaCache}, ${complemento}, ${cidadeFinal}, SC, Brasil`;
          coord = await geocodificarValidado(enderecoFinal, cepInfo);
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
        coord = await geocodificarValidado(enderecoFinal, cepInfo);
        if (coord && cep) {
          // aprende essa rua pro CEP, beneficia próximos lotes também
          await supabaseSet('cep:' + cep.replace(/\D/g,''), { ...cepInfo, rua: ruaSugerida, cidade: cidadeFinal });
        }
      }

      // fallback 2: complemento contém nome de comércio/condomínio identificável — busca direto
      if (!coord && complemento && complemento !== 'S/N' && !/^\d/.test(complemento)) {
        enderecoFinal = `${complemento}, ${bairro||''}, ${cidadeFinal}, SC, Brasil`;
        coord = await geocodificarValidado(enderecoFinal, cepInfo);
      }

      // fallback 3: endereço bruto completo, limpo (cobre casos que a IA não capturou bem)
      if (!coord && /^(rua|av|avenida|travessa|alameda|estrada)/i.test(endereco)) {
        const endLimpo = endereco
          .replace(/portão|portao|branco|preto|referencia|ref\.|obs\.|entregar|fachada|descendo|subindo/gi, '')
          .replace(/\s{2,}/g,' ').trim();
        enderecoFinal = `${endLimpo}, ${cidadeFinal}, SC, Brasil`;
        coord = await geocodificarValidado(enderecoFinal, cepInfo);
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
          coord = await geocodificarValidado(enderecoFinal, cepInfo);
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
        coord = await geocodificarValidado(enderecoFinal, cepInfo);
      }

      // fallback 5 (último recurso): coordenada aproximada do CEP — fica marcado pra corrigir
      if (!coord && cepInfo.lat) {
        coord = { lat: cepInfo.lat, lng: cepInfo.lng, enderecoFormatado: `CEP ${cep}`, precisao: 'APPROXIMATE', cidade: cidadeFinal };
      }

      if (!coord) {
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

  // ─── PACOTES ──────────────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/pacotes/salvar') {
    const body = await readBody(req);
    if (!body || !body.pacotes) return json(res, 400, { error: 'pacotes obrigatório' });
    try {
      // salva como um único registro no Supabase
      await supabaseRequest('DELETE', '/rest/v1/pacotes_dia?id=neq.0');
      await supabaseRequest('POST', '/rest/v1/pacotes_dia', {
        dados: body.pacotes,
        arquivo: body.arquivo || '',
        total: body.pacotes.length,
        salvo_em: new Date().toISOString()
      });
      console.log(`[pacotes] ${body.pacotes.length} pacotes salvos`);
      return json(res, 200, { ok: true, total: body.pacotes.length });
    } catch(e) {
      console.error('[pacotes save]', e.message);
      return json(res, 500, { error: e.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/pacotes/carregar') {
    try {
      const r = await supabaseRequest('GET', '/rest/v1/pacotes_dia?select=*&limit=1&order=salvo_em.desc');
      const result = r.body;
      if (result && result[0]) return json(res, 200, { pacotes: result[0].dados, arquivo: result[0].arquivo, salvoEm: result[0].salvo_em, total: result[0].total });
      return json(res, 200, { pacotes: [], salvoEm: null });
    } catch(e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/pacotes/apagar') {
    try {
      await supabaseRequest('DELETE', '/rest/v1/pacotes_dia?id=neq.0');
      return json(res, 200, { ok: true });
    } catch(e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ─── ROTAS ────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/rotas/salvar') {
    const body = await readBody(req);
    if (!body || !body.rotas) return json(res, 400, { error: 'rotas obrigatório' });
    saveJSON(ROTAS_FILE, { rotas: body.rotas, salvoEm: new Date().toISOString() });
    console.log(`[rotas] ${body.rotas.length} rotas salvas`);
    return json(res, 200, { ok: true, total: body.rotas.length });
  }

  if (req.method === 'GET' && pathname === '/api/rotas/carregar') {
    const data = loadJSON(ROTAS_FILE);
    return json(res, 200, data.rotas ? data : { rotas: [], salvoEm: null });
  }

  if (req.method === 'POST' && pathname === '/api/rotas/apagar') {
    saveJSON(ROTAS_FILE, { rotas: [], salvoEm: null });
    return json(res, 200, { ok: true });
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => console.log(`✅ PackScan na porta ${PORT} | Supabase: ${SUPABASE_URL ? 'conectado' : 'não configurado'}`));
