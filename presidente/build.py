# Junta os arquivos de src/ em um único index.html
import pathlib
s = pathlib.Path(__file__).parent / 'src'
html = '<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' + (s/'head.html').read_text()
html += '\n<script src="https://cdn.jsdelivr.net/npm/globe.gl@2.46.2/dist/globe.gl.min.js"></script>\n<script>\nconst GEO=' + (s/'geo.json').read_text() + ';\n'
html += '\n'.join((s/f).read_text() for f in ['data.js','engine.js','ui.js']) + '\n</script>\n'
(pathlib.Path(__file__).parent/'index.html').write_text(html)
print('index.html gerado')
