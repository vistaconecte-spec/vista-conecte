/**
 * /api/bling-produtos: NCM nos produtos do Bling (14/10/2026).
 *
 * Por que existe: o gerar-nfe do Bling recusa a nota quando o produto não tem NCM, e nas
 * notas feitas à mão o NCM era digitado item a item, cada vez de um jeito (inclusive
 * 6309.00.10, que é roupa usada). A tabela por modelo está na memória do projeto.
 *
 * GET ?acao=ncm&id=PRODUTO&ncm=6114.30.00            → mostra o que mudaria, sem gravar
 * GET ?acao=ncm&id=PRODUTO&ncm=6114.30.00&confirmar=1 → grava SÓ se o NCM estiver vazio,
 *                                                       relê e confere que só o NCM mudou
 *
 * NCM já preenchido só é trocado com &de=<NCM atual> (decisão de 14/10/2026: 6309.00.10
 * e os códigos que não batiam com a tabela). Sem o &de, devolve 'ja-tinha'.
 */
import { bling, tokenValido, json, esperar, PAUSA_MS } from '../_bling.js';

const NCM = /^\d{4}\.\d{2}\.\d{2}$/;
// Campos que não podem mudar quando só o NCM foi mexido.
const CONFERIR = ['nome', 'codigo', 'preco', 'situacao', 'formato', 'tipo', 'gtin', 'unidade', 'pesoBruto', 'pesoLiquido'];

export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;
  if ((q.get('acao') || '') !== 'ncm') return json({ erro: 'acao desconhecida (ncm)' }, 400);
  const id = String(q.get('id') || '');
  const ncm = String(q.get('ncm') || '');
  if (!/^\d{6,}$/.test(id)) return json({ erro: 'id do produto inválido' }, 400);
  if (!NCM.test(ncm)) return json({ erro: 'NCM no formato 0000.00.00' }, 400);
  try {
    const token = await tokenValido(env);
    const antes = (await bling(env, `/produtos/${id}`, { token })).data;
    const atual = antes && antes.tributacao ? String(antes.tributacao.ncm || '') : '';
    const base = { id, nome: antes && antes.nome, formato: antes && antes.formato, ncm_antes: atual, ncm_novo: ncm };
    if (atual === ncm) return json({ ...base, status: 'ja-estava-certo' });
    // Trocar um NCM já preenchido exige dizer QUAL era (&de=6309.00.10): assim uma rodada
    // feita com a lista velha não atropela um cadastro que alguém corrigiu à mão depois.
    if (atual && q.get('de') !== atual) return json({ ...base, status: 'ja-tinha' });
    if (q.get('confirmar') !== '1') return json({ ...base, status: 'previa' });

    // PUT com o produto inteiro como veio, só trocando o NCM: o PUT do Bling substitui o
    // cadastro, então mandar parcial apagaria o resto.
    const corpo = { ...antes, tributacao: { ...antes.tributacao, ncm } };
    delete corpo.id;
    await esperar(PAUSA_MS);
    await bling(env, `/produtos/${id}`, { method: 'PUT', body: corpo, token });

    await esperar(PAUSA_MS);
    const depois = (await bling(env, `/produtos/${id}`, { token })).data;
    // O Bling apara espaço sobrando no fim do nome ao salvar ("Calça flare marsala "): isso
    // não é mudança de cadastro, o vínculo com a Shopify é por id/código.
    const igual = (a, b) => (typeof a === 'string' && typeof b === 'string') ? a.trim() === b.trim() : JSON.stringify(a) === JSON.stringify(b);
    const mudou = CONFERIR.filter(k => !igual(antes[k], depois[k]));
    const ncmDepois = depois && depois.tributacao ? depois.tributacao.ncm : null;
    return json({ ...base, status: mudou.length ? 'gravou-mas-mudou-outra-coisa' : (ncmDepois === ncm ? 'gravado' : 'nao-gravou'), ncm_depois: ncmDepois, mudou: mudou.map(k => ({ campo: k, antes: antes[k], depois: depois[k] })) });
  } catch (e) {
    return json({ id, erro: e.message, status: 'erro' }, e.status && e.status < 500 ? e.status : 502);
  }
}
