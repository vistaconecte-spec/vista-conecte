/**
 * Teste do vigia das automações (functions/_vigia.js).
 *
 * POR QUE ISTO EXISTE: alerta que não sai deixa rotina parada por dias (a Central ficou deslogada de
 * 27/10 a 05/11/2026) e alerta repetido vira ruído que ninguém lê. Aqui ficam as duas pontas.
 *
 * Rodar:  node tests/vigia.test.mjs
 */
const { problemas, decidir } = await import('../functions/_vigia.js');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

const dia = Date.parse('2026-11-05T15:00:00Z');   // 12h de Brasília
const noite = Date.parse('2026-11-06T04:00:00Z'); // 1h de Brasília
const ha = (min, base = dia) => new Date(base - min * 60e3).toISOString();
const chaves = l => l.map(p => p.chave);

// problemas
ok('sem pulso nenhum é problema', chaves(problemas(null, null, dia)), ['notebook']);
ok('pulso de 20 min atrás está bem', problemas({ em: ha(20), itens: {} }, null, dia), []);
const parado = problemas({ em: ha(41), itens: { central: { ok: false, texto: 'x' } } }, null, dia);
ok('pulso de 41 min atrás é notebook parado e ignora os itens', chaves(parado), ['notebook']);
ok('o texto diz a hora de Brasília', parado[0].texto.includes('11h19'), true);
ok('item com ok false entra com o texto dele',
  problemas({ em: ha(5), itens: { central: { ok: false, texto: 'Central deslogada' }, avisos: { ok: true } } }, null, dia),
  [{ chave: 'central', texto: 'Central deslogada' }]);
ok('item que não deu pra conferir não é problema', problemas({ em: ha(5), itens: { sync: { ok: null } } }, null, dia), []);
ok('robô sem bater há 46 min', chaves(problemas({ em: ha(5) }, { robo_visto_em: ha(46) }, dia)), ['robo']);
ok('robô batendo não aparece', problemas({ em: ha(5) }, { robo_visto_em: ha(10) }, dia), []);
ok('notebook parado não acusa o robô junto', chaves(problemas({ em: ha(60) }, { robo_visto_em: ha(60) }, dia)), ['notebook']);

// decidir
const P = [{ chave: 'central', texto: 'Central deslogada' }];
const primeiro = decidir(P, null, dia);
ok('problema novo avisa', primeiro.enviar, 'Central deslogada.');
ok('a hora seguinte não repete', decidir(P, primeiro.estado, dia + 3600e3).enviar, null);
const umaHora = decidir(P, primeiro.estado, dia + 3600e3);
ok('continua marcado como avisado', umaHora.estado.avisados, ['central']);
ok('24 h depois repete', decidir(P, primeiro.estado, dia + 24 * 3600e3).enviar, 'Central deslogada.');
ok('problema a mais avisa de novo, com os dois',
  decidir([...P, { chave: 'robo', texto: 'Robô parado' }], primeiro.estado, dia + 3600e3).enviar, 'Central deslogada. Robô parado.');
ok('resolveu tudo avisa que voltou', decidir([], primeiro.estado, dia + 3600e3).enviar, 'As automações voltaram ao normal.');
ok('depois do voltou não fala mais', decidir([], decidir([], primeiro.estado, dia + 3600e3).estado, dia + 7200e3).enviar, null);
ok('sem problema e sem aviso anterior fica quieto', decidir([], null, dia).enviar, null);

const madrugada = decidir(P, null, noite);
ok('de madrugada não avisa', madrugada.enviar, null);
ok('o que apareceu de madrugada sai de manhã', decidir(P, madrugada.estado, noite + 7 * 3600e3).enviar, 'Central deslogada.');
ok('voltou de madrugada espera a manhã', decidir([], primeiro.estado, noite).enviar, null);
ok('e continua lembrando que precisa dizer', decidir([], primeiro.estado, noite).estado.avisados, ['central']);
ok('resolvido em parte não avisa e tira da lista',
  decidir([{ chave: 'robo', texto: 'r' }], { avisados: ['robo', 'central'], ultimo_aviso: ha(60) }, dia).estado.avisados, ['robo']);
ok('texto comprido cabe no template', decidir([{ chave: 'a', texto: 'x'.repeat(2000) }], null, dia).enviar.length, 900);

console.log(`\n${total - falhas}/${total} ok`);
if (falhas) process.exit(1);
