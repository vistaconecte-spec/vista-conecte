/**
 * Teste da base da integração com o Bling (functions/_bling.js).
 *
 * POR QUE ISTO EXISTE: o token do Bling emite nota fiscal em nome da empresa e fica num
 * documento da vc_modelos, que a chave pública do Supabase lê. Se a cifra falhar calada, o
 * token vai em texto puro pra um lugar público. E o callback é público: se o `state` aceitar
 * qualquer coisa, alguém conecta OUTRA conta do Bling no painel.
 *
 * Rodar:  node tests/bling.test.mjs
 */
const lib = await import('../functions/_bling.js');
const { readFileSync } = await import('node:fs');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

console.log('\nstate do OAuth');
const S = 'segredo-de-sessao';
const st = await lib.assinarState(S, 1_000_000);
ok('state recém-assinado vale', await lib.stateValido(st, S, 1_000_000 + 60e3), true);
ok('state vence em 15 min', await lib.stateValido(st, S, 1_000_000 + 16 * 60e3), false);
ok('state assinado com outro segredo não vale', await lib.stateValido(st, 'outro', 1_000_000), false);
ok('state vazio não vale', await lib.stateValido('', S), false);
ok('state do link de convite do Bling não vale', await lib.stateValido('3538c8866834f2f35acea1ee752a67a1', S), false);
const [p, sig] = st.split('.');
const adulterado = Buffer.from(JSON.stringify({ b: 'bling', exp: 9e15 })).toString('base64url') + '.' + sig;
ok('state com validade adulterada não vale', await lib.stateValido(adulterado, S, 1_000_000), false);

console.log('\ncifra do token');
const tok = { access_token: 'AT-123', refresh_token: 'RT-456', expira_em: 42 };
const c = await lib.cifrar(tok, 'client-secret');
ok('cifrado não contém o access_token', c.includes('AT-123'), false);
ok('cifrado não contém o refresh_token', c.includes('RT-456'), false);
ok('decifra de volta igual', await lib.decifrar(c, 'client-secret'), tok);
ok('outro secret não decifra', await lib.decifrar(c, 'outro-secret'), null);
ok('lixo não decifra', await lib.decifrar('abc.def', 'client-secret'), null);
ok('duas cifras do mesmo token são diferentes (iv novo)', c === await lib.cifrar(tok, 'client-secret'), false);

console.log('\nfonte');
const fonte = readFileSync(new URL('../functions/_bling.js', import.meta.url), 'utf8');
ok('salvarToken grava só o cifrado', /gravarDocToken\(env, \{ cifrado,/.test(fonte), true);
const mw = readFileSync(new URL('../functions/api/_middleware.js', import.meta.url), 'utf8');
ok('callback é público', mw.includes("'/api/bling-callback'"), true);
ok('bling-auth NÃO é público', /PUBLICO[^;]*'\/api\/bling-auth'/.test(mw), false);
ok('bling-nfe NÃO é público', /PUBLICO[^;]*'\/api\/bling-nfe'/.test(mw), false);
const nfe = readFileSync(new URL('../functions/api/bling-nfe.js', import.meta.url), 'utf8');
ok('bling-nfe não aceita POST de fora (só GET com confirmar=1)', /onRequestPost|onRequest\(/.test(nfe), false);

console.log(`\n${total - falhas}/${total} ok`);
if (falhas) process.exit(1);
