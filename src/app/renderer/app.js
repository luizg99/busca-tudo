'use strict';
const bt = window.buscaTudo;
const view = document.getElementById('view');
let current = 'trackers';
let pollTimer;
let lastStatus;
let dailyLimit; // limite diário (US$), vindo de /settings

/* ======================= utilitários ======================= */

const ICONS = {
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1"/>',
  news: '<path d="M4 5h13v14H6a2 2 0 0 1-2-2V5zM17 8h3v9a2 2 0 0 1-2 2M8 9h5M8 13h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4l9.5 16h-19zM12 10v4M12 17h.01"/>',
  bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>',
  send: '<path d="M4 12l16-8-6 16-3-7z"/>',
};
function icon(name) {
  const s = document.createElement('span');
  s.className = 'ico';
  s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`; // só ícones estáticos daqui
  return s;
}
document.querySelectorAll('[data-icon]').forEach((el) => { const i = icon(el.dataset.icon); i.className = el.className; el.replaceWith(i); });

/** Cria elementos sem innerHTML: todo texto (inclusive o vindo da web) entra como textContent. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

const money = (n, cur) => (n == null ? '—' : `${!cur || cur === 'BRL' ? 'R$' : cur} ${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const usd = (n) => `US$ ${Number(n || 0).toFixed(2)}`;
const when = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
function rel(ms) {
  const abs = Math.abs(ms), m = Math.round(abs / 60000), hrs = Math.round(abs / 3600000), d = Math.round(abs / 86400000);
  const txt = m < 1 ? 'agora' : m < 60 ? `${m} min` : hrs < 48 ? `${hrs} h` : `${d} dias`;
  return m < 1 ? txt : ms < 0 ? `há ${txt}` : `em ${txt}`;
}
const link = (url, label) => h('a', { class: 'link', title: url, onclick: () => bt.openExternal(url) }, label || url);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const MODE = { discovery: 'Busca completa', routine: 'Leitura por código', fallback: 'Busca completa (fallback)' };
const METHOD = { rule: 'regra', generic: 'dados estruturados', ai: 'IA (trecho)' };
const KIND = { price: 'Preço', news: 'Notícias', generic: 'Geral' };
const DIGEST = { none: 'desligado', daily: 'diário', weekly: 'semanal' };
const COND = (c) => (c.type === 'below_last' ? 'preço abaixo do último valor' : c.type === 'below_value' ? `preço abaixo de ${money(c.value)}` : 'qualquer novidade');
const badge = (text, kind = '') => h('span', { class: `badge ${kind}`.trim() }, text);
const btn = (label, opts = {}, ico) => h('button', { class: `btn ${opts.kind || ''} ${opts.sm ? 'sm' : ''}`.trim(), onclick: opts.onclick, disabled: opts.disabled, title: opts.title }, ico ? icon(ico) : null, label);

function toast(text, kind = 'ok') {
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, icon(kind === 'ok' ? 'check' : 'alert'), h('span', {}, text));
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'ok' ? 3500 : 6000);
}

async function api(method, path, body) {
  const r = await bt.api(method, path, body);
  if (!r.ok) {
    if (r.serviceDown) showBanner('O serviço está parado. Os acompanhamentos não estão sendo verificados.', true);
    throw new Error(r.error);
  }
  return r.data;
}

/* ======================= barra lateral e avisos ======================= */

function showBanner(text, withButton) {
  document.getElementById('banner').classList.toggle('hidden', !text);
  document.getElementById('banner-text').textContent = text || '';
  document.getElementById('banner-btn').classList.toggle('hidden', !withButton);
}
function setSys(id, kind, text) {
  const row = document.getElementById(id);
  row.className = `sys-row ${kind || ''}`.trim();
  row.querySelector('b').textContent = text;
}
function setSpend(spent, limit, over) {
  document.getElementById('spend-text').textContent = limit ? `${usd(spent)} / ${usd(limit)}` : usd(spent);
  const pct = limit ? Math.min(100, (spent / limit) * 100) : 0;
  const bar = document.getElementById('spend-bar');
  bar.style.width = `${limit ? pct : 0}%`;
  bar.className = over || pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : '';
  document.getElementById('spend-sub').textContent = over ? 'Limite atingido: verificações pausadas' : limit ? `Limite diário · ${Math.round(pct)}% usado` : 'Sem limite diário';
}

