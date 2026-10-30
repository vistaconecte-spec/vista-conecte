/**
 * Arquivo do painel que mudou precisa de ?v= novo (regra do CLAUDE.md).
 *
 * POR QUE ISTO EXISTE: em 30/10/2026 saíram 6 publicações seguidas (aba SAC, CRM, Casos em aberto,
 * cartão de status) sem trocar o main.js?v= do index.html. O index vem sem cache, mas o main.js com o
 * mesmo ?v= o navegador reaproveita: a Bárbara via a tela antiga voltando ("não tá limpando a cache").
 *
 * Compara a cópia de trabalho com o último commit: se o arquivo mudou e a versão onde ele é chamado
 * não mudou, falha. Roda no npm test, antes do commit. Sem git (ou já commitado), não tem o que comparar.
 *
 * Rodar:  node tests/cache-bust.test.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => execFileSync('git', a, { cwd: raiz, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// [arquivo que muda, arquivo que chama, como a versão aparece nele]
const PARES = [
  ['main.js', 'index.html', /main\.js\?v=(\d+)/],
  ['data.js', 'index.html', /data\.js\?v=(\d+)/],
  ['style.css', 'index.html', /style\.css\?v=(\d+)/],
  ['whatsapp.html', 'main.js', /whatsapp\.html\?embed=1&v=(\d+)/],
];

let falhas = 0, total = 0;
let mudados;
try { mudados = new Set(git('diff', '--name-only', 'HEAD').split('\n').filter(Boolean)); }
catch (_) { console.log('  (sem git aqui, nada a comparar)'); process.exit(0); }

for (const [arq, quemChama, re] of PARES) {
  total++;
  if (!mudados.has(arq)) { console.log(`  ok ${arq} sem mudança`); continue; }
  const agora = (readFileSync(join(raiz, quemChama), 'utf8').match(re) || [])[1];
  let antes = null;
  try { antes = (git('show', 'HEAD:' + quemChama).match(re) || [])[1]; } catch (_) {}
  if (agora && agora !== antes) { console.log(`  ok ${arq} mudou e a versão foi de ${antes} para ${agora}`); continue; }
  falhas++;
  console.log(`  X ${arq} mudou mas o ?v= em ${quemChama} continua ${agora}: troque para AAAAMMDDnn de hoje, senão o navegador mostra a versão velha`);
}

console.log(falhas ? `\nX ${falhas} de ${total} falharam\n` : `\n${total}/${total} passaram\n`);
process.exit(falhas ? 1 : 0);
