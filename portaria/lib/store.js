// ═══════════════════════════════════════════════════════════════════════════════
// STORE — guarda os dados do app (chave → JSON)
// ═══════════════════════════════════════════════════════════════════════════════
// Dois modos, escolhidos pelas variáveis de ambiente:
//   • arquivo  (padrão): grava em dados/ dentro da pasta do app. Simples, funciona
//                        no computador da portaria sem depender de nada.
//   • supabase (quando SUPABASE_URL + SUPABASE_KEY existem): grava na tabela
//                        portaria_kv, pra não perder nada quando o servidor é
//                        reiniciado numa hospedagem que apaga o disco.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const https = require('https');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'dados');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const TABELA = process.env.SUPABASE_TABELA || 'portaria_kv';
const usandoSupabase = !!(SUPABASE_URL && SUPABASE_KEY);

// cache em memória: leitura instantânea e menos ida ao banco
const memoria = new Map();

// ─── modo arquivo ─────────────────────────────────────────────────────────────
function caminhoDe(chave) {
  const seguro = String(chave).replace(/[^a-zA-Z0-9:_-]/g, '_').replace(/:/g, '__');
  return path.join(DATA_DIR, seguro + '.json');
}
async function arquivoGet(chave) {
  try { return JSON.parse(await fsp.readFile(caminhoDe(chave), 'utf8')); }
  catch (e) { return null; }
}
async function arquivoSet(chave, valor) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const destino = caminhoDe(chave);
  const temp = destino + '.tmp' + process.pid;
  // grava no temporário e renomeia: se faltar energia no meio, o arquivo bom continua lá
  await fsp.writeFile(temp, JSON.stringify(valor), 'utf8');
  await fsp.rename(temp, destino);
}
async function arquivoDel(chave) {
  try { await fsp.unlink(caminhoDe(chave)); } catch (e) {}
}

// ─── modo supabase ────────────────────────────────────────────────────────────
function supabaseReq(metodo, caminho, corpo) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPABASE_URL + caminho);
    const buf = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: metodo,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(buf ? { 'Content-Length': buf.length } : {})
      }
    }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        let body = null;
        try { body = data ? JSON.parse(data) : null; } catch (e) { body = data; }
        resolve({ status: r.statusCode, body });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('supabase: tempo esgotado')));
    if (buf) req.write(buf);
    req.end();
  });
}
async function supabaseGet(chave) {
  const r = await supabaseReq('GET', `/rest/v1/${TABELA}?chave=eq.${encodeURIComponent(chave)}&select=valor&limit=1`);
  if (r.status >= 300) { console.error('[store] erro ao ler', chave, r.status, JSON.stringify(r.body).slice(0, 200)); return null; }
  return (r.body && r.body[0]) ? r.body[0].valor : null;
}
async function supabaseSet(chave, valor) {
  // upsert manual (funciona mesmo sem constraint única declarada)
  const existe = await supabaseReq('GET', `/rest/v1/${TABELA}?chave=eq.${encodeURIComponent(chave)}&select=chave&limit=1`);
  const linha = { valor, atualizado_em: new Date().toISOString() };
  const r = (existe.body && existe.body[0])
    ? await supabaseReq('PATCH', `/rest/v1/${TABELA}?chave=eq.${encodeURIComponent(chave)}`, linha)
    : await supabaseReq('POST', `/rest/v1/${TABELA}`, { chave, ...linha });
  if (r.status >= 300) console.error('[store] erro ao gravar', chave, r.status, JSON.stringify(r.body).slice(0, 200));
}
async function supabaseDel(chave) {
  await supabaseReq('DELETE', `/rest/v1/${TABELA}?chave=eq.${encodeURIComponent(chave)}`);
}

// ─── interface usada pelo servidor ────────────────────────────────────────────
async function get(chave) {
  if (memoria.has(chave)) return memoria.get(chave);
  const v = usandoSupabase ? await supabaseGet(chave) : await arquivoGet(chave);
  if (v !== null && v !== undefined) memoria.set(chave, v);
  return v === undefined ? null : v;
}
async function set(chave, valor) {
  memoria.set(chave, valor);
  if (usandoSupabase) await supabaseSet(chave, valor);
  else await arquivoSet(chave, valor);
}
async function del(chave) {
  memoria.delete(chave);
  if (usandoSupabase) await supabaseDel(chave);
  else await arquivoDel(chave);
}

module.exports = { get, set, del, usandoSupabase, DATA_DIR };