async function refreshStatus() {
  const r = await bt.status();
  if (!r.ok) {
    lastStatus = undefined;
    setSys('sys-service', 'bad', 'parado');
    setSys('sys-wa', '', '—'); setSys('sys-key', '', '—');
    showBanner('O serviço está parado. Os acompanhamentos não estão sendo verificados.', true);
    return;
  }
  const s = (lastStatus = r.data);
  setSys('sys-service', 'ok', 'rodando');
  setSys('sys-wa', s.whatsapp === 'ready' ? 'ok' : 'warn', s.whatsapp === 'ready' ? 'conectado' : s.whatsapp === 'qr' ? 'escaneie o QR' : 'desconectado');
  setSys('sys-key', s.hasApiKey ? 'ok' : 'bad', s.hasApiKey ? 'configurada' : 'faltando');
  try { dailyLimit = (await bt.api('GET', '/settings')).data?.limitDayUsd; } catch { /* mantém o anterior */ }
  setSpend(s.spentDayUsd ?? 0, dailyLimit, s.overLimit);
  showBanner(s.hasApiKey ? '' : 'Informe a chave da Anthropic em Configurações para começar a usar a IA.', false);
}

/* ======================= Acompanhamentos ======================= */

function metric(label, value, sub) {
  return h('div', { class: 'metric' }, h('span', {}, label), h('b', { title: typeof value === 'string' ? value : undefined }, value), sub ? h('small', {}, sub) : null);
}

function nextCheck(t, last, overLimit) {
  if (t.status !== 'active') return { text: 'Pausado', sub: 'não será verificado' };
  if (overLimit) return { text: 'Aguardando', sub: 'limite de custo atingido' };
  const due = last ? Date.parse(last.at) + t.intervalMinutes * 60000 : Date.now();
  if (due <= Date.now()) return { text: 'Em instantes', sub: last ? `previsto ${when(new Date(due).toISOString())}` : 'primeira verificação' };
  return { text: when(new Date(due).toISOString()), sub: rel(due - Date.now()) };
}

let editingId = null; // acompanhamento em edição (pausa a atualização automática da lista)
const FREQS = [[15, '15 minutos'], [30, '30 minutos'], [60, '1 hora'], [120, '2 horas'], [180, '3 horas'], [360, '6 horas'], [720, '12 horas'], [1440, '1 vez por dia']];

