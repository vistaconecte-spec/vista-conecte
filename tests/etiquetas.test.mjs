/**
 * Testes do GERAR ETIQUETAS (janela no card PRONTOS PARA ENVIO + /api/etiquetas-dados).
 *
 * POR QUE ISTO EXISTE: em 08/10/2026 a Manu digitava cada etiqueta na Frenet: Saco P em pacote
 * de 700 g, SOS marcado por padrão no formulário e o #9219 com Loggi e Sedex pagas. Agora um
 * robô monta o carrinho a partir daqui. O que não pode quebrar: separar rua/número/bairro do
 * checkout da Shopify (vem com um separador invisível), escolher o saco pelo peso, decidir
 * a regra do serviço, esconder pedido que já ganhou etiqueta, e nunca mandar CPF ao Supabase.
 *
 * Rodar:  node tests/etiquetas.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const html = readFileSync(join(raiz, 'index.html'), 'utf8');
const api = await import(pathToFileURL(join(raiz, 'functions', 'api', 'etiquetas-dados.js')).href);
const mw = readFileSync(join(raiz, 'functions', 'api', '_middleware.js'), 'utf8');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  X ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ok ${nome}`);
}
const WJ = '⁠';

console.log('\n1) Endereço do checkout da Shopify');
{
  ok('rua, número e bairro', api.separarEndereco(`Rua Barão de Mesquita, ${WJ}591`, `${WJ}Grajaú`), { rua: 'Rua Barão de Mesquita', numero: '591', complemento: '', bairro: 'Grajaú' });
  ok('complemento junto do número', api.separarEndereco(`Rua Nunes Machado, ${WJ}1234 apto 56`, `${WJ}Reboucas`), { rua: 'Rua Nunes Machado', numero: '1234', complemento: 'apto 56', bairro: 'Reboucas' });
  ok('complemento antes do bairro em address2', api.separarEndereco(`Rua Vitório Baron, ${WJ} 12 `, `Quadra H perto do mercado, ${WJ}Jardim das Figueiras`), { rua: 'Rua Vitório Baron', numero: '12', complemento: 'Quadra H perto do mercado', bairro: 'Jardim das Figueiras' });
  ok('número que não é número vira SN e o texto vai pro complemento', api.separarEndereco(`QE 56 Conjunto G, ${WJ}Casa 7`, `${WJ}Guará II`), { rua: 'QE 56 Conjunto G', numero: 'SN', complemento: 'Casa 7', bairro: 'Guará II' });
  ok('sem o separador (pedido manual)', api.separarEndereco('Rua das Flores, 120 casa 2', 'Centro'), { rua: 'Rua das Flores', numero: '120', complemento: 'casa 2', bairro: 'Centro' });
}

console.log('\n2) Saco, peso e regra do serviço');
{
  ok('saco pelo peso do pedido', [350, 351, 800, 1500, 2600].map(api.sacoPorPeso), ['P', 'M', 'M', 'G', 'GG']);
  ok('peso da etiqueta = pedido + 50 g, arredondado pra cima de 50 em 50, mínimo 100 g', [0, 300, 700, 2100].map(api.pesoEtiquetaKg), [0.1, 0.35, 0.75, 2.15]);
  ok('serviço da cliente pelo nome do frete', ['Loggi Express', 'PAC', 'SEDEX', 'Loja Conecte'].map(api.servicoCliente), ['LOG_DRPOFF', '03298', '03220', null]);
  ok('frete grátis e fixo R$24,90 → mais barato; real → o da cliente', [api.regraDoPedido(0, 'Loggi Express'), api.regraDoPedido(24.9, 'Loggi Express'), api.regraDoPedido(18.4, 'Loggi Express'), api.regraDoPedido(35, 'SEDEX')], ['mais_barato', 'mais_barato', 'cliente', 'cliente']);
  ok('números do pedido aceitam # e vírgula, sem repetir, até 50', api.lerNumeros('#9266, 9265 9266'), ['9266', '9265']);
}

console.log('\n3) Normalização do pedido');
{
  const p = api.normalizar({
    name: '#9266', legacyResourceId: '123', email: 'a@b.c', displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
    totalWeight: 650, currentSubtotalLineItemsQuantity: 2, currentTotalPriceSet: { shopMoney: { amount: '318.90' } },
    shippingLine: { title: 'Loggi Express', discountedPriceSet: { shopMoney: { amount: '0.0' } } },
    shippingAddress: { name: 'Ana Souza', address1: `Rua X, ${WJ}10`, address2: `${WJ}Centro`, city: 'Brasília', provinceCode: 'DF', zip: '71071264', phone: '+5561999998888' },
    localizationExtensions: { edges: [{ node: { key: 'TAX_CREDENTIAL_BR', purpose: 'TAX', value: '12345678901' } }] },
    lineItems: { edges: [
      { node: { name: 'Calça Pantalona Moletom - Preto / M', quantity: 2, currentQuantity: 2, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '139.45' } } } },
      { node: { name: 'Item devolvido', quantity: 1, currentQuantity: 0, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '50' } } } },
    ] },
  });
  ok('CPF, CEP e telefone formatados', [p.cpf, p.cep, p.telefone], ['123.456.789-01', '71071-264', '(61) 99999-8888']);
  ok('itens viram a declaração de conteúdo (item devolvido fica fora)', p.itens, [{ nome: 'Calça Pantalona Moletom - Preto / M', qtd: 2, preco: 139.45 }]);
  ok('saco M, peso 0,7 kg, frete grátis = mais barato, pago e não enviado', [p.saco, p.peso_kg, p.regra, p.pago, p.enviado], ['M', 0.7, 'mais_barato', true, false]);
}

console.log('\n4) Janela no painel');
{
  const i = main.indexOf('const ETQ_SACOS'), f = main.indexOf('async function etqLerResultado');
  ok('helpers da janela existem', i > 0 && f > i, true);
  const ctx = new Function(main.slice(i, f) + '\nreturn { etqPendentes, etqExplicaAuto };')();
  const agora = Date.parse('2026-10-08T12:00:00Z');
  const prontos = [{ numero: '#1' }, { numero: '#2' }, { numero: '#3' }];
  const res = { feitos: { '#1': { em: '2026-10-07T12:00:00Z' }, '#2': { em: '2026-09-01T12:00:00Z' } } };
  ok('pedido com etiqueta feita há menos de 15 dias some da lista; antigo volta', ctx.etqPendentes(prontos, res, agora).map(p => p.numero), ['#2', '#3']);
  ok('explica o automático', [ctx.etqExplicaAuto({ regra: 'mais_barato', cobrado: 0 }), ctx.etqExplicaAuto({ regra: 'cliente', servico_cliente: '03220' })],
    ['mais barato entre Loggi e PAC (frete grátis)', 'o que a cliente escolheu (Sedex)']);
  ok('o botão está no card PRONTOS PARA ENVIO', /onclick="etqAbrir\(\)"/.test(html) && /id="modal-etiquetas"/.test(html), true);
  ok('a lista parte dos prontos do painel', /window\._prontosEnvio = prontos;/.test(main), true);
  ok('a fila no Supabase leva só número, saco e serviço (sem CPF/endereço)', /\.map\(tr => \(\{ numero: tr\.dataset\.numero, saco: tr\.querySelector\('\.etq-saco'\)\.value, servico: tr\.querySelector\('\.etq-servico'\)\.value \}\)\)/.test(main)
    && /salvarNuvemREST\('etiquetas-pedido', \{ lote, criado_em: agora\.toISOString\(\), pedidos \}\)/.test(main), true);
  ok('caixa no topo marca/desmarca todos os pedidos liberados', /id="etq-todos"/.test(main) && main.includes("querySelectorAll('.etq-marca:not(:disabled)').forEach(c => { c.checked = todos.checked; })"), true);
  ok('não manda lote novo enquanto o robô monta o anterior', /if \(res\.status === 'processando'\)/.test(main), true);
  ok('a tela avisa que o robô não paga', /O robô não paga/.test(main) && /Ele não paga/.test(html), true);
  ok('oficina e modelagem não alcançam /api/etiquetas-dados (fora das allowlists)', !/etiquetas-dados/.test(mw), true);
}

// 22/10/2026: a Ju embala sem ver o sistema, então cada pedido sai numa folha junto da etiqueta.
// Conjunto tem que sair aberto nas peças (ela pega peça por peça na arara) e o total tem que
// contar peça solta, senão ela fecha o pacote com uma a menos.
console.log('\n5) Cópia do pedido para a embalagem');
{
  const comObs = api.normalizar({ name: '#1', note: '  é presente, sem preço dentro  ', shippingAddress: {}, lineItems: { edges: [] } });
  const semObs = api.normalizar({ name: '#2', note: '', shippingAddress: {}, lineItems: { edges: [] } });
  ok('observação da cliente vem do note (vazia vira null)', [comObs.obs, semObs.obs], ['é presente, sem preço dentro', null]);
  ok('a consulta da Shopify pede o note', /legacyResourceId email phone note /.test(readFileSync(join(raiz, 'functions', 'api', 'etiquetas-dados.js'), 'utf8')), true);

  const i = main.indexOf('const COPIA_GRANDE_MIN'), f = main.indexOf('// Os pedidos que o robô acabou de montar');
  const MODELOS = {
    'calca-pantalona': { nome: 'Calça Pantalona' }, 'moletom-gola-alta': { nome: 'Moletom Gola Alta' },
    'conjunto-wide': { nome: 'Conjunto Wide' }, 'bolsa': { nome: 'Bolsa', tamanhoUnico: true },
  };
  const CONJUNTO_PECAS = { 'conjunto-wide': ['calca-pantalona', 'moletom-gola-alta'] };
  const tamanhosDe = def => (def && def.tamanhos) || ['PP', 'P', 'M', 'G', 'GG'];
  const tamNaGrade = (key, tam) => Math.min(tam, 4);
  const corCanon = c => ({ CINZA: 'Cinza' })[c] || c;
  const requisitosDoItem = it => (CONJUNTO_PECAS[it.modelKey] || [it.modelKey]).map(k => ({ key: k, cor: corCanon(it.cor), tam: tamNaGrade(k, it.tam), qtd: it.qtd }));
  const ctx = new Function('MODELOS', 'CONJUNTO_PECAS', 'tamanhosDe', 'tamNaGrade', 'requisitosDoItem',
    main.slice(i, f) + '\nreturn { copiaLinhas, copiaTotalPecas, copiaCidade };')(MODELOS, CONJUNTO_PECAS, tamanhosDe, tamNaGrade, requisitosDoItem);
  const linhas = ctx.copiaLinhas([
    { modelKey: 'conjunto-wide', cor: 'Preto', tam: 2, qtd: 2 },
    { modelKey: 'calca-pantalona', cor: 'Mescla', tam: 6, qtd: 1 },
    { modelKey: 'bolsa', cor: 'Caramelo', tam: 0, qtd: 1 },
  ]);
  ok('conjunto abre nas peças com cor e tamanho', linhas[0].pecas, [{ nome: 'Calça Pantalona', cor: 'Preto', tam: 'M' }, { nome: 'Moletom Gola Alta', cor: 'Preto', tam: 'M' }]);
  ok('tamanho fora da grade cai no maior; tamanho único sai "Único"', [linhas[1].pecas[0].tam, linhas[2].pecas[0].tam], ['GG', 'Único']);
  ok('total conta peça solta (2 conjuntos = 4 peças)', ctx.copiaTotalPecas(linhas), 6);
  // #9383 (22/10/2026): o pedido grava "CINZA" e a cliente digitou "Jundiaí-SP" na cidade
  ok('cor da peça avulsa sai no nome da arara', ctx.copiaLinhas([{ modelKey: 'calca-pantalona', cor: 'CINZA', tam: 2, qtd: 1 }])[0].pecas[0].cor, 'Cinza');
  ok('cidade não repete o estado', [ctx.copiaCidade('Jundiaí-SP', 'SP'), ctx.copiaCidade('Campo Grande', 'MS'), ctx.copiaCidade('Brasília', ''), ctx.copiaCidade('Rio Grande - RS', 'RS')], ['Jundiaí/SP', 'Campo Grande/MS', 'Brasília', 'Rio Grande/RS']);
  ok('botão "imprimir pedidos" no card PRONTOS PARA ENVIO', /onclick="copiaImprimirProntos\(\)"/.test(html), true);
  ok('a janela de impressão abre no clique, antes do fetch (senão vira pop-up bloqueado)',
    main.indexOf("window.open('', '_blank')", main.indexOf('async function copiaImprimir')) < main.indexOf("fetch('/api/etiquetas-dados", main.indexOf('async function copiaImprimir')), true);
}

console.log(`\n${total - falhas}/${total} ok${falhas ? `, ${falhas} falha(s)` : ''}`);
process.exit(falhas ? 1 : 0);
