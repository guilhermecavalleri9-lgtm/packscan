const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY || 'AIzaSyCHRl5eRHAfw0-WVEBj0wC5tpbJ81265gk';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEO_CACHE_FILE = path.join(__dirname, 'geo_cache.json');
const CEP_CACHE_FILE = path.join(__dirname, 'cep_cache.json');

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

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { return {}; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data)); } catch(e) { console.error('save error:', e.message); }
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
      r => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      }
    );
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// ─── PASSO 1: busca rua pelo CEP via Google Maps ──────────────────────────────
async function ruaPeloCep(cep) {
  const cepCache = loadJSON(CEP_CACHE_FILE);
  if (cepCache[cep]) return cepCache[cep];

  const cepFmt = `${cep.substring(0,5)}-${cep.substring(5)}`;
  const query = encodeURIComponent(`${cepFmt}, Brasil`);
  const reqPath = `/maps/api/geocode/json?address=${query}&key=${GOOGLE_KEY}&language=pt-BR&region=BR`;

  try {
    const d = await httpsGet('maps.googleapis.com', reqPath);
    if (d.status === 'OK' && d.results[0]) {
      const comps = d.results[0].address_components;
      const get = type => (comps.find(c => c.types.includes(type)) || {}).long_name || '';
      const resultado = {
        rua: get('route'),
        bairro: get('sublocality_level_1') || get('sublocality') || get('neighborhood'),
        cidade: get('administrative_area_level_2'),
        lat: d.results[0].geometry.location.lat,
        lng: d.results[0].geometry.location.lng
      };
      cepCache[cep] = resultado;
      saveJSON(CEP_CACHE_FILE, cepCache);
      console.log(`[cep] ${cep} → ${resultado.rua}, ${resultado.cidade}`);
      return resultado;
    }
  } catch(e) {
    console.error(`[cep] erro ${cep}: ${e.message}`);
  }
  return { rua: '', bairro: '', cidade: '' };
}

// ─── PASSO 2: IA extrai número/complemento relevante do campo bruto ───────────
async function extrairNumeroIA(complemento, ruaCep) {
  if (!ANTHROPIC_KEY) return extrairNumeroLocal(complemento);

  const prompt = `Do complemento de entrega abaixo, extraia APENAS o número/identificador necessário para localizar o imóvel.

Rua (já conhecida): "${ruaCep}"
Complemento bruto: "${complemento}"

Extraia:
- Número da casa/prédio: "158 casa 2" → "158, Casa 2"  
- Apartamento: "3147 ap 201 bloco 23" → "3147, Ap 201, Bloco 23"
- Lote/Quadra: "lote 24 quadra 10" → "Quadra 10, Lote 24"
- Condomínio: "1290 bloco L 207" → "1290, Bloco L, Ap 207"
- Se o complemento JÁ TEM a rua repetida (ex: "Rua X Rua X 94"), extraia só o número: "94"

Remova: cores de portão, referências ("ao lado do bar"), CPF, nomes de pessoas, "casa", "subindo o morro"

Responda APENAS com o número/complemento extraído, uma linha, sem explicação.`;

  try {
    const result = await httpsPost(
      'api.anthropic.com', '/v1/messages',
      { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 80, messages: [{ role: 'user', content: prompt }] })
    );
    const texto = result.content?.[0]?.text?.trim() || '';
    if (texto && texto.length < 60) {
      console.log(`[ia] "${complemento.substring(0,30)}" → "${texto}"`);
      return texto;
    }
  } catch(e) {
    console.error('[ia] erro:', e.message);
  }
  return extrairNumeroLocal(complemento);
}

function extrairNumeroLocal(complemento) {
  // remove lixo
  let c = complemento
    .replace(/\b(portão|portao|branco|preto|amarelo|azul|verde|fundo|frente|lateral|casa|subindo|descendo|referencia|ref\.?|obs\.?|entregar|fachada)\b[^,\d]*/gi, ' ')
    .replace(/CPF[\s:]*[\d.\-]+/gi, '')
    .replace(/\s{2,}/g, ' ').trim();
  // se começa com nome de rua, remove a rua e fica só número
  c = c.replace(/^(Rua|Av|Avenida|Travessa|Alameda)\s+[^,\d]+[,\s]+/i, '').trim();
  // extrai número principal + apto/bloco
  const nums = c.match(/\d[\d\s]*(?:ap(?:to)?\.?\s*\d+)?(?:\s*bloco\s*\w+)?/i);
  return nums ? nums[0].trim() : c.substring(0, 20);
}

