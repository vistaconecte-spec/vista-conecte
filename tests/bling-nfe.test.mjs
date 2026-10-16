/**
 * Teste das travas da emissão de NF-e pelo Bling (functions/_bling-nfe.js).
 *
 * POR QUE ISTO EXISTE: nota autorizada só cancela em 24h e o imposto é calculado pelas notas
 * (Confseg, 14/10/2026). Nota em dobro, nota de pedido cancelado ou com valor diferente do
 * pago vira imposto sobre venda que não existiu. E as notas feitas à mão no Bling NÃO ficam
 * ligadas ao pedido, então "o Bling diz que não tem nota" não basta.
 *
 * Rodar:  node tests/bling-nfe.test.mjs
 */
const { decidir, idDaResposta, LOJA_SHOPIFY_BLING } = await import('../functions/_bling-nfe.js');
const { readFileSync } = await import('node:fs');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

// Formatos reais copiados da API em 14/10/2026 (pedido 8433 / Shopify #9333).
const pedido = (extra = {}) => ({
  id: 27130085528, numero: 8431, numeroLoja: '18950666223725', data: '2026-10-14', total: 299.47,
  contato: { id: 1, nome: 'Cliente Teste', numeroDocumento: '158.953.928-14' },
  situacao: { id: 6, valor: 0 }, loja: { id: LOJA_SHOPIFY_BLING }, notaFiscal: { id: 0 }, ...extra,
});
const order = (extra = {}) => ({
  id: 18950666223725, name: '#9333', total_price: '299.47', current_total_price: '299.47',
  financial_status: 'paid', cancelled_at: null, refunds: [], source_name: 'web',
  shipping_lines: [{ title: 'Loggi Express', code: 'loggi' }], ...extra,
});
const motivos = (p, o, n) => decidir(p, o, n).motivos;

console.log('\ncaminho feliz');
ok('pedido pago, sem nota, valores iguais → emite', decidir(pedido(), order(), []), { emitir: true, motivos: [] });
ok('nota cancelada da cliente não bloqueia', decidir(pedido(), order(), [{ numero: '7600', situacao: 2 }]).emitir, true);
ok('nota denegada da cliente não bloqueia', decidir(pedido(), order(), [{ numero: '7600', situacao: 9 }]).emitir, true);
ok('diferença de 1 centavo passa', decidir(pedido({ total: 299.46 }), order(), []).emitir, true);

console.log('\nnota já existe');
ok('Bling com nota ligada', decidir(pedido({ notaFiscal: { id: 123 } }), order(), []).emitir, false);
ok('nota manual do MESMO pedido (numeroPedidoLoja)', motivos(pedido(), order(), [{ numero: '7619', situacao: 5, numeroPedidoLoja: '18950666223725' }]), ['já existe nota deste pedido: 7619']);
ok('nota manual da cliente sem número do pedido → conferir', motivos(pedido(), order(), [{ numero: '7619', situacao: 6, numeroPedidoLoja: null }])[0].startsWith('já existe nota pra esta cliente'), true);
ok('nota rejeitada bloqueia (vai ser corrigida)', decidir(pedido(), order(), [{ numero: '7619', situacao: 4 }]).emitir, false);
ok('nota de OUTRO pedido da cliente também bloqueia (conferir)', decidir(pedido(), order(), [{ numero: '7619', situacao: 5, numeroPedidoLoja: '999' }]).emitir, false);

console.log('\nShopify');
ok('não achou na Shopify', motivos(pedido(), null, []), ['pedido não encontrado na Shopify']);
ok('cancelado na Shopify', decidir(pedido(), order({ cancelled_at: '2026-10-14T10:00:00Z' }), []).emitir, false);
ok('cancelado sem estorno continua "paid" e mesmo assim bloqueia', motivos(pedido(), order({ cancelled_at: 'x', financial_status: 'paid' }), []), ['pedido cancelado na Shopify']);
ok('pendente de pagamento', decidir(pedido(), order({ financial_status: 'pending' }), []).emitir, false);
ok('reembolso parcial', decidir(pedido(), order({ financial_status: 'partially_refunded', refunds: [{ id: 1 }] }), []).emitir, false);
ok('rascunho da Marcelly', motivos(pedido(), order({ source_name: 'shopify_draft_order' }), []), ['pedido não é da loja online (shopify_draft_order)']);
ok('retirada na loja', motivos(pedido(), order({ shipping_lines: [{ title: 'Loja Conecte (retirada)' }] }), []), ['retirada na loja']);
ok('total diferente', motivos(pedido({ total: 369.47 }), order(), []), ['total diferente: Bling 369.47 x Shopify 299.47']);
ok('usa o total ATUAL da Shopify (depois de edição)', decidir(pedido({ total: 250 }), order({ total_price: '299.47', current_total_price: '250.00' }), []).emitir, true);
ok('id da Shopify diferente do numeroLoja', decidir(pedido(), order({ id: 1 }), []).emitir, false);

