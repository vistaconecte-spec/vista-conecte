/**
 * Sapato de revenda (Flat, Sandália Gladiadora) fora das etapas de roupa.
 *
 * POR QUE ISTO EXISTE: em 30/09/2026 o "Mandar tudo p/ produção" pôs o Flat em "Comprando
 * tecido" junto com as roupas, e o "Mandar tudo para o corte" levou ele para "Em corte".
 * Em 01/10 o sapato apareceu em 1º na aba CORTE, "PRIORIDADE · CORTAR PRIMEIRO". Sapato é
 * comprado pronto: o dropdown dele só tem "Comprado".
 *
 * O que trava: as quatro funções que montam ou movem leva de oficina pulam `def.revenda`,
 * tanto no texto quanto rodando com um MODELOS de mentira.
 *
 * Rodar:  node tests/revenda-fora-oficina.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');

function extrair(nome) {
  const i = main.indexOf(`function ${nome}(`);
  if (i < 0) throw new Error('função não encontrada: ' + nome);
  const j = main.indexOf('\n}', i);
  return main.slice(i, j + 2);
}

let falhas = 0;
const ok = (cond, msg) => { if (cond) console.log('  ok  ' + msg); else { console.log('  FALHOU  ' + msg); falhas++; } };

console.log('revenda fora da oficina');
for (const nome of ['urgentesParaProducao', 'levasEmCompraParaCorte', 'renderCorte', 'cstLevasDe']) {
  ok(/if \(def\.revenda\) continue;/.test(extrair(nome)), `${nome} pula sapato de revenda`);
}

// Rodando: um sapato e uma roupa, os dois "Em corte"/"Comprando tecido" com peça na leva
const MODELOS = {
  flat:  { nome: 'Flat', revenda: true, tamanhos: ['34','35','36','37','38','39','40'], cores: ['Preto'], aberto: { Preto: [0,0,1,1,0,0,0] } },
  saia:  { nome: 'Saia', cores: ['Preto'], aberto: { Preto: [0,1,0,0,0] } },
};
const store = {
  'vc:flat': { status: 'Em corte', status_at: '2026-09-30T02:09:53Z', prod: { Preto: [0,0,1,1,0,0,0] } },
  'vc:saia': { status: 'Em corte', status_at: '2026-09-30T02:09:53Z', prod: { Preto: [0,1,0,0,0] } },
};
const ambiente = { MODELOS, CONJUNTO_PECAS: {}, loadLocal: k => store[k], tamanhosDe: d => d.tamanhos || ['PP','P','M','G','GG'] };
const cstLevasDe = new Function(...Object.keys(ambiente), extrair('cstLevasDe') + '\nreturn cstLevasDe;')(...Object.values(ambiente));
const chaves = cstLevasDe('Em corte').map(l => l.key);
ok(chaves.includes('saia'), 'roupa em corte continua na lista');
ok(!chaves.includes('flat'), 'sapato em corte não vira ficha de oficina');

if (falhas) { console.log(`\n${falhas} falha(s)`); process.exit(1); }
console.log('\ntudo certo');
