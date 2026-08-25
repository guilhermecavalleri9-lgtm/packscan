// ═══════════════════════════════════════════════════════════════════════════════
// WHATSAPP — envio do aviso pro morador
// ═══════════════════════════════════════════════════════════════════════════════
// Dois jeitos de funcionar:
//   1) AUTOMÁTICO — com um provedor configurado (Z-API, Evolution ou a API oficial
//      da Meta), o servidor manda a mensagem sozinho assim que a encomenda chega.
//   2) MANUAL (padrão, sem configurar nada) — o app devolve o link wa.me com o
//      texto pronto e o porteiro só toca pra enviar.
const https = require('https');
const http = require('http');

const PROVEDOR = String(process.env.WHATSAPP_PROVIDER || '').trim().toLowerCase();

const ZAPI_INSTANCE     = process.env.ZAPI_INSTANCE || '';
const ZAPI_TOKEN        = process.env.ZAPI_TOKEN || '';
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || '';

const EVOLUTION_URL      = (process.env.EVOLUTION_URL || '').replace(/\/+$/, '');
const EVOLUTION_KEY      = process.env.EVOLUTION_KEY || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || '';

const CLOUD_TOKEN    = process.env.WHATSAPP_TOKEN || '';
const CLOUD_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const CLOUD_TEMPLATE = process.env.WHATSAPP_TEMPLATE || '';
const CLOUD_IDIOMA   = process.env.WHATSAPP_TEMPLATE_LANG || 'pt_BR';

function automatico() {
  if (PROVEDOR === 'zapi')      return !!(ZAPI_INSTANCE && ZAPI_TOKEN);
  if (PROVEDOR === 'evolution') return !!(EVOLUTION_URL && EVOLUTION_KEY && EVOLUTION_INSTANCE);
  if (PROVEDOR === 'cloud')     return !!(CLOUD_TOKEN && CLOUD_PHONE_ID);
  return false;
}

function postJson(urlStr, headers, corpo) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('URL inválida: ' + urlStr)); }
    const buf = Buffer.from(JSON.stringify(corpo));
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length, ...headers }
    }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        let body;
        try { body = JSON.parse(data); } catch (e) { body = data; }
        resolve({ status: r.statusCode, body });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('tempo esgotado')));
    req.write(buf); req.end();
  });
}

// deixa só dígitos e coloca o DDI 55 quando o morador cadastrou só DDD + número
function normalizarTelefone(tel) {
  let d = String(tel || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length <= 11) d = '55' + d;
  return d;
}
// pro log não vazar o telefone inteiro: 5554981194621 → 55549****4621
function ofuscar(tel) {
  const d = normalizarTelefone(tel);
  return d.length < 9 ? '***' : d.slice(0, 5) + '****' + d.slice(-4);
}

function link(telefone, texto) {
  const d = normalizarTelefone(telefone);
  return 'https://wa.me/' + d + '?text=' + encodeURIComponent(texto);
}

async function enviar(telefone, texto) {
  const tel = normalizarTelefone(telefone);
  if (!tel) return { ok: false, erro: 'telefone vazio' };
  if (!automatico()) return { ok: false, erro: 'envio automático não configurado' };
  try {
    let r;
    if (PROVEDOR === 'zapi') {
      r = await postJson(
        `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
        ZAPI_CLIENT_TOKEN ? { 'Client-Token': ZAPI_CLIENT_TOKEN } : {},
        { phone: tel, message: texto });
    } else if (PROVEDOR === 'evolution') {
      r = await postJson(
        `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
        { apikey: EVOLUTION_KEY },
        { number: tel, text: texto });
    } else {
      // API oficial da Meta. Fora da janela de 24h ela só aceita template aprovado,
      // por isso o texto vai como parâmetro do template quando WHATSAPP_TEMPLATE existe.
      const corpo = CLOUD_TEMPLATE
        ? { messaging_product: 'whatsapp', to: tel, type: 'template',
            template: { name: CLOUD_TEMPLATE, language: { code: CLOUD_IDIOMA },
              components: [{ type: 'body', parameters: [{ type: 'text', text: texto }] }] } }
        : { messaging_product: 'whatsapp', to: tel, type: 'text', text: { preview_url: false, body: texto } };
      r = await postJson(
        `https://graph.facebook.com/v21.0/${CLOUD_PHONE_ID}/messages`,
        { Authorization: 'Bearer ' + CLOUD_TOKEN }, corpo);
    }
    if (r.status >= 200 && r.status < 300) {
      console.log(`[whatsapp] enviado via ${PROVEDOR} para ${ofuscar(tel)}`);
      return { ok: true, provedor: PROVEDOR };
    }
    const erro = (r.body && ((r.body.error && (r.body.error.message || r.body.error)) || r.body.message)) || ('HTTP ' + r.status);
    console.error(`[whatsapp] falhou via ${PROVEDOR} para ${ofuscar(tel)}: ${String(erro).slice(0, 200)}`);
    return { ok: false, erro: String(erro).slice(0, 200) };
  } catch (e) {
    console.error(`[whatsapp] erro via ${PROVEDOR}:`, e.message);
    return { ok: false, erro: e.message };
  }
}

module.exports = { enviar, link, automatico, normalizarTelefone, provedor: PROVEDOR };