function trackerEditor(t, stats) {
  const name = h('input', { type: 'text', value: t.name, 'aria-label': 'Nome' });
  const goal = h('input', { type: 'text', value: t.goal, 'aria-label': 'Objetivo' });
  const freqOptions = FREQS.some(([m]) => m === t.intervalMinutes) ? FREQS : [...FREQS, [t.intervalMinutes, `${t.intervalMinutes} minutos`]].sort((a, b) => a[0] - b[0]);
  const freq = h('select', {}, freqOptions.map(([m, l]) => h('option', { value: String(m), selected: m === t.intervalMinutes }, l)));
  const condOptions = t.kind === 'news' ? [['new_items', 'Qualquer novidade']] : [['below_last', 'Preço abaixo do último valor'], ['below_value', 'Preço abaixo de um valor fixo']];
  const cond = h('select', {}, condOptions.map(([v, l]) => h('option', { value: v, selected: v === t.alertCondition.type }, l)));
  const limit = h('input', { type: 'number', min: '0', step: '0.01', value: t.alertCondition.type === 'below_value' ? t.alertCondition.value : '', placeholder: 'ex.: 3500' });
  const limitField = field('Valor (R$)', limit);
  const digest = h('select', {}, [['none', 'Sem resumo'], ['daily', 'Resumo diário'], ['weekly', 'Resumo semanal']].map(([v, l]) => h('option', { value: v, selected: v === t.digest }, l)));
  const estimate = h('div', { class: 'muted small' });
  const perCheck = stats && stats.checks ? stats.costUsd / stats.checks : 0.034;
  const update = () => {
    limitField.classList.toggle('hidden', cond.value !== 'below_value');
    const perDay = 1440 / Number(freq.value);
    estimate.textContent = `≈ ${Math.round(perDay)} verificações por dia · custo estimado ≈ ${usd(perDay * perCheck)} por dia`;
  };
  freq.addEventListener('change', update); cond.addEventListener('change', update); update();

  const close = () => { editingId = null; render(); };
  const save = btn('Salvar', { kind: 'primary', sm: true, onclick: async () => {
    if (!name.value.trim() || !goal.value.trim()) return toast('Informe o nome e o objetivo.', 'bad');
    let alertCondition = { type: cond.value };
    if (cond.value === 'below_value') {
      if (!(Number(limit.value) > 0)) return toast('Informe o valor do alerta, maior que zero.', 'bad');
      alertCondition = { type: 'below_value', value: Number(limit.value) };
    }
    try {
      await api('PATCH', `/trackers/${t.id}`, { name: name.value.trim(), goal: goal.value.trim(), intervalMinutes: Number(freq.value), alertCondition, digest: digest.value });
      toast('Acompanhamento atualizado.');
      close();
    } catch (e) { toast(e.message, 'bad'); }
  } }, 'check');

  return h('article', { class: 'card tracker' },
    h('div', { class: 'tracker-head' }, h('div', { class: 'kind' }, icon('sliders')), h('div', { class: 'grow' }, h('div', { class: 'tracker-title' }, 'Editar acompanhamento'), h('div', { class: 'tracker-goal' }, 'As mudanças valem a partir da próxima verificação.'))),
    h('div', { class: 'grid2' }, field('Nome', name), field('Frequência das verificações', freq)),
    field('Objetivo (o que a IA deve procurar)', goal),
    h('div', { class: 'grid2' }, field('Avisar quando', cond), limitField),
    field('Resumo', digest),
    estimate,
    h('div', { class: 'tracker-foot' }, save, btn('Cancelar', { kind: 'ghost', sm: true, onclick: close })));
}

function trackerCard(t, last, stats) {
  const best = last?.findings?.filter((f) => f.found && f.value != null && f.confidence >= 0.6 && (!f.currency || f.currency === 'BRL')).sort((a, b) => a.value - b.value)[0];
  const nxt = nextCheck(t, last, lastStatus?.overLimit);
  const isNews = t.kind === 'news';
  const latestNews = last?.findings?.find((f) => f.found && f.title);
  const result = h('span', { class: 'result muted' });
  const checkBtn = btn('Verificar agora', { kind: 'primary', sm: true, onclick: async () => {
    checkBtn.disabled = true; result.className = 'result muted'; result.textContent = 'Verificando…';
    try {
      const r = await api('POST', `/trackers/${t.id}/check`);
      if (r.ok) toast(r.alerted ? 'Alerta enviado no WhatsApp!' : r.baseline ? 'Linha de base registrada.' : 'Verificado: sem novidades.');
      else toast(r.error, 'bad');
    } catch (e) { toast(e.message, 'bad'); }
    await render();
  } }, 'refresh');

  const armDelete = btn('Excluir', { kind: 'ghost danger', sm: true }, 'trash');
  let armed = false;
  armDelete.addEventListener('click', async () => {
    if (!armed) { armed = true; armDelete.lastChild.textContent = 'Confirmar exclusão'; setTimeout(() => { armed = false; armDelete.lastChild.textContent = 'Excluir'; }, 4000); return; }
    await api('DELETE', `/trackers/${t.id}`); toast('Acompanhamento excluído.'); await render();
  });

  return h('article', { class: `card tracker ${t.status === 'paused' ? 'paused' : ''}` },
    h('div', { class: 'tracker-head' },
      h('div', { class: 'kind' }, icon(t.kind === 'news' ? 'news' : t.kind === 'price' ? 'tag' : 'search')),
      h('div', { class: 'grow' },
        h('div', { class: 'tracker-title' }, t.name, badge(KIND[t.kind], 'accent'), t.status === 'paused' ? badge('Pausado', 'warn') : null),
        h('div', { class: 'tracker-goal' }, t.goal))),
    h('div', { class: 'metrics' },
      isNews
        ? [metric('Última novidade', latestNews?.title || '—', last ? rel(Date.parse(last.at) - Date.now()) : 'nunca verificado'),
           metric('Novidades em 7 dias', String(stats?.alerts ?? 0), stats ? `${stats.checks} verificações` : '')]
        : [metric('Última leitura', best ? money(best.value, best.currency) : '—', last ? rel(Date.parse(last.at) - Date.now()) : 'nunca verificado'),
           metric('Menor em 7 dias', stats?.min != null ? money(stats.min) : '—', stats ? `${stats.checks} verificações` : '')],
      metric('Próxima consulta', nxt.text, nxt.sub),
      metric('Frequência', `${t.intervalMinutes} min`, `alerta: ${COND(t.alertCondition)}`)),
    last && !last.ok ? h('div', { class: 'alert' }, icon('alert'), h('span', {}, `Última verificação falhou: ${last.error}`)) : null,
    stats?.sourceProblems?.length
      ? h('div', { class: 'alert warn' }, icon('alert'), h('div', {}, h('strong', {}, `Sem preço em ${stats.sourceProblems.length} site(s) (nem pelo código nem pela IA):`),
          stats.sourceProblems.map((p) => h('div', {}, `${p.label || hostOf(p.url)} — ${p.error || 'motivo desconhecido'}`)),
          h('div', { class: 'small' }, 'Esses sites só entram pela busca completa na web, 1 vez por dia.')))
      : null,
    h('div', { class: 'tracker-foot' }, checkBtn,
      btn(t.status === 'active' ? 'Pausar' : 'Retomar', { sm: true, onclick: async () => { await api('PATCH', `/trackers/${t.id}`, { status: t.status === 'active' ? 'paused' : 'active' }); await render(); } }, t.status === 'active' ? 'pause' : 'play'),
      btn('Editar', { sm: true, onclick: () => { editingId = t.id; render(); } }, 'sliders'),
      btn('Detalhes', { sm: true, onclick: () => viewDetail(t) }),
      result, h('span', { class: 'sp' }), armDelete));
}

