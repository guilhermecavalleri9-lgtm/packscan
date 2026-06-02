const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || 'AIzaSyCHRl5eRHAfw0-WVEBj0wC5tpbJ81265gk';
const CEP_CACHE_FILE = path.join(__dirname, 'cep_cache.json');

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function loadCepCache() {
  try { return JSON.parse(fs.readFileSync(CEP_CACHE_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveCepCache(data) {
  try { fs.writeFileSync(CEP_CACHE_FILE, JSON.stringify(data)); } catch(e) { console.error('Erro ao salvar cache:', e.message); }
}

function json(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

// ─── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // ─── PAGINA PRINCIPAL ──────────────────────────────────────────────────────
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    fs.readFile(path.join(__dirname, 'packscan.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ─── GEOCODE por CEP ──────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/geocode') {
    const cep = parsedUrl.query.cep ? parsedUrl.query.cep.replace(/\D/g, '') : '';
    if (!cep || cep.length < 8) return json(res, 400, { error: 'CEP inválido' });

    // verifica cache
    const cache = loadCepCache();
    if (cache[cep]) {
      console.log(`[cache] ${cep}`);
      return json(res, 200, { ...cache[cep], fromCache: true });
    }

    // consulta Google Maps
    const query = encodeURIComponent(cep.substring(0,5) + '-' + cep.substring(5) + ', Brasil');
    const googlePath = `/maps/api/geocode/json?address=${query}&key=${GOOGLE_MAPS_KEY}&language=pt-BR&region=BR`;

    try {
      const result = await new Promise((resolve, reject) => {
        https.get({ hostname: 'maps.googleapis.com', path: googlePath }, r => {
          let data = '';
          r.on('data', c => data += c);
          r.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        }).on('error', reject);
      });

      if (result.status !== 'OK' || !result.results[0]) {
        console.log(`[geocode] não encontrado: ${cep} — status: ${result.status}`);
        return json(res, 404, { error: 'CEP não encontrado', status: result.status });
      }

      const r = result.results[0];
      const loc = r.geometry.location;
      const comps = r.address_components;
      const getComp = (type) => (comps.find(c => c.types.includes(type)) || {}).long_name || '';

      const coord = {
        lat: loc.lat,
        lng: loc.lng,
        logradouro: getComp('route'),
        bairro: getComp('sublocality_level_1') || getComp('sublocality') || getComp('neighborhood'),
        cidade: getComp('administrative_area_level_2'),
        estado: getComp('administrative_area_level_1'),
        formatted: r.formatted_address
      };

      cache[cep] = coord;
      saveCepCache(cache);
      console.log(`[geocode] ${cep} → ${coord.logradouro || coord.bairro}, ${coord.cidade}`);
      return json(res, 200, { ...coord, fromCache: false });

    } catch(e) {
      console.error(`[geocode] erro: ${e.message}`);
      return json(res, 500, { error: 'Erro ao consultar Google: ' + e.message });
    }
  }

  // ─── CACHE: listar todos ──────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/cache') {
    const cache = loadCepCache();
    return json(res, 200, { total: Object.keys(cache).length, cache });
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => console.log(`✅ PackScan rodando na porta ${PORT}`));
