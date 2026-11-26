'use strict';
const bt = window.buscaTudo;
const view = document.getElementById('view');
let current = 'trackers';
let pollTimer;

/** Cria elementos sem innerHTML: todo texto (inclusive o vindo da web) entra como textContent. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const money = (n, cur) => (n == null ? '—' : `${!cur || cur === 'BRL' ? 'R$' : cur} ${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const when = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR') : '—');
const link = (url, label) => h('a', { class: 'link', onclick: () => bt.openExternal(url) }, label || url);
const KIND = { price: 'preço', news: 'notícias', generic: 'geral' };
const COND = (c) => (c.type === 'below_last' ? 'abaixo do último valor' : c.type === 'below_value' ? `abaixo de ${money(c.value)}` : 'qualquer novidade');

async function api(method, path, body) {
  const r = await bt.api(method, path, body);
  if (!r.ok) {
    if (r.serviceDown) showBanner('O serviço está parado. Os acompanhamentos não são verificados.', true);
    throw new Error(r.error);
  }
  return r.data;
}

function showBanner(text, withButton) {
  document.getElementById('banner').classList.toggle('hidden', !text);
  document.getElementById('banner-text').textContent = text || '';
  document.getElementById('banner-btn').classList.toggle('hidden', !withButton);
}

function setPill(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = `pill ${cls || ''}`.trim();
}

let lastStatus;
async function refreshStatus() {
  const r = await bt.status();
  if (!r.ok) {
    lastStatus = undefined;
    setPill('st-service', 'serviço parado', 'bad');
    setPill('st-whatsapp', 'WhatsApp —', '');
    setPill('st-key', 'chave —', '');
    showBanner('O serviço está parado. Os acompanhamentos não são verificados.', true);
    return;
  }
  lastStatus = r.data;
  const s = r.data;
  setPill('st-service', 'serviço rodando', 'ok');
  setPill('st-whatsapp', s.whatsapp === 'ready' ? 'WhatsApp conectado' : s.whatsapp === 'qr' ? 'WhatsApp: escaneie o QR' : 'WhatsApp desconectado', s.whatsapp === 'ready' ? 'ok' : 'warn');
  setPill('st-key', s.hasApiKey ? 'chave configurada' : 'sem chave da Anthropic', s.hasApiKey ? 'ok' : 'bad');
  document.getElementById('st-limit').classList.toggle('hidden', !s.overLimit);
  showBanner(s.hasApiKey ? '' : 'Configure a chave da Anthropic em Configurações para começar.', false);
}

/* ---------- Acompanhamentos ---------- */
async function viewTrackers() {
  const list = await api('GET', '/trackers');
  const root = h('div', {}, h('h1', {}, 'Acompanhamentos'));
  if (!list.length) root.append(h('p', { class: 'muted' }, 'Nenhum acompanhamento ainda. Use "Novo acompanhamento" para descrever o que quer acompanhar.'));
  for (const t of list) {
    const checks = await api('GET', `/trackers/${t.id}/checks?limit=1`).catch(() => []);
    const last = checks[0];
    const best = last?.findings?.filter((f) => f.found && f.value != null).sort((a, b) => a.value - b.value)[0];
    const state = !last ? 'nunca verificado' : last.ok ? `última: ${when(last.at)}` : `falhou em ${when(last.at)}: ${last.error}`;
    const result = h('span', { class: 'muted' });
    const card = h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('div', { class: 'grow' },
          h('strong', {}, t.name), ' ', h('span', { class: 'pill' }, KIND[t.kind]), ' ',
          t.status === 'paused' ? h('span', { class: 'pill warn' }, 'pausado') : null,
          h('div', { class: 'muted' }, `${t.goal} · a cada ${t.intervalMinutes} min · alerta ${COND(t.alertCondition)}`),
          h('div', { class: last && !last.ok ? 'bad' : 'muted' }, state, best ? ` · melhor: ${money(best.value, best.currency)}` : ''),
          result),
        h('button', { onclick: async (e) => { e.target.disabled = true; result.textContent = 'Verificando…'; try { const r = await api('POST', `/trackers/${t.id}/check`); result.textContent = r.ok ? (r.alerted ? 'Alerta enviado!' : r.baseline ? 'Linha de base registrada.' : 'Verificado, sem novidades.') : `Falhou: ${r.error}`; } catch (err) { result.textContent = err.message; } await render(); } }, 'Verificar agora'),
        h('button', { onclick: async () => { await api('PATCH', `/trackers/${t.id}`, { status: t.status === 'active' ? 'paused' : 'active' }); await render(); } }, t.status === 'active' ? 'Pausar' : 'Retomar'),
        h('button', { onclick: () => viewDetail(t) }, 'Detalhes'),
        deleteButton(t)));
    root.append(card);
  }
  return root;
}

function deleteButton(t) {
  const b = h('button', { class: 'danger' }, 'Excluir');
  let armed = false;
  b.addEventListener('click', async () => {
    if (!armed) { armed = true; b.textContent = 'Confirmar exclusão'; setTimeout(() => { armed = false; b.textContent = 'Excluir'; }, 4000); return; }
    await api('DELETE', `/trackers/${t.id}`);
    await render();
  });
  return b;
}

