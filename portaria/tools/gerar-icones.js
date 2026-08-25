// Gera os ícones do app (PNG) sem depender de nenhuma biblioteca.
// Desenha num buffer RGBA e codifica o PNG na mão com o zlib do Node.
//   node tools/gerar-icones.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TABELA_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pedaco(tipo, dados) {
  const t = Buffer.from(tipo, 'ascii');
  const tam = Buffer.alloc(4); tam.writeUInt32BE(dados.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, dados])));
  return Buffer.concat([tam, t, dados, crc]);
}
function png(largura, altura, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0); ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
  const linhas = Buffer.alloc((largura * 4 + 1) * altura);
  for (let y = 0; y < altura; y++) {
    linhas[y * (largura * 4 + 1)] = 0; // sem filtro
    rgba.copy(linhas, y * (largura * 4 + 1) + 1, y * largura * 4, (y + 1) * largura * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pedaco('IHDR', ihdr),
    pedaco('IDAT', zlib.deflateSync(linhas, { level: 9 })),
    pedaco('IEND', Buffer.alloc(0))
  ]);
}

// ─── desenho: caixa de encomenda sobre fundo azul arredondado ──────────────────
function desenhar(tam) {
  const buf = Buffer.alloc(tam * tam * 4);
  const raio = tam * 0.22;
  const por = (x, y) => (y * tam + x) * 4;
  const pinta = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= tam || y >= tam) return;
    const i = por(x, y);
    const af = a / 255, ab = buf[i + 3] / 255;
    const ao = af + ab * (1 - af);
    if (ao <= 0) return;
    buf[i]     = Math.round((r * af + buf[i]     * ab * (1 - af)) / ao);
    buf[i + 1] = Math.round((g * af + buf[i + 1] * ab * (1 - af)) / ao);
    buf[i + 2] = Math.round((b * af + buf[i + 2] * ab * (1 - af)) / ao);
    buf[i + 3] = Math.round(ao * 255);
  };
  const dentroArredondado = (x, y) => {
    const dx = Math.min(x, tam - 1 - x), dy = Math.min(y, tam - 1 - y);
    if (dx >= raio || dy >= raio) return true;
    const cx = dx < raio ? raio : dx, cy = dy < raio ? raio : dy;
    return Math.hypot(cx - dx, cy - dy) <= raio;
  };

  // fundo em degradê azul (cor do app)
  for (let y = 0; y < tam; y++) {
    for (let x = 0; x < tam; x++) {
      if (!dentroArredondado(x, y)) continue;
      const t = y / tam;
      pinta(x, y, [Math.round(108 - 22 * t), Math.round(142 - 30 * t), Math.round(245 - 25 * t)]);
    }
  }

  const BRANCO = [255, 255, 255];
  const FITA = [255, 206, 84];
  const VERDE = [37, 211, 102];
  const ret = (x0, y0, w, h, cor) => {
    for (let y = Math.round(y0); y < Math.round(y0 + h); y++)
      for (let x = Math.round(x0); x < Math.round(x0 + w); x++) pinta(x, y, cor);
  };
  const circulo = (cx, cy, r, cor) => {
    for (let y = -Math.ceil(r); y <= Math.ceil(r); y++)
      for (let x = -Math.ceil(r); x <= Math.ceil(r); x++)
        if (Math.hypot(x, y) <= r) pinta(Math.round(cx + x), Math.round(cy + y), cor);
  };

  // caixa de encomenda: tampa, corpo e fita
  const cx = tam * 0.47, larg = tam * 0.56, alt = tam * 0.34;
  const topo = tam * 0.28, tampa = tam * 0.13;
  ret(cx - larg / 2, topo, larg, tampa, [226, 234, 252]);            // tampa
  ret(cx - larg / 2, topo + tampa, larg, alt, BRANCO);               // corpo
  ret(cx - larg / 2, topo + tampa, larg, tam * 0.018, [200, 212, 240]); // vinco da tampa
  ret(cx - larg * 0.08, topo, larg * 0.16, tampa + alt, FITA);       // fita vertical

  // balão de mensagem no canto: o aviso que vai pro morador
  const bx = tam * 0.72, by = tam * 0.70, br = tam * 0.17;
  circulo(bx, by, br, VERDE);
  ret(bx - br * 0.35, by + br * 0.55, br * 0.7, br * 0.62, VERDE);    // rabinho do balão
  circulo(bx - br * 0.42, by, br * 0.11, [255, 255, 255]);           // três pontinhos
  circulo(bx, by, br * 0.11, [255, 255, 255]);
  circulo(bx + br * 0.42, by, br * 0.11, [255, 255, 255]);

  return buf;
}

const destino = path.join(__dirname, '..', 'public');
fs.mkdirSync(destino, { recursive: true });
[192, 512, 180].forEach(tam => {
  const arquivo = path.join(destino, `icon-${tam}.png`);
  fs.writeFileSync(arquivo, png(tam, tam, desenhar(tam)));
  console.log('gerado', arquivo);
});
