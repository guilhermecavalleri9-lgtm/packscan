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

async function supabaseClear() {
  Object.keys(memoriaCache).forEach(k => delete memoriaCache[k]);
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await supabaseRequest('DELETE', '/rest/v1/geo_cache?cache_key=neq.null');
  } catch(e) { console.error('[supabase clear]', e.message); }
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

// ─── PASSO 1: rua pelo CEP via Google ────────────────────────────────────────
async function ruaPeloCep(cep) {
  if (!cep || cep.length !== 8) return { rua: '', bairro: '', cidade: '' };
  const cepKey = 'cep:' + cep;
  const cached = await supabaseGet(cepKey);
  if (cached) { console.log(`[cep-cache] ${cep}`); return cached; }

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
        const resultado = {
          rua: get('route'),
          bairro: get('sublocality_level_1') || get('sublocality') || get('neighborhood'),
          cidade: get('administrative_area_level_2'),
          lat, lng
        };
        await supabaseSet(cepKey, resultado);
        console.log(`[cep] ${cep} → ${resultado.rua || '(sem rua)'}, ${resultado.cidade}`);
        return resultado;
      } else {
        console.log(`[cep] ${cep} → resultado inválido (${estado}) — ignorado`);
      }
    }
  } catch(e) { console.error(`[cep] erro ${cep}:`, e.message); }
  return { rua: '', bairro: '', cidade: '' };
}

// ─── PASSO 2: IA extrai número/complemento ────────────────────────────────────
function extrairNumeroLocal(complemento) {
  let c = complemento
    .replace(/portão|portao|branco|preto|amarelo|azul|verde|fundo|frente|lateral|descendo|subindo|referencia|ref\.|obs\.|entregar|fachada/gi, '')
    .replace(/CPF[\s:]*[\d.\-]+/gi, '')
    .replace(/\s{2,}/g, ' ').trim();
  c = c.replace(/^(Rua|Av|Avenida|Travessa|Alameda)\s+[^,\d]+[,\s]+/i, '').trim();
  const nums = c.match(/\d[\d\s]*(?:ap(?:to)?\.?\s*\d+)?(?:\s*bloco\s*\w+)?/i);
  return nums ? nums[0].trim() : c.substring(0, 20);
}

async function extrairNumeroIA(complemento, ruaCep) {
  if (!ANTHROPIC_KEY) return extrairNumeroLocal(complemento);

  const prompt = `Do complemento de entrega abaixo, extraia APENAS o número/identificador necessário para localizar o imóvel.

Rua (já conhecida): "${ruaCep}"
Complemento bruto: "${complemento}"

Extraia:
- Número da casa/prédio: "158 casa 2" → "158, Casa 2"
- Apartamento: "3147 ap 201 bloco 23" → "3147, Ap 201, Bloco 23"
- Lote/Quadra: "lote 24 quadra 10" → "Quadra 10, Lote 24"
- Se o complemento JÁ TEM a rua, extraia só o número

Remova: cores de portão, referências, CPF, nomes de pessoas, observações.
Responda APENAS com o número/complemento extraído, uma linha, sem explicação.`;

  try {
    const result = await httpsPost('api.anthropic.com', '/v1/messages',
      { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 80, messages: [{ role: 'user', content: prompt }] })
    );
    const texto = result.content?.[0]?.text?.trim() || '';
    if (texto && texto.length < 60) {
      console.log(`[ia] "${complemento.substring(0,30)}" → "${texto}"`);
      return texto;
    }
  } catch(e) { console.error('[ia] erro:', e.message); }
  return extrairNumeroLocal(complemento);
}

// ─── PASSO 3: geocodifica endereço completo ───────────────────────────────────
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

// ─── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // página principal
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    fs.readFile(path.join(__dirname, 'packscan.html'), (err, data) => {
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

  // ─── POST /api/geocode ────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/geocode') {
    const body = await readBody(req);
    const { endereco, bairro, cidade, cep } = body;
    if (!endereco && !cep) return json(res, 400, { error: 'endereco ou cep obrigatório' });

    // chave do cache
    const cacheKey = 'end:' + `${cep}|${endereco}`.toLowerCase().trim();

    // verifica cache Supabase
    const cached = await supabaseGet(cacheKey);
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

      // fluxo normal: CEP → rua → IA extrai número → geocodifica
      const cepInfo = cep ? await ruaPeloCep(cep.replace(/\D/g,'')) : { rua:'', bairro:'', cidade:'' };
      const ruaCep = cepInfo.rua;
      const numeroExtraido = await extrairNumeroIA(endereco, ruaCep);

      let enderecoFinal, coord;

      // melhor caso: rua do CEP + número extraído
      if (ruaCep && numeroExtraido) {
        enderecoFinal = `${ruaCep}, ${numeroExtraido}, ${cepInfo.cidade||cidade||'São José'}, SC, Brasil`;
        coord = await geocodificarEndereco(enderecoFinal);
      }

      // fallback 1: endereço bruto completo se tiver nome de rua
      if (!coord && /^(rua|av|avenida|travessa|alameda|estrada)/i.test(endereco)) {
        const endLimpo = endereco
          .replace(/portão|portao|branco|preto|referencia|ref\.|obs\.|entregar|fachada|descendo|subindo/gi, '')
          .replace(/\s{2,}/g,' ').trim();
        enderecoFinal = `${endLimpo}, ${cidade||'São José'}, SC, Brasil`;
        coord = await geocodificarEndereco(enderecoFinal);
      }

      // fallback 2: CEP + número + cidade
      if (!coord && cep && numeroExtraido) {
        const cepFmt = `${cep.substring(0,5)}-${cep.substring(5)}`;
        enderecoFinal = `${cepFmt}, ${numeroExtraido}, ${cidade||'São José'}, SC, Brasil`;
        coord = await geocodificarEndereco(enderecoFinal);
      }

      // fallback 3: coordenada do CEP
      if (!coord && cepInfo.lat) {
        coord = { lat: cepInfo.lat, lng: cepInfo.lng, enderecoFormatado: `CEP ${cep}`, precisao: 'APPROXIMATE' };
        enderecoFinal = `CEP ${cep}`;
      }

      if (!coord) {
        console.log(`[geocode] não encontrado: ${endereco.substring(0,40)}`);
        return json(res, 404, { error: 'Endereço não encontrado', enderecoFinal });
      }

      const resultado = { ...coord, enderecoNormalizado: enderecoFinal, ruaCep, numeroExtraido, fromCache: false };
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
