const $ = selector => document.querySelector(selector);
const state = { bootstrap: null, mode: 'analyst', space: '', session: null, history: [], tab: 'chat', sending: false };
let pollTimer; let toastTimer;
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; };
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6000); }
async function api(path, method = 'GET', data) {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {}, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const value = await res.json(); if (!res.ok) throw new Error(value.error?.message ?? '请求未成功，请稍后重试。'); return value;
}
function closeSidebar() { document.body.classList.remove('sidebar-open'); $('#shade').hidden = true; }
function setTab(tab) {
  state.tab = tab; $('#chat-panel').hidden = tab !== 'chat'; $('#work-panel').hidden = tab !== 'work';
  document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
}
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('[data-mode]').forEach(button => { button.classList.toggle('selected', button.dataset.mode === mode); button.disabled = !state.bootstrap?.user.spaces.find(s => s.id === state.space)?.modes.includes(button.dataset.mode); });
  $('#mode-note').textContent = `${mode === 'developer' ? 'API 开发' : '数据分析'} · 受控工具`;
  $('#welcome-title').textContent = mode === 'developer' ? '让业务想法，成为一个 API' : '今天想了解哪些数据？';
  $('#welcome-sub').textContent = mode === 'developer' ? '从理解数据到形成草稿，让 DaaS 和你一起完成。' : '从查找 API 到分析结果，让 DaaS 帮你完成下一步。';
  const examples = mode === 'developer'
    ? [['▤', '设计数据 API', '从表结构到查询草稿', '帮我创建一个按月份统计销售额的 API 草稿'], ['⌕', '了解数据结构', '查看当前空间的数据源', '查看当前业务空间有哪些数据源和表结构'], ['▧', '检查查询逻辑', '发现问题，再确认保存', '帮我检查按月汇总订单金额的 SQL，并形成 API 草稿']]
    : [['▥', '分析销售趋势', '从变化中找到下一步', '分析最近半年的销售趋势，并生成图表'], ['⌕', '查找可用接口', '快速找到需要的数据', '查找当前业务空间可用的销售查询接口'], ['▧', '生成业务报告', '让数据成为清晰的结论', '查询销售数据，生成一份带图表的 HTML 报告']];
  $('#suggestions').replaceChildren(...examples.map(([icon, title, note, prompt]) => {
    const button = el('button', 'suggestion'); button.append(el('span', 'suggestion-icon', icon), el('strong', '', title), el('small', '', note));
    button.addEventListener('click', () => { $('#prompt').value = prompt; $('#prompt').focus(); }); return button;
  }));
  renderHistory();
}
function fresh() { clearTimeout(pollTimer); state.session = null; $('#prompt').value = ''; setTab('chat'); render(); closeSidebar(); }
async function refreshHistory() { state.history = (await api('/api/sessions')).sessions; renderHistory(); }
function renderHistory() {
  const query = $('#search').value.toLowerCase();
  const history = state.history.filter(s => s.mode === state.mode && s.space === state.space && s.title.toLowerCase().includes(query));
  $('#history-count').textContent = history.length;
  $('#history').replaceChildren(...(history.length ? history.map(session => {
    const button = el('button', session.id === state.session?.id ? 'current' : '', session.title); button.title = session.title;
    button.addEventListener('click', () => openSession(session.id).catch(e => toast(e.message))); return button;
  }) : [el('p', 'muted', query ? '没有找到相关对话。' : '开始一个问题，对话会保存在这里。')]));
}
async function openSession(id) {
  clearTimeout(pollTimer); const session = await api(`/api/sessions/${id}`); state.session = session; state.space = session.space; $('#space').value = state.space; setMode(session.mode); render(); closeSidebar();
  if (session.task.status === 'running') schedulePoll(session.id);
}
function render() {
  const s = state.session; const running = state.sending || s?.task.status === 'running';
  $('#welcome').hidden = Boolean(s?.messages.length); $('#running').hidden = !running;
  $('#send').hidden = Boolean(s?.task.status === 'running'); $('#send').disabled = state.sending || !state.bootstrap;
  $('#stop').hidden = s?.task.status !== 'running'; $('#stop').disabled = false;
  $('#running-label').textContent = s?.traces.findLast(t => t.state === 'running')?.label ?? 'DaaS 正在处理任务…';
  const panel = $('#chat-panel'); const nearBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 150;
  const nodes = (s?.messages ?? []).map(message => {
    const item = el('article', `message ${message.role}`);
    if (message.role === 'assistant') { const label = el('div', 'message-label'); label.append(el('span', 'message-logo', 'D'), el('span', '', 'DaaS Agent')); item.append(label); }
    item.append(el('div', 'bubble', message.text)); return item;
  });
  if (s?.traces.length) {
    const details = el('details', 'trace-details'); const wasOpen = $('#messages details')?.open; details.open = Boolean(wasOpen);
    details.append(el('summary', '', `查看任务过程 · ${s.traces.length} 步`));
    s.traces.forEach(t => details.append(el('p', '', `${t.state === 'done' ? '✓' : t.state === 'error' ? '!' : '…'} ${t.label}`)));
    nodes.push(details);
  }
  if (s && (s.results.length || s.artifacts.length || s.approvals.length)) {
    const link = el('button', 'work-link', '在工作台查看结果 ↗'); link.addEventListener('click', () => setTab('work')); nodes.push(link);
  }
  $('#messages').replaceChildren(...nodes);
  if (nearBottom || running) panel.scrollTop = panel.scrollHeight;
  renderWork(); renderHistory();
}
function card(title, note) {
  const article = el('article', 'work-card'); const head = el('div', 'card-head'); const heading = el('div');
  heading.append(el('h2', '', title)); if (note) heading.append(el('small', '', note)); head.append(heading); article.append(head); return { article, head };
}
function download(head, url, label) { const link = el('a', '', label); link.href = url; link.setAttribute('download', ''); head.append(link); }
function renderWork() {
  const s = state.session;
  const count = (s?.artifacts.length ?? 0) + (s?.results.length ?? 0) + (s?.approvals.filter(a => a.state === 'pending').length ?? 0);
  $('#artifact-count').textContent = count; $('#empty-work').hidden = Boolean(count || s?.approvals.length);
  $('#approvals').replaceChildren(...(s?.approvals ?? []).map(a => {
    const { article, head } = card(`操作确认 · ${a.title ?? a.toolId}`,  '确认只针对以下内容，不会授予其他操作权限');
    const body = el('div', 'approval-body'); body.append(el('pre', '', JSON.stringify(a.args, null, 2)));
    const labels = { pending: '等待你的确认', executing: '已提交，等待结果', done: '已处理', denied: '已取消', expired: '确认已过期', unknown: '状态未知，请先核对平台，勿重复提交' };
    head.append(el('span', 'approval-status', labels[a.state] ?? a.state));
    if (a.state === 'pending' && a.expiresAt > Date.now()) {
      for (const [accept, label] of [[true, '确认执行'], [false, '取消']]) {
        const button = el('button', accept ? 'primary' : '', label); button.disabled = s.task.status === 'running';
        button.addEventListener('click', async () => {
          body.querySelectorAll('button').forEach(b => { b.disabled = true; });
          try { state.session = await api(`/api/sessions/${s.id}/approvals/${a.id}`, 'POST', { accept }); render(); }
          catch (e) { toast(e.message); await openSession(s.id).catch(() => {}); }
        }); body.append(button);
      }
    } else if (a.output) body.append(el('pre', '', JSON.stringify(a.output, null, 2)));
    else if (a.expiresAt <= Date.now()) body.append(el('p', 'approval-status', '这份确认已过期，请重新生成。'));
    article.append(body); return article;
  }));
  // Reuse existing iframes when polling only changes task metadata.
  const key = (s?.artifacts ?? []).map(a => a.id).join(':');
  if ($('#artifacts').dataset.key !== key) {
    $('#artifacts').dataset.key = key;
    $('#artifacts').replaceChildren(...(s?.artifacts ?? []).map(a => {
      const { article, head } = card(a.title, '静态报告 · 隔离预览'); const url = `/api/sessions/${s.id}/artifacts/${a.id}`;
      download(head, `${url}?download=1`, '下载 HTML'); const frame = el('iframe', 'report-frame'); frame.title = a.title; frame.setAttribute('sandbox', ''); frame.referrerPolicy = 'no-referrer'; frame.src = url; article.append(frame); return article;
    }));
  }
  $('#results').replaceChildren(...(s?.results ?? []).map(r => {
    const { article, head } = card(r.title, `${r.demo ? '演示数据 · ' : ''}${r.totalRows} 行 · ${r.complete ? '结果完整' : '仅部分数据'} · ${r.source}`);
    download(head, `/api/sessions/${s.id}/results/${r.id}`, '下载 JSON');
    const wrap = el('div', 'table-wrap'); const table = el('table'); const fields = Object.keys(r.rows[0] ?? {}).slice(0, 12); const thead = el('thead'); const tr = el('tr');
    fields.forEach(f => tr.append(el('th', '', f))); thead.append(tr); table.append(thead); const tbody = el('tbody');
    r.rows.forEach(row => { const tr = el('tr'); fields.forEach(f => tr.append(el('td', '', typeof row[f] === 'object' ? JSON.stringify(row[f]) : row[f] ?? ''))); tbody.append(tr); });
    table.append(tbody); wrap.append(table); if (r.totalRows > 30) wrap.append(el('p', 'muted', '当前预览前 30 行，完整已存储结果可下载。')); article.append(wrap); return article;
  }));
}
function schedulePoll(id) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (state.session?.id !== id) return;
    try {
      const update = await api(`/api/sessions/${id}?after=${state.session.revision}`);
      if (state.session?.id !== id) return;
      if (!update.unchanged) { state.session = update; render(); }
      if (state.session.task.status === 'running') schedulePoll(id); else await refreshHistory();
    } catch (e) { toast(e.message); if (state.session?.id === id) schedulePoll(id); }
  }, 900);
}
async function send(event) {
  event.preventDefault(); const text = $('#prompt').value.trim();
  if (!text || state.sending || state.session?.task.status === 'running' || !state.bootstrap) return;
  state.sending = true; render();
  try {
    if (!state.session) state.session = await api('/api/sessions', 'POST', { space: state.space, mode: state.mode });
    state.session = await api(`/api/sessions/${state.session.id}/messages`, 'POST', { text });
    $('#prompt').value = ''; $('#prompt').style.height = ''; setTab('chat'); schedulePoll(state.session.id); await refreshHistory();
  } catch (e) { toast(e.message); }
  finally { state.sending = false; render(); }
}
$('#composer').addEventListener('submit', send);
$('#prompt').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) send(e); });
$('#prompt').addEventListener('input', () => { $('#prompt').style.height = ''; $('#prompt').style.height = `${Math.min(180, $('#prompt').scrollHeight)}px`; });
$('#new-chat').addEventListener('click', fresh);
$('#search').addEventListener('input', renderHistory);
$('#space').addEventListener('change', () => { state.space = $('#space').value; const modes = state.bootstrap.user.spaces.find(s => s.id === state.space).modes; setMode(modes.includes(state.mode) ? state.mode : modes[0]); fresh(); });
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => { if (button.dataset.mode !== state.mode) { setMode(button.dataset.mode); fresh(); } }));
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));
$('#toggle-sidebar').addEventListener('click', () => { if (window.innerWidth <= 800) { const open = document.body.classList.toggle('sidebar-open'); $('#shade').hidden = !open; } else document.body.classList.toggle('sidebar-collapsed'); });
$('#shade').addEventListener('click', closeSidebar);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSidebar(); });
$('#stop').addEventListener('click', async () => { if (!state.session) return; $('#stop').disabled = true; try { await api(`/api/sessions/${state.session.id}/stop`, 'POST', {}); } catch (e) { toast(e.message); $('#stop').disabled = false; } });
async function boot() {
  try {
    state.bootstrap = await api('/api/bootstrap'); const spaces = state.bootstrap.user.spaces.filter(s => s.modes.length);
    if (!spaces.length) throw new Error('当前账号没有可用的业务空间，请联系管理员。');
    state.space = spaces[0].id; $('#space').replaceChildren(...spaces.map(s => { const option = el('option', '', s.name); option.value = s.id; return option; }));
    $('#user-name').textContent = state.bootstrap.user.name; $('#profile-note').textContent = state.bootstrap.demo ? '演示空间 · 本地体验' : 'DaaS 平台已验证身份';
    $('#environment').hidden = !state.bootstrap.demo;
    if (state.bootstrap.demo) $('#footnote').textContent = '演示模式使用固定流程和示例数据，不连接模型或真实业务系统。';
    setMode(spaces[0].modes.includes('analyst') ? 'analyst' : spaces[0].modes[0]); render(); await refreshHistory();
  } catch (e) { state.bootstrap = null; $('#user-name').textContent = '尚未连接'; toast(e.message); render(); }
}
setMode('analyst'); render(); boot();