async function viewDetail(t) {
  stopPoll();
  const [stats, checks] = await Promise.all([api('GET', `/trackers/${t.id}/stats`), api('GET', `/trackers/${t.id}/checks?limit=50`)]);
  const stat = (label, v) => h('div', { class: 'stat' }, h('span', { class: 'muted' }, label), h('b', {}, v));
  view.replaceChildren(h('div', {},
    h('div', { class: 'row' }, h('button', { onclick: () => render() }, '← Voltar'), h('h1', { class: 'grow' }, t.name)),
    h('p', { class: 'muted' }, `${t.goal} · alerta ${COND(t.alertCondition)} · resumo ${{ none: 'desligado', daily: 'diário', weekly: 'semanal' }[t.digest]}`),
    h('h2', {}, 'Últimos 7 dias'),
    h('div', { class: 'stats' }, stat('Verificações', stats.checks), stat('Falhas', stats.failures), stat('Menor', money(stats.min)), stat('Maior', money(stats.max)), stat('Média', money(stats.avg)), stat('Alertas', stats.alerts)),
    h('h2', {}, 'Histórico'),
    ...checks.map((c) => h('div', { class: 'card' },
      h('div', { class: c.ok ? '' : 'bad' }, `${when(c.at)} · ${c.ok ? 'ok' : `falhou: ${c.error}`} · ${c.model} · US$ ${c.costUsd.toFixed(4)}`),
      ...c.findings.map((f) => h('div', { class: 'muted' }, f.found ? [f.title || '', f.value != null ? ` ${money(f.value, f.currency)}` : '', ` (confiança ${Math.round(f.confidence * 100)}%) `, f.sourceUrl ? link(f.sourceUrl) : ''] : 'nada encontrado'))))));
}

/* ---------- Chat de cadastro ---------- */
let chatState;
function newChat() {
  chatState = { id: crypto.randomUUID(), msgs: [{ who: 'bot', text: 'Olá! Descreva o que você quer acompanhar, por exemplo: "quero acompanhar o preço do PS5 e ser avisado no WhatsApp quando aparecer um preço menor que o último".' }], proposal: undefined, busy: false };
}
function viewChat() {
  if (!chatState) newChat();
  const box = h('div', { class: 'msgs' });
  const input = h('textarea', { rows: 2, placeholder: 'Escreva aqui…' });
  const sendBtn = h('button', { class: 'primary' }, 'Enviar');
  const draw = () => {
    box.replaceChildren(...chatState.msgs.map((m) => h('div', { class: `msg ${m.who}` }, m.text)));
    if (chatState.proposal) box.append(proposalCard(chatState.proposal));
    box.scrollTop = box.scrollHeight;
    sendBtn.disabled = chatState.busy;
  };
  const send = async () => {
    const text = input.value.trim();
    if (!text || chatState.busy) return;
    input.value = '';
    chatState.msgs.push({ who: 'user', text });
    chatState.proposal = undefined;
    chatState.busy = true; draw();
    try {
      const r = await api('POST', `/setup/${chatState.id}/message`, { text });
      chatState.msgs.push({ who: 'bot', text: r.reply || '…' });
      chatState.proposal = r.proposal;
    } catch (e) {
      chatState.msgs.push({ who: 'bot err', text: e.message });
    }
    chatState.busy = false; draw();
  };
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  draw();
  return h('div', { class: 'chat' }, h('h1', {}, 'Novo acompanhamento'), box,
    h('div', { class: 'compose' }, h('div', { class: 'grow' }, input), sendBtn));
}

function proposalCard(p) {
  const line = (k, v) => h('div', {}, h('span', { class: 'muted' }, `${k}: `), v);
  return h('div', { class: 'card' },
    h('strong', {}, 'Confira antes de salvar'),
    line('Nome', p.name), line('Tipo', KIND[p.kind]), line('Objetivo', p.goal),
    line('Considerar', p.include.join('; ') || '—'), line('Ignorar', p.exclude.join('; ') || '—'),
    line('Verificar a cada', `${p.intervalMinutes} min`), line('Alertar quando', COND(p.alertCondition)),
    line('Resumo', { none: 'desligado', daily: 'diário', weekly: 'semanal' }[p.digest]),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: async () => { try { await api('POST', `/setup/${chatState.id}/confirm`); chatState = undefined; setView('trackers'); } catch (e) { chatState.msgs.push({ who: 'bot err', text: e.message }); await render(); } } }, 'Confirmar e salvar'),
      h('span', { class: 'muted' }, 'Para ajustar, é só escrever o que quer mudar.')));
}