// ─── PASSO 3: geocodifica o endereço completo ─────────────────────────────────
async function geocodificarEndereco(enderecoCompleto) {
  const query = encodeURIComponent(enderecoCompleto);
  const reqPath = `/maps/api/geocode/json?address=${query}&key=${GOOGLE_KEY}&language=pt-BR&region=BR`;
  const d = await httpsGet('maps.googleapis.com', reqPath);
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

  // ─── POST /api/geocode ────────────────────────────────────────────────────
  // body: { tracking, endereco, bairro, cidade, cep }
  if (req.method === 'POST' && pathname === '/api/geocode') {
    const body = await readBody(req);
    const { endereco, bairro, cidade, cep } = body;
    if (!endereco && !cep) return json(res, 400, { error: 'endereco ou cep obrigatório' });

    // chave do cache = endereco bruto + cep
    const cacheKey = `${cep}|${endereco}`.toLowerCase().trim();
    const geoCache = loadJSON(GEO_CACHE_FILE);
    if (geoCache[cacheKey]) {
      console.log(`[cache] ${endereco.substring(0,35)}`);
      return json(res, 200, { ...geoCache[cacheKey], fromCache: true });
    }

    try {
      // PASSO 1: pega rua pelo CEP via Google
      const cepInfo = cep ? await ruaPeloCep(cep.replace(/\D/g,'')) : { rua: '', bairro: '', cidade: '' };
      const ruaCep = cepInfo.rua;

      // PASSO 2: IA extrai número/complemento relevante
      const numeroExtraido = await extrairNumeroIA(endereco, ruaCep);

      // PASSO 3: monta endereço e geocodifica
      let enderecoFinal, coord;

      if (ruaCep && numeroExtraido) {
        // melhor caso: rua do CEP + número extraído
        enderecoFinal = `${ruaCep}, ${numeroExtraido}, ${cepInfo.cidade || cidade || 'São José'}, SC, Brasil`;
        coord = await geocodificarEndereco(enderecoFinal);
      }

      // fallback 1: endereço bruto completo se tiver nome de rua
      if (!coord && /^(rua|av|avenida|travessa|alameda|estrada)/i.test(endereco)) {
        const endLimpo = endereco
          .replace(/\b(portão|portao|branco|preto|referencia|ref\.|obs\.|entregar|fachada|descendo|subindo|casa)\b[^,\d]*/gi, '')
          .replace(/\s{2,}/g, ' ').trim();
        enderecoFinal = `${endLimpo}, ${cidade || 'São José'}, SC, Brasil`;
        coord = await geocodificarEndereco(enderecoFinal);
      }

      // fallback 2: só CEP + número
      if (!coord && cep && numeroExtraido) {
        const cepFmt = `${cep.substring(0,5)}-${cep.substring(5)}`;
        enderecoFinal = `${cepFmt}, ${numeroExtraido}, Brasil`;
        coord = await geocodificarEndereco(enderecoFinal);
      }

      // fallback 3: só CEP
      if (!coord && cepInfo.lat) {
        coord = { lat: cepInfo.lat, lng: cepInfo.lng, enderecoFormatado: `CEP ${cep}`, precisao: 'APPROXIMATE' };
        enderecoFinal = `CEP ${cep}`;
      }

      if (!coord) {
        console.log(`[geocode] não encontrado: ${endereco.substring(0,40)}`);
        return json(res, 404, { error: 'Endereço não encontrado', enderecoFinal });
      }

      const resultado = {
        ...coord,
        enderecoNormalizado: enderecoFinal,
        ruaCep,
        numeroExtraido,
        fromCache: false
      };

      geoCache[cacheKey] = resultado;
      saveJSON(GEO_CACHE_FILE, geoCache);
      console.log(`[geocode] ✓ ${enderecoFinal.substring(0,55)} (${coord.precisao})`);
      return json(res, 200, resultado);

    } catch(e) {
      console.error(`[geocode] erro: ${e.message}`);
      return json(res, 500, { error: e.message });
    }
  }

  // status do cache
  if (req.method === 'GET' && pathname === '/api/cache') {
    const geo = loadJSON(GEO_CACHE_FILE);
    const cep = loadJSON(CEP_CACHE_FILE);
    return json(res, 200, { enderecos: Object.keys(geo).length, ceps: Object.keys(cep).length });
  }

  // limpar cache
  if (req.method === 'POST' && pathname === '/api/cache/clear') {
    saveJSON(GEO_CACHE_FILE, {});
    saveJSON(CEP_CACHE_FILE, {});
    return json(res, 200, { ok: true });
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => console.log(`✅ PackScan na porta ${PORT}`));