async function viewTrackers() {
  const list = await api('GET', '/trackers');
  const head = h('div', { class: 'page-head' },
    h('div', { class: 'grow' }, h('h1', {}, 'Acompanhamentos'), h('div', { class: 'sub' }, list.length ? `${list.filter((t) => t.status === 'active').length} ativo(s) de ${list.length}` : 'Nada sendo acompanhado ainda')),
    btn('Novo acompanhamento', { kind: 'primary', onclick: () => setView('chat') }, 'plus'));
  if (!list.length) {
    return h('div', { class: 'page' }, head, h('div', { class: 'card empty' },
      h('div', { class: 'art' }, icon('search')), h('h3', {}, 'Comece descrevendo o que você quer acompanhar'),
      h('p', {}, 'Conte em uma frase, por exemplo "avise quando o PS5 baixar de preço". A IA faz as perguntas e configura tudo.'),
      btn('Criar o primeiro', { kind: 'primary', onclick: () => setView('chat') }, 'plus')));
  }
  const cards = await Promise.all(list.map(async (t) => {
    const [checks, stats] = await Promise.all([api('GET', `/trackers/${t.id}/checks?limit=1`).catch(() => []), api('GET', `/trackers/${t.id}/stats`).catch(() => undefined)]);
    return editingId === t.id ? trackerEditor(t, stats) : trackerCard(t, checks[0], stats);
  }));
  return h('div', { class: 'page' }, head, h('div', { class: 'stack' }, cards));
}