/* ---------- Relatórios ---------- */
async function viewReports(days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const reports = (await api('GET', `/reports?since=${encodeURIComponent(since)}`)).reverse();
  const sel = h('select', { onchange: (e) => { render(Number(e.target.value)); } }, ...[7, 30, 90].map((d) => h('option', { value: d, selected: d === days }, `Últimos ${d} dias`)));
  return h('div', {}, h('h1', {}, 'Relatórios'), h('div', { class: 'row' }, sel),
    !reports.length ? h('p', { class: 'muted' }, 'Nenhum resumo no período. Resumos só são gerados quando há algo relevante (como uma queda de preço).') : null,
    ...reports.map((r) => h('div', { class: 'card' }, h('strong', {}, `${r.period === 'daily' ? 'Diário' : 'Semanal'} · ${when(r.at)}`), h('pre', { class: 'report' }, r.text))));
}

/* ---------- Configurações ---------- */
async function viewSettings() {
  const s = await api('GET', '/settings');
  const startup = await bt.startupGet();
  const key = h('input', { type: 'password', placeholder: s.hasApiKey ? 'Chave já configurada (digite para trocar)' : 'sk-ant-…', autocomplete: 'off' });
  const model = (name, v) => h('input', { type: 'text', value: v, 'data-m': name });
  const mSetup = model('setup', s.models.setup), mRoutine = model('routine', s.models.routine), mEsc = model('escalate', s.models.escalate);
  const day = h('input', { type: 'number', min: '0', step: '0.1', value: s.limitDayUsd ?? '' });
  const month = h('input', { type: 'number', min: '0', step: '0.5', value: s.limitMonthUsd ?? '' });
  const wa = h('input', { type: 'checkbox', checked: s.sendReportsToWhatsApp });
  const boot = h('input', { type: 'checkbox', checked: startup });
  const msg = h('span', { class: 'muted' });
  const field = (label, el) => h('label', { class: 'field' }, h('span', {}, label), el);
  const st = await bt.status();
  const qr = st.ok && st.data.qrImage ? h('div', {}, h('p', {}, 'Abra o WhatsApp no celular → Aparelhos conectados → Conectar um aparelho e escaneie:'), h('img', { class: 'qr', src: st.data.qrImage, alt: 'QR code do WhatsApp' })) : h('p', { class: 'muted' }, st.ok && st.data.whatsapp === 'ready' ? 'WhatsApp conectado.' : 'Aguardando o WhatsApp iniciar… (o QR aparece aqui)');
  const save = h('button', { class: 'primary', onclick: async () => {
    try {
      const body = { models: { setup: mSetup.value, routine: mRoutine.value, escalate: mEsc.value }, limitDayUsd: day.value === '' ? null : Number(day.value), limitMonthUsd: month.value === '' ? null : Number(month.value), sendReportsToWhatsApp: wa.checked };
      if (key.value.trim()) body.anthropicApiKey = key.value.trim();
      await api('PUT', '/settings', body);
      key.value = '';
      const r = await bt.startupSet(boot.checked);
      msg.textContent = r.ok ? 'Salvo.' : `Salvo, mas não foi possível ajustar a inicialização com o Windows: ${r.error}`;
      await refreshStatus();
    } catch (e) { msg.textContent = e.message; }
  } }, 'Salvar');
  return h('div', {}, h('h1', {}, 'Configurações'),
    h('div', { class: 'card' }, h('h2', {}, 'Anthropic'), field('Chave de API (fica criptografada neste computador)', key),
      field('Modelo da conversa de cadastro', mSetup), field('Modelo das verificações', mRoutine), field('Modelo de reforço (baixa confiança)', mEsc)),
    h('div', { class: 'card' }, h('h2', {}, 'Custo'), field('Limite diário (US$, vazio = sem limite)', day), field('Limite mensal (US$, vazio = sem limite)', month)),
    h('div', { class: 'card' }, h('h2', {}, 'Geral'),
      h('label', { class: 'row' }, wa, 'Enviar resumos (relatórios) também no WhatsApp'),
      h('label', { class: 'row' }, boot, 'Iniciar o serviço junto com o Windows')),
    h('div', { class: 'card' }, h('h2', {}, 'WhatsApp'), qr),
    h('div', { class: 'row' }, save, msg));
}

/* ---------- Navegação ---------- */
function stopPoll() { clearInterval(pollTimer); }
async function render(arg) {
  stopPoll();
  try {
    const node = current === 'trackers' ? await viewTrackers() : current === 'chat' ? viewChat() : current === 'reports' ? await viewReports(arg) : await viewSettings();
    view.replaceChildren(node);
    if (current === 'settings') pollTimer = setInterval(async () => { const st = await bt.status(); if (st.ok && (st.data.qrImage || st.data.whatsapp === 'ready') && current === 'settings' && !document.activeElement?.matches('input')) { render(); } }, 5000);
  } catch (e) {
    view.replaceChildren(h('p', { class: 'bad' }, e.message));
  }
}
function setView(name) {
  current = name;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  render();
}
document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
document.getElementById('banner-btn').addEventListener('click', async (e) => {
  e.target.disabled = true;
  const r = await bt.startService();
  e.target.disabled = false;
  if (!r.ok) document.getElementById('banner-text').textContent = r.error;
  await refreshStatus(); await render();
});
refreshStatus().then(render);
setInterval(refreshStatus, 10000);
