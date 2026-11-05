/**
 * Vigia das automações (05/11/2026): quem avisa quando o notebook, que roda quase tudo, para.
 *
 * POR QUE ISTO EXISTE: WhatsApp, Central de Missões, robô da Frenet, avisos da Vi, baixa de estoque
 * e as rotinas do Claude dependem do notebook. Em 25/10, 27/10 e 03/11 rotina deixou de rodar e
 * ninguém soube, e a Central ficou deslogada de 27/10 a 05/11 com o aviso perdido no grupo Claude.
 * Quem vigia não pode depender do vigiado, então a conferência roda no GitHub Actions e o aviso sai
 * pelo número da loja (Meta), não pelo WhatsApp do notebook.
 *
 * O notebook grava o pulso a cada 15 min (Desktop/claude/vigia-notebook/pulso.py). As duas linhas têm
 * prefixo hist: de propósito: o painel ignora hist:* no realtime e na sincronização, então o pulso não
 * redesenha tela nenhuma nem soma egresso (ver project_vista_conecte_egress_supabase).
 *
 * Tudo aqui é função pura, para o teste (tests/vigia.test.mjs) rodar sem rede.
 */
export const PULSO_ID = 'hist:vigia-pulso';
export const ESTADO_ID = 'hist:vigia-estado';
export const SEM_SINAL_MIN = 40;   // pulso de 15 em 15: 40 min são duas batidas perdidas
export const ROBO_MIN = 45;        // o robô bate de 10 em 10 e o vigia-robo religa em até 15
export const REPETE_H = 24;
const HORA_INI = 7, HORA_FIM = 22; // de noite anota e deixa para avisar de manhã

const brt = ms => new Date(ms - 3 * 3600e3);
const hhmm = iso => brt(Date.parse(iso)).toISOString().slice(11, 16).replace(':', 'h');
const minutos = (agora, iso) => (agora - Date.parse(iso)) / 60e3;

export function problemas(pulso, robo, agora) {
  if (!pulso || !pulso.em || Number.isNaN(Date.parse(pulso.em))) {
    return [{ chave: 'notebook', texto: 'Notebook sem nenhum sinal registrado' }];
  }
  if (minutos(agora, pulso.em) > SEM_SINAL_MIN) {
    // Sem pulso nada do que ele contou vale mais: o último "ok" pode estar velho.
    return [{ chave: 'notebook', texto: `Notebook sem sinal desde ${hhmm(pulso.em)}. WhatsApp, robô da Frenet e rotinas do Claude dependem dele` }];
  }
  const lista = Object.entries(pulso.itens || {})
    .filter(([, it]) => it && it.ok === false)   // ok null = não deu pra conferir, não é problema
    .map(([chave, it]) => ({ chave, texto: it.texto || chave }));
  const visto = robo && robo.robo_visto_em;
  if (visto && minutos(agora, visto) > ROBO_MIN) {
    lista.push({ chave: 'robo', texto: `Robô de etiquetas da Frenet parado desde ${hhmm(visto)}` });
  }
  return lista;
}

export function decidir(lista, estado, agora) {
  const antes = estado || {};
  const avisados = Array.isArray(antes.avisados) ? antes.avisados : [];
  const chaves = lista.map(p => p.chave);
  const hora = brt(agora).getUTCHours();
  const acordada = hora >= HORA_INI && hora < HORA_FIM;
  const ativos = {};
  for (const c of chaves) ativos[c] = (antes.ativos && antes.ativos[c]) || new Date(agora).toISOString();
  const base = { ativos, ultimo_aviso: antes.ultimo_aviso || null };

  if (!lista.length) {
    if (avisados.length && acordada) {
      return { enviar: 'As automações voltaram ao normal.', estado: { ativos: {}, avisados: [], ultimo_aviso: new Date(agora).toISOString() } };
    }
    return { enviar: null, estado: { ...base, avisados } };
  }

  const ainda = avisados.filter(c => chaves.includes(c));
  const novo = chaves.some(c => !avisados.includes(c));
  const venceu = !antes.ultimo_aviso || (agora - Date.parse(antes.ultimo_aviso)) / 3600e3 >= REPETE_H;
  if (acordada && (novo || venceu)) {
    const texto = (lista.map(p => p.texto).join('. ') + '.').slice(0, 900);
    return { enviar: texto, estado: { ativos, avisados: chaves, ultimo_aviso: new Date(agora).toISOString() } };
  }
  return { enviar: null, estado: { ...base, avisados: ainda } };
}
