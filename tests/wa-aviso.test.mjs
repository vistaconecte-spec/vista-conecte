/**
 * Teste do aviso de cliente esperando a equipe no WhatsApp (main.js, 21/10/2026).
 *
 * POR QUE ISTO EXISTE: é o passo 1 para a equipe sair da caixa do Wati. Se o aviso contar conversa que a Vi
 * já está respondendo, a equipe responde por cima dela (foi o caso "Marcelle" de 21/10: pergunta respondida
 * pela equipe 30 s depois, a Vi pausou e a resposta certa dela não saiu). Se deixar de contar conversa com a
 * Vi pausada, a cliente fica sem ninguém. E o som tem que tocar só quando chega coisa nova, senão vira ruído.
 *
 * Rodar:  node tests/wa-aviso.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

const a = main.indexOf('const WA_AVISO_ESPERA_MS');
const b = main.indexOf('function waAvisoIniciar', a);
if (a < 0 || b < 0) throw new Error('trecho do aviso não encontrado no main.js');
const fonte = main.slice(a, b);

// DOM e rede de mentira
function elemento() {
  const filhos = [];
  return {
    filhos,
    querySelector: () => filhos[0] ? { remove: () => filhos.splice(0, 1) } : null,
    insertAdjacentHTML: (_, html) => filhos.push(html),
  };
}
const nav = elemento(), pilula = elemento();
const document = { title: 'CONECTE', getElementById: id => ({ 'nav-atendimento': nav, 'atd-pill-whats': pilula }[id] || null) };
let sons = 0;
class AudioFalso {
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
  resume() { return Promise.resolve(); }
  createOscillator() { return { frequency: {}, connect: x => x, start() { sons += 0.5; }, stop() {} }; }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: x => x }; }
}
const window = { AudioContext: AudioFalso };
let resposta = [], pedidos = [];
const fetch = async u => { pedidos.push(String(u)); return { ok: true, json: async () => ({ conversas: resposta }) }; };

const lab = new Function('document', 'window', 'fetch', fonte + '; return { waPrecisaEquipe, waAvisoChecar, waAviso };')(document, window, fetch);

const agora = Date.now();
const iso = ms => new Date(agora - ms).toISOString();
const conv = (chave, o) => ({ chave, ultima_direcao: 'entrada', ultima_em: iso(60e3), pausada_ate: null, ...o });

console.log('\n1) Quem conta como esperando a equipe');
ok('Vi pausada e a cliente escreveu: conta na hora', lab.waPrecisaEquipe(conv('a', { pausada_ate: new Date(agora + 3600e3).toISOString(), ultima_em: iso(10e3) }), agora), true);
ok('Vi ativa e cliente há 1 min: não conta (a Vi está respondendo)', lab.waPrecisaEquipe(conv('b', { ultima_em: iso(60e3) }), agora), false);
ok('Vi ativa e cliente há 5 min sem resposta: conta', lab.waPrecisaEquipe(conv('c', { ultima_em: iso(5 * 60e3) }), agora), true);
ok('pausa que já venceu e cliente há 1 min: não conta', lab.waPrecisaEquipe(conv('d', { pausada_ate: iso(1000), ultima_em: iso(60e3) }), agora), false);
ok('a loja falou por último: não conta', lab.waPrecisaEquipe(conv('e', { ultima_direcao: 'saida', ultima_em: iso(3600e3) }), agora), false);
// o que a Vi deixou sem resposta na semana de 14 a 21/10/2026
const velha = t => conv('x', { ultima_em: iso(30 * 60e3), ultimo_texto: t });
const pausadaCom = t => conv('y', { pausada_ate: new Date(agora + 3600e3).toISOString(), ultimo_texto: t });
ok('despedida não conta', ['❤️', '👍🏼', '🙏🏻', 'Obrigada', 'Ok obrigada', 'Muito obrigada 🙏🏻✨', 'Eu que agradeço', 'Já verifiquei. Obrigada.', 'ok', 'Perfeito!']
  .map(t => lab.waPrecisaEquipe(velha(t), agora)), Array(10).fill(false));
ok('despedida com a Vi pausada também não conta', lab.waPrecisaEquipe(pausadaCom('obrigada!'), agora), false);
ok('reação não conta', lab.waPrecisaEquipe(conv('r', { ultima_em: iso(30 * 60e3), ultimo_tipo: 'reaction', ultimo_texto: '❤' }), agora), false);
ok('pergunta conta, mesmo agradecendo', ['Obrigada! E o prazo de entrega?', 'ok, mas e o tamanho M?', 'pra não ficar com avaliação negativa no site preciso de retorno', 'Ansiosa pelas roupas 😅']
  .map(t => lab.waPrecisaEquipe(velha(t), agora)), [true, true, true, true]);
ok('foto ou áudio sem texto contam', lab.waPrecisaEquipe(conv('m', { ultima_em: iso(30 * 60e3), ultimo_tipo: 'image', ultimo_texto: null }), agora), true);

console.log('\n2) Número no menu, na pílula e no título');
resposta = [conv('a', { pausada_ate: new Date(agora + 3600e3).toISOString() }), conv('b'), conv('c', { ultima_em: iso(10 * 60e3) })];
await lab.waAvisoChecar();
ok('busca só as aguardando das últimas 24 h', (() => { const q = new URL(pedidos[0], 'http://x').searchParams; return [q.get('acao'), q.get('filtro'), Math.round((agora - Date.parse(q.get('desde'))) / 3600e3)]; })(), ['conversas', 'aguardando', 24]);
ok('conta 2 (a pausada e a de 10 min)', lab.waAviso.n, 2);
ok('título da aba com o número', document.title, '(2) CONECTE');
ok('selo no menu ATENDIMENTO e na pílula', [nav.filhos.length, pilula.filhos.length, /&?>2</.test(nav.filhos[0])], [1, 1, true]);
ok('primeira leitura não toca som', sons, 0);

console.log('\n3) Som só quando chega coisa nova');
await lab.waAvisoChecar();
ok('mesma lista: sem som e sem selo duplicado', [sons, nav.filhos.length], [0, 1]);
resposta = [...resposta, conv('f', { ultima_em: iso(4 * 60e3) })];
await lab.waAvisoChecar();
ok('conversa nova na conta: toca', [sons, lab.waAviso.n, document.title], [1, 3, '(3) CONECTE']);
resposta = resposta.map(c => (c.chave === 'a' ? { ...c, ultima_em: iso(5e3) } : c));
await lab.waAvisoChecar();
ok('mensagem nova numa que já estava: toca de novo', sons, 2);
resposta = resposta.filter(c => c.chave !== 'f');
await lab.waAvisoChecar();
ok('conversa respondida sai da conta sem tocar', [sons, lab.waAviso.n], [2, 2]);

console.log('\n4) Ninguém esperando');
resposta = [];
await lab.waAvisoChecar();
ok('título volta ao normal e o selo some', [document.title, nav.filhos.length, pilula.filhos.length], ['CONECTE', 0, 0]);

console.log(falhas ? `\n✗ ${falhas} de ${total} falharam` : `\n✓ TODOS OS TESTES PASSARAM — ${total}/${total}`);
process.exit(falhas ? 1 : 0);