async function viewDetail(t) {
  stopPoll();
  const [stats, checks, sources] = await Promise.all([api('GET', `/trackers/${t.id}/stats`), api('GET', `/trackers/${t.id}/checks?limit=50`), api('GET', `/trackers/${t.id}/sources`).catch(() => [])]);
  const sourceCards = sources.map((s) => h('div', { class: 'card' },
    h('div', { class: 'hist-head' }, h('strong', {}, s.label || hostOf(s.url)),
      s.status === 'ok' ? badge('lendo o preço', 'ok') : s.status === 'failing' ? badge(`falhando (${s.consecutiveFailures}x)`, 'bad') : badge('só pela busca completa', 'warn'),
      s.rule ? badge(s.rule.type === 'generic' ? 'dados estruturados' : 'regra aprendida', 'accent') : s.status === 'ok' ? badge('IA lê o trecho', 'accent') : null,
      s.lastValue != null ? h('span', { class: 'muted small' }, `último: ${money(s.lastValue)}`) : null),
    h('div', { class: 'small' }, link(s.url)),
    s.lastError ? h('div', { class: s.status === 'ok' ? 'muted small' : 'alert', style: 'margin-top:8px' }, s.status === 'ok' ? null : icon('alert'), h('span', {}, s.lastError)) : null));
  const hist = checks.map((c) => h('div', { class: 'card' },
    h('div', { class: 'hist-head' }, h('strong', {}, when(c.at)), c.ok ? badge('ok', 'ok') : badge('falhou', 'bad'), c.mode ? badge(MODE[c.mode] || c.mode, c.mode === 'routine' ? 'ok' : 'accent') : null,
      h('span', { class: 'muted small' }, `${c.model} · US$ ${c.costUsd.toFixed(4)}`)),
    c.ok ? null : h('div', { class: 'alert', style: 'margin-top:8px' }, icon('alert'), h('span', {}, c.error)),
    (c.sources || []).map((r) => h('div', { class: 'finding' },
      h('span', { class: 'val' }, r.ok ? money(r.value) : 'sem preço'),
      h('div', { class: 'info' }, h('div', {}, r.label || hostOf(r.url)), h('div', { class: r.ok ? 'muted' : 'bad' }, r.ok ? `lido por ${METHOD[r.method] || r.method}` : r.error)),
      badge(r.ok ? 'fonte' : 'falhou', r.ok ? 'ok' : 'bad'))),
    c.findings.map((f) => h('div', { class: 'finding' },
      h('span', { class: 'val' }, f.found ? (f.value != null ? money(f.value, f.currency) : '—') : 'nada'),
      h('div', { class: 'info' }, h('div', {}, f.found ? (f.title || f.evidence || '') : f.evidence), f.sourceUrl ? h('div', {}, link(f.sourceUrl)) : null),
      f.found ? badge(`${Math.round(f.confidence * 100)}%`, f.confidence >= 0.6 ? 'ok' : 'warn') : null))));
  view.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, btn('Voltar', { kind: 'ghost', onclick: () => render() }, 'back'),
      h('div', { class: 'grow' }, h('h1', {}, t.name), h('div', { class: 'sub' }, `${t.goal} · alerta: ${COND(t.alertCondition)} · resumo ${DIGEST[t.digest]}`))),
    h('h2', { class: 'section' }, 'Últimos 7 dias'),
    h('div', { class: 'stats' }, metric('Verificações', String(stats.checks), `${stats.failures} falha(s)`), metric('Menor', money(stats.min)), metric('Maior', money(stats.max)), metric('Média', money(stats.avg)), metric('Alertas', String(stats.alerts)), metric('Custo', `US$ ${stats.costUsd.toFixed(4)}`)),
    h('h2', { class: 'section' }, 'Fontes de preço'),
    h('div', { class: 'history' }, sourceCards.length ? sourceCards : h('p', { class: 'muted' }, 'Ainda não há fontes: elas são descobertas na primeira busca completa.')),
    h('h2', { class: 'section' }, 'Histórico de verificações'),
    h('div', { class: 'history' }, hist.length ? hist : h('p', { class: 'muted' }, 'Ainda não houve verificações.'))));
}

/* ======================= Chat de cadastro ======================= */

let chatState;
const SUGGESTIONS = [
  'Avise quando o preço do PS5 Slim digital baixar',
  'Quero acompanhar notícias sobre o lançamento do GTA 6',
  'Monitore o preço de um iPhone 15 novo abaixo de R$ 4.000',
];
function newChat() { chatState = { id: crypto.randomUUID(), msgs: [], proposal: undefined, busy: false }; }

function bubble(m) {
  const user = m.who === 'user';
  return h('div', { class: `msg ${m.who}` }, h('div', { class: 'avatar' }, user ? 'Eu' : icon('bot')), h('div', { class: 'bubble' }, m.text));
}