console.log('\nBling');
ok('pedido de outra loja', decidir(pedido({ loja: { id: 0 } }), order(), []).emitir, false);
ok('pedido já atendido (situação 9)', decidir(pedido({ situacao: { id: 9 } }), order(), []).emitir, false);
ok('total zero (troca/brinde)', decidir(pedido({ total: 0 }), order({ current_total_price: '0.00' }), []).emitir, false);
ok('cliente sem CPF', decidir(pedido({ contato: { nome: 'x', numeroDocumento: '' } }), order(), []).emitir, false);
ok('pedido inexistente', decidir(null, null, []).emitir, false);

console.log('\nresposta do gerar-nfe');
ok('{data:{id}}', idDaResposta({ data: { id: 55 } }), 55);
ok('{data:[{id}]}', idDaResposta({ data: [{ id: 56 }] }), 56);
ok('vazio', idDaResposta({}), null);

console.log('\nfonte do endpoint');
const f = readFileSync(new URL('../functions/api/bling-nfe.js', import.meta.url), 'utf8');
const iGerar = f.indexOf('/gerar-nfe');
const iGate = f.indexOf("q.get('confirmar') !== '1' || !d.decisao.emitir");
const iTrava = f.indexOf('await travar(env, idPedido');
ok('gerar-nfe só depois do confirmar=1 + decisão', iGate > 0 && iGate < iGerar, true);
ok('gerar-nfe só depois da trava no Supabase', iTrava > 0 && iTrava < iGerar, true);
ok('envio que falha não tenta de novo (gerada-nao-enviada)', f.includes("status: 'gerada-nao-enviada'"), true);
ok('erro do gerar-nfe relê o pedido (Bling cria a nota e responde 400)', f.includes("status: 'gerada-com-erro'") && f.indexOf("status: 'gerada-com-erro'") < f.indexOf("status: 'falhou-ao-gerar'"), true);
ok('refazer só quando falhou ANTES de gerar', f.includes("anterior.status === 'falhou-ao-gerar'"), true);
ok('não existe mais so_gerar (o Bling transmite sozinho ao gerar, 16/10/2026)', f.includes("so_gerar"), false);
ok('só chama /enviar quando a nota ficou pendente (situação 1)', f.includes('if (nota && nota.situacao === 1) return json(await completarEEnviar('), true);
ok('acao=enviar só manda nota ainda pendente no Bling', f.includes('nota.situacao !== 1'), true);
ok('emitido=true só com nota autorizada (5 ou 6)', f.includes('nota.situacao === 5 || nota.situacao === 6') && f.includes('emitido: autorizada'), true);
console.log('\nagendador (scripts/bling-notas.mjs + GitHub Actions)');
const w = readFileSync(new URL('../scripts/bling-notas.mjs', import.meta.url), 'utf8');
ok('agendador emite um pedido por chamada, com confirmar=1', w.includes('acao=emitir&pedido=${ped.id}&confirmar=1'), true);
ok('agendador para quando a trava disse emitir e não emitiu', w.includes('if (d.decisao && d.decisao.emitir && !d.emitido && !d.nota)') && w.includes('break;'), true);
ok('agendador sai com erro (GitHub avisa) quando a rodada parou', w.includes('if (r.erro_geral) process.exit(1)'), true);
ok('pendentes pula pedido que já tem doc de emissão', f.includes('travasExistentes(env, candidatos.map'), true);
ok('automático nunca pega pedido de antes de 16/10/2026 (atrasados são decisão fiscal)', f.includes("INICIO_AUTOMATICO = '2026-10-16'") && f.includes('calc < INICIO_AUTOMATICO ? INICIO_AUTOMATICO : calc'), true);
const yml = readFileSync(new URL('../.github/workflows/bling-notas.yml', import.meta.url), 'utf8');
ok('cron 8h47 e 13h47 de Brasília (minuto quebrado), seg a sex', yml.includes("'47 11 * * 1-5'") && yml.includes("'47 16 * * 1-5'"), true);
ok('duas rodadas nunca rodam juntas', yml.includes('group: bling-notas') && yml.includes('cancel-in-progress: false'), true);
ok('token vem do secret, nunca no arquivo', yml.includes('${{ secrets.VC_API_TOKEN }}'), true);
const mainjs = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const indexhtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
ok('aba NOTAS FISCAIS no menu, atrás da senha do Financeiro', mainjs.includes("nfeItem.onclick = () => abrirNotas(nfeItem)") && mainjs.includes("notasUnlock") && indexhtml.includes('id="panel-notas"') && indexhtml.includes('id="nfe-gate"'), true);
ok('aba NOTAS volta depois do F5 (#notas)', mainjs.includes("notas: '__notas__'") && mainjs.includes('abrirNotas(null)'), true);
console.log('\nNCM pela tabela (item sem NCM na nota)');
const { ncmPorNome, completarNcmItens } = await import('../functions/_bling-nfe.js');
ok('Macacão Amplo Marsala G (#9349) → 6114.30.00', ncmPorNome('Macacão Amplo - Marsala / G'), '6114.30.00');
ok('Vestido Frente Única Longo → 6104.44.00', ncmPorNome('Vestido Frente Única Longo - Preto / U'), '6104.44.00');
ok('Calça Flare Canelada → 6104.63.00', ncmPorNome('Calça Flare Canelada Nude Tamanho:M'), '6104.63.00');
ok('Conjunto Cozy (moletom) → 6104.22.00', ncmPorNome('Conjunto Cozy Marsala - M'), '6104.22.00');
ok('Conjunto Moletom + Flare canelada (misturado) → 6104.22.00', ncmPorNome('Conjunto Moletom Gola Alta + Flare Canelada Marrom'), '6104.22.00');
ok('Conjunto Canelado → 6104.23.00', ncmPorNome('Conjunto Canelado Telha - P'), '6104.23.00');
ok('Conjunto Peace → 6104.29.00', ncmPorNome('Conjunto Peace Preto - G'), '6104.29.00');
ok('Calça Pantalona Moletom → 6104.62.00', ncmPorNome('Calça Pantalona Moletom Cinza - M'), '6104.62.00');
ok('Calça Pantalona (viscolycra) → 6104.69.00', ncmPorNome('Calça Pantalona - Marsala / M'), '6104.69.00');
ok('Moletom Gola Alta → 6110.20.00', ncmPorNome('Moletom Gola Alta Nude - G'), '6110.20.00');
ok('Casaco Bear → 6102.30.00', ncmPorNome('Casaco Bear Marrom - M'), '6102.30.00');
ok('Camiseta Oversized → 6109.10.00', ncmPorNome('Camiseta Oversized Black - G'), '6109.10.00');
ok('calçado de revenda não tem NCM na tabela', ncmPorNome('Coturno Autentic Tamanho:36'), null);
ok('Conjunto Wide (tecido desconhecido) não tem NCM', ncmPorNome('Conjunto Wide Preto'), null);
const comp = completarNcmItens([{ descricao: 'Macacão Amplo - Marsala / G', classificacaoFiscal: '' }, { descricao: 'Coturno Maxi', classificacaoFiscal: '' }, { descricao: 'X', classificacaoFiscal: '6104.63.00' }]);
ok('completa só o item vazio que está na tabela', comp.itens.map(i => i.classificacaoFiscal), ['6114.30.00', '', '6104.63.00']);
ok('item fora da tabela vira motivo (nota não sai)', comp.faltando, ['Coturno Maxi']);
ok('não preenche NCM já existente', completarNcmItens([{ descricao: 'Macacão Amplo', classificacaoFiscal: '6104.43.00' }]).itens[0].classificacaoFiscal, '6104.43.00');
ok('nota pendente confere a Shopify de novo antes de enviar', f.includes("problemas.push('pedido cancelado na Shopify')") && f.includes('valor da nota'), true);
ok('agendador segue quando o erro é de um pedido só (nota criada)', w.includes('!d.emitido && !d.nota)'), true);
ok('nenhum DELETE na API do Bling', /method: 'DELETE'/.test(f), false);

console.log(`\n${total - falhas}/${total} ok`);
if (falhas) process.exit(1);
