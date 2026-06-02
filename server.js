const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || 'AIzaSyCHRl5eRHAfw0-WVEBj0wC5tpbJ81265gk';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEO_CACHE_FILE = path.join(__dirname, 'geo_cache.json');

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
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveCache(data) {
  try { fs.writeFileSync(GEO_CACHE_FILE, JSON.stringify(data)); } catch(e) { console.error('cache write error:', e.message); }
}

function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function httpsPost(hostname, path, headers, payload) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(payload);
    const req = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': buf.length } }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// ─── NORMALIZAR ENDEREÇO VIA CLAUDE ──────────────────────────────────────────
async function normalizarEndereco(endereco, bairro, cidade, cep) {
  if (!ANTHROPIC_KEY) {
    // sem IA: retorna o endereço como está + cidade/bairro
    return `${endereco}, ${bairro}, ${cidade}, SC, Brasil`;
  }
  const prompt = `Você é um normalizador de endereços brasileiros para geocodificação.

Dado o seguinte endereço bruto de uma transportadora:
- Complemento/endereço: "${endereco}"
- Bairro: "${bairro}"
- Cidade: "${cidade}"
- CEP: "${cep}"

Retorne APENAS o endereço normalizado em uma linha, no formato:
"Rua/Av [nome], [número], [bairro], [cidade], SC, Brasil"

Regras:
- Se o endereço contiver nome de pessoa sem "Rua", adicione "Rua" antes
- Remova informações irrelevantes (CPF, observações, "casa portão branco", etc.)
- Mantenha o número do imóvel
- Se não houver número claro, use apenas rua + bairro + cidade
- Retorne SOMENTE o endereço normalizado, sem explicações`;

  try {
    const result = await httpsPost('api.anthropic.com', '/v1/messages',
      { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }]
      })
    );
    const texto = result.content?.[0]?.text?.trim() || '';
    return texto || `${endereco}, ${bairro}, ${cidade}, SC, Brasil`;
  } catch(e) {
    console.error('Claude error:', e.message);
    return `${endereco}, ${bairro}, ${cidade}, SC, Brasil`;
  }
}

// ─── GEOCODIFICAR VIA GOOGLE ──────────────────────────────────────────────────
async function geocodificar(enderecoNormalizado) {
  const query = encodeURIComponent(enderecoNormalizado);
  const result = await httpsGet('maps.googleapis.com',
    `/maps/api/geocode/json?address=${query}&key=${GOOGLE_MAPS_KEY}&language=pt-BR&region=BR`
  );
  if (result.status !== 'OK' || !result.results[0]) {
    return null;
  }
  const r = result.results[0];
  const loc = r.geometry.location;
  const comps = r.address_components;
  const getComp = (type) => (comps.find(c => c.types.includes(type)) || {}).long_name || '';
  return {
    lat: loc.lat,
    lng: loc.lng,
    enderecoFormatado: r.formatted_address,
    logradouro: getComp('route'),
    numero: getComp('street_number'),
    bairro: getComp('sublocality_level_1') || getComp('sublocality') || getComp('neighborhood'),
    cidade: getComp('administrative_area_level_2'),
    estado: getComp('administrative_area_level_1'),
    precisao: r.geometry.location_type // ROOFTOP, RANGE_INTERPOLATED, GEOMETRIC_CENTER, APPROXIMATE
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

  // ─── PÁGINA PRINCIPAL ──────────────────────────────────────────────────────
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    fs.readFile(path.join(__dirname, 'packscan.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ─── NORMALIZAR + GEOCODIFICAR (com cache) ────────────────────────────────
  // POST /api/geocode  body: { endereco, bairro, cidade, cep }
  if (req.method === 'POST' && pathname === '/api/geocode') {
    const body = await readBody(req);
    const { endereco, bairro, cidade, cep } = body;
    if (!endereco) return json(res, 400, { error: 'endereco obrigatório' });

    // chave do cache = endereço bruto normalizado
    const cacheKey = `${endereco}|${bairro}|${cidade}`.toLowerCase().trim();
    const cache = loadCache();

    if (cache[cacheKey]) {
      console.log(`[cache] ${endereco.substring(0,40)}`);
      return json(res, 200, { ...cache[cacheKey], fromCache: true });
    }

    // normaliza com IA
    console.log(`[normalizar] ${endereco.substring(0,50)}`);
    const endNorm = await normalizarEndereco(endereco, bairro, cidade, cep);
    console.log(`[normalizado] ${endNorm}`);

    // geocodifica
    try {
      const coord = await geocodificar(endNorm);
      if (!coord) {
        console.log(`[geocode] não encontrado: ${endNorm}`);
        return json(res, 404, { error: 'Endereço não encontrado', enderecoNormalizado: endNorm });
      }

      const resultado = { ...coord, enderecoNormalizado: endNorm, fromCache: false };
      cache[cacheKey] = resultado;
      saveCache(cache);
      console.log(`[geocode] ok: ${coord.enderecoFormatado} (${coord.precisao})`);
      return json(res, 200, resultado);

    } catch(e) {
      console.error(`[geocode] erro: ${e.message}`);
      return json(res, 500, { error: e.message, enderecoNormalizado: endNorm });
    }
  }

  // ─── VER CACHE ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/cache') {
    const cache = loadCache();
    return json(res, 200, { total: Object.keys(cache).length });
  }

  // ─── LIMPAR CACHE ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/cache/clear') {
    saveCache({});
    return json(res, 200, { ok: true });
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => console.log(`✅ PackScan na porta ${PORT}`));