function viewChat() {
  if (!chatState) newChat();
  const box = h('div', { class: 'msgs' });
  const input = h('textarea', { rows: 1, placeholder: 'Descreva o que você quer acompanhar…', 'aria-label': 'Mensagem' });
  const sendBtn = btn('Enviar', { kind: 'primary' }, 'send');
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; };

  const draw = () => {
    const nodes = [];
    nodes.push(bubble({ who: 'bot', text: 'Olá! Me conte o que você quer acompanhar (preço, notícias…). Vou fazer algumas perguntas e configurar tudo para você.' }));
    if (!chatState.msgs.length) {
      nodes.push(h('div', { class: 'chips' }, SUGGESTIONS.map((s) => h('button', { class: 'chip', onclick: () => { input.value = s; grow(); input.focus(); } }, s))));
    }
    chatState.msgs.forEach((m) => nodes.push(bubble(m)));
    if (chatState.busy) nodes.push(h('div', { class: 'msg typing' }, h('div', { class: 'avatar' }, icon('bot')), h('div', { class: 'bubble' }, h('i'), h('i'), h('i'))));
    if (chatState.proposal) nodes.push(proposalCard(chatState.proposal));
    box.replaceChildren(...nodes);
    box.scrollTop = box.scrollHeight;
    sendBtn.disabled = chatState.busy;
  };
  const send = async () => {
    const text = input.value.trim();
    if (!text || chatState.busy) return;
    input.value = ''; grow();
    chatState.msgs.push({ who: 'user', text });
    chatState.proposal = undefined; chatState.busy = true; draw();
    try {
      const r = await api('POST', `/setup/${chatState.id}/message`, { text });
      chatState.msgs.push({ who: 'bot', text: r.reply || '…' });
      chatState.proposal = r.proposal;
    } catch (e) { chatState.msgs.push({ who: 'bot err', text: e.message }); }
    chatState.busy = false; draw();
  };
  sendBtn.addEventListener('click', send);
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  draw();
  setTimeout(() => input.focus(), 0);
  return h('div', { class: 'page narrow' }, h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', {}, 'Novo acompanhamento'), h('div', { class: 'sub' }, 'Converse com a IA para configurar'))),
    h('div', { class: 'chat' }, box, h('div', { class: 'composer' }, input, sendBtn)));
}

function proposalCard(p) {
  const def = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
  return h('div', { class: 'card proposal' },
    h('h3', {}, icon('check'), 'Confira antes de salvar'),
    h('dl', { class: 'defs' }, def('Nome', p.name), def('Tipo', KIND[p.kind]), def('Objetivo', p.goal), def('Considerar', p.include.join('; ') || '—'), def('Ignorar', p.exclude.join('; ') || '—'),
      def('Verificar a cada', `${p.intervalMinutes} min`), def('Alertar quando', COND(p.alertCondition)), def('Resumo', DIGEST[p.digest])),
    h('div', { class: 'row' },
      btn('Confirmar e salvar', { kind: 'primary', onclick: async () => { try { await api('POST', `/setup/${chatState.id}/confirm`); chatState = undefined; toast('Acompanhamento criado!'); setView('trackers'); } catch (e) { toast(e.message, 'bad'); } } }, 'check'),
      h('span', { class: 'muted small' }, 'Para ajustar, escreva o que quer mudar.')));
}

/* ======================= Relatórios ======================= */

async function viewReports(days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const reports = (await api('GET', `/reports?since=${encodeURIComponent(since)}`)).reverse();
  const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Período' }, [7, 30, 90].map((d) => h('button', { class: d === days ? 'on' : '', onclick: () => render(d) }, `${d} dias`)));
  return h('div', { class: 'page narrow' },
    h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', {}, 'Relatórios'), h('div', { class: 'sub' }, 'Resumos gerados quando há algo relevante')), seg),
    reports.length ? h('div', { class: 'stack' }, reports.map((r) => h('article', { class: 'card' },
      h('div', { class: 'row' }, badge(r.period === 'daily' ? 'Diário' : 'Semanal', 'accent'), h('span', { class: 'muted small' }, when(r.at))),
      h('pre', { class: 'report' }, r.text))))
      : h('div', { class: 'card empty' }, h('div', { class: 'art' }, icon('chart')), h('h3', {}, 'Nenhum resumo neste período'),
        h('p', {}, 'Os resumos só são gerados quando há algo relevante, como uma queda de preço. Configure a frequência em cada acompanhamento.')));
}

