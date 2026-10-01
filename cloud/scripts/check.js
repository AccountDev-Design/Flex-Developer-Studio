// Comprobacion rapida sin dependencias: sintaxis de todo el JavaScript del
// servicio, de la web y de las pruebas (node --check), y que ningun fichero de
// la web cargue scripts de terceros (la CSP solo permite los propios).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (f === 'node_modules' || f.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
  }
})(root);
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { bad++; console.error(`SINTAXIS: ${f}\n${e.stderr}`); }
}
const html = readFileSync(join(root, 'web/index.html'), 'utf8');
if (/<script(?![^>]*src="js\/)/.test(html) || /https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, ''))) {
  bad++; console.error('web/index.html carga algo que no es propio');
}
console.log(`${files.length} ficheros comprobados, ${bad} problemas`);
process.exit(bad ? 1 : 0);