/* ======================= Configurações ======================= */

let settingsWa; // estado do WhatsApp quando a tela foi desenhada
const field = (label, el, hint) => h('label', { class: 'field' }, h('span', {}, label), el, hint ? h('small', {}, hint) : null);
const toggle = (title, hint, input) => h('label', { class: 'toggle' }, h('div', { class: 't-text' }, h('b', {}, title), hint ? h('small', {}, hint) : null), input, h('span', { class: 'switch' }));
const section = (title, desc, right, ...body) => h('section', { class: 'card' }, h('div', { class: 'sect-head' }, h('h3', {}, title), h('span', { class: 'grow' }), right), desc ? h('p', { class: 'sect-desc' }, desc) : null, ...body);

async function viewSettings() {
  const s = await api('GET', '/settings');
  const startup = await bt.startupGet();
  const st = await bt.status();
  settingsWa = st.ok ? st.data.whatsapp : 'down';

  const key = h('input', { type: 'password', placeholder: s.hasApiKey ? 'Chave configurada (digite para trocar)' : 'sk-ant-…', autocomplete: 'off', 'aria-label': 'Chave de API da Anthropic' });
  const model = (v) => h('input', { type: 'text', value: v });
  const mSetup = model(s.models.setup), mRoutine = model(s.models.routine), mEsc = model(s.models.escalate);
  const day = h('input', { type: 'number', min: '0', step: '0.1', value: s.limitDayUsd ?? '', placeholder: 'sem limite' });
  const month = h('input', { type: 'number', min: '0', step: '0.5', value: s.limitMonthUsd ?? '', placeholder: 'sem limite' });
  const alertNumber = h('input', { type: 'text', value: s.alertNumber ?? '', placeholder: 'vazio = o próprio número conectado', inputmode: 'tel', 'aria-label': 'Número que recebe os avisos' });
  const wa = h('input', { type: 'checkbox', checked: s.sendReportsToWhatsApp });
  const boot = h('input', { type: 'checkbox', checked: startup });

  const waOk = st.ok && st.data.whatsapp === 'ready';
  const qr = st.ok && st.data.qrImage
    ? h('div', { class: 'row', style: 'align-items:flex-start;gap:18px' }, h('img', { class: 'qr', src: st.data.qrImage, alt: 'QR code do WhatsApp' }),
        h('ol', { class: 'muted', style: 'margin:0;padding-left:18px' }, h('li', {}, 'Abra o WhatsApp no celular'), h('li', {}, 'Toque em Aparelhos conectados'), h('li', {}, 'Conectar um aparelho e escaneie o código')))
    : h('p', { class: waOk ? 'ok' : 'muted', style: 'margin:0' }, waOk ? 'Conectado. Os avisos chegam na conversa com você mesmo.' : 'Aguardando o WhatsApp iniciar… o QR aparece aqui.');
  const testBtn = btn('Enviar mensagem de teste', { disabled: !waOk, onclick: async () => {
    testBtn.disabled = true;
    try { const r = await api('POST', '/whatsapp/test'); r.ok ? toast('Mensagem de teste enviada. Confira no WhatsApp.') : toast(r.error, 'bad'); } catch (e) { toast(e.message, 'bad'); }
    testBtn.disabled = !waOk;
  } }, 'send');

  const save = btn('Salvar alterações', { kind: 'primary', onclick: async () => {
    try {
      const body = { models: { setup: mSetup.value, routine: mRoutine.value, escalate: mEsc.value }, limitDayUsd: day.value === '' ? null : Number(day.value), limitMonthUsd: month.value === '' ? null : Number(month.value), sendReportsToWhatsApp: wa.checked, alertNumber: alertNumber.value.trim() === '' ? null : alertNumber.value.trim() };
      if (key.value.trim()) body.anthropicApiKey = key.value.trim();
      await api('PUT', '/settings', body);
      key.value = '';
      const r = await bt.startupSet(boot.checked);
      r.ok ? toast('Configurações salvas.') : toast(`Salvo, mas não consegui ajustar a inicialização com o Windows: ${r.error}`, 'bad');
      await refreshStatus();
    } catch (e) { toast(e.message, 'bad'); }
  } }, 'check');

  return h('div', { class: 'page narrow' }, h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', {}, 'Configurações'), h('div', { class: 'sub' }, 'IA, custos, avisos e WhatsApp'))),
    h('div', { class: 'stack' },
      section('Inteligência artificial', 'A chave fica criptografada neste computador e nunca é exibida.', badge(s.hasApiKey ? 'Chave configurada' : 'Sem chave', s.hasApiKey ? 'ok' : 'bad'),
        field('Chave de API da Anthropic', key),
        h('div', { class: 'grid3', style: 'margin-top:14px' }, field('Conversa de cadastro', mSetup, 'modelo'), field('Verificações', mRoutine, 'modelo barato'), field('Reforço', mEsc, 'baixa confiança'))),
      section('Limites de custo', 'As verificações pausam sozinhas quando o limite é atingido.', null,
        h('div', { class: 'grid2' }, field('Limite diário (US$)', day), field('Limite mensal (US$)', month))),
      section('Avisos', 'Para o celular notificar, envie para outro número: mensagens que você manda para si mesmo costumam chegar sem som.', null,
        h('div', { style: 'margin-bottom:10px' }, field('Número que recebe os avisos', alertNumber, 'Com DDD, por exemplo 11 99999-0000. Deixe vazio para enviar ao próprio número conectado. Use "Enviar mensagem de teste" para conferir.')),
        toggle('Enviar resumos também no WhatsApp', 'Os resumos sempre aparecem na aba Relatórios.', wa),
        toggle('Iniciar o serviço junto com o Windows', 'Mantém as verificações rodando mesmo com o app fechado.', boot)),
      section('WhatsApp', 'Conexão para receber os alertas.', badge(waOk ? 'Conectado' : st.ok && st.data.whatsapp === 'qr' ? 'Aguardando QR' : 'Desconectado', waOk ? 'ok' : 'warn'),
        qr, h('div', { class: 'row', style: 'margin-top:14px' }, testBtn))),
    h('div', { class: 'savebar' }, save, h('span', { class: 'muted small' }, 'As alterações só valem depois de salvar.')));
}

/* ======================= navegação ======================= */

let renderSeq = 0; // descarta o resultado de uma tela lenta se o usuário já abriu outra
function stopPoll() { clearInterval(pollTimer); }
async function render(arg) {
  stopPoll();
  const mine = ++renderSeq;
  try {
    const node = current === 'trackers' ? await viewTrackers() : current === 'chat' ? viewChat() : current === 'reports' ? await viewReports(arg) : await viewSettings();
    if (mine !== renderSeq) return;
    view.replaceChildren(node);
    view.scrollTop = 0;
    // redesenha só quando o estado do WhatsApp muda (ex.: QR → conectado), para não apagar o que o usuário digitou
    if (current === 'settings') pollTimer = setInterval(async () => { const st = await bt.status(); const now = st.ok ? st.data.whatsapp : 'down'; if (current === 'settings' && now !== settingsWa && !document.activeElement?.matches('input')) render(); }, 5000);
    // mantém "próxima consulta" e horários relativos atualizados
    if (current === 'trackers') pollTimer = setInterval(() => { if (current === 'trackers' && editingId === null && !document.activeElement?.matches('button')) render(); }, 30000);
  } catch (e) {
    if (mine !== renderSeq) return;
    view.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'alert' }, icon('alert'), h('span', {}, e.message))));
  }
}
function setView(name) {
  current = name;
  editingId = null;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  render();
}
document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
document.getElementById('banner-btn').addEventListener('click', async (e) => {
  e.target.disabled = true;
  const r = await bt.startService();
  e.target.disabled = false;
  if (!r.ok) toast(r.error, 'bad');
  await refreshStatus(); await render();
});
refreshStatus().then(render);
setInterval(refreshStatus, 10000);
