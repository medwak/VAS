/* VASlink dashboard: a small hash-routed single-page app over the REST API. */
(function () {
  'use strict';

  const { icon, hydrate } = window.VASIcons;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = { key: null, account: null, timer: null };

  // ------------------------------------------------------------- helpers

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const h = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const nf = new Intl.NumberFormat('en-KE');
  const num = (n) => nf.format(n || 0);
  const kes = (n) => `KES ${new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0)}`;
  const when = (iso) => iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const ago = (iso) => {
    const s = Math.round((Date.now() - new Date(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return when(iso);
  };
  const badge = (status) => `<span class="badge ${h(status)}">${h(status)}</span>`;
  const empty = (ic, text) => `<div class="empty">${icon(ic)}<div>${text}</div></div>`;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  function toast(message, type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: { 'X-API-Key': state.key || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    if (res.status === 401 && path !== '/account') {
      logout();
      throw new Error('Session expired, please sign in again');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function modal(html) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    hydrate(wrap);
    return { el: wrap, close };
  }

  async function withBusy(btn, fn) {
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = 'Working…';
    try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = label; }
  }

  function poll(fn, ms = 2500) {
    clearInterval(state.timer);
    state.timer = setInterval(() => { if (!document.hidden) fn().catch(() => {}); }, ms);
  }

  async function refreshBalance() {
    const acc = await api('/account');
    state.account = acc;
    $('#sideBalance').textContent = kes(acc.balance);
    return acc;
  }

  // ---------------------------------------------------------------- auth

  async function login(key) {
    state.key = key.trim();
    try {
      const acc = await refreshBalance();
      store.set('vas-key', state.key);
      $('#auth').hidden = true;
      $('#app').hidden = false;
      $('#accountName').textContent = acc.name;
      $('#avatar').textContent = acc.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
      route();
      return true;
    } catch {
      state.key = null;
      return false;
    }
  }

  function logout() {
    store.del('vas-key');
    state.key = null;
    clearInterval(state.timer);
    $('#app').hidden = true;
    $('#auth').hidden = false;
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await login($('#apiKey').value);
    $('#loginError').hidden = ok;
    if (!ok) $('#loginError').textContent = 'That API key was not accepted.';
  });
  $('#demoBtn').addEventListener('click', async () => {
    try {
      const { apiKey } = await fetch('/api/demo-key').then((r) => { if (!r.ok) throw new Error(); return r.json(); });
      $('#apiKey').value = apiKey;
      await login(apiKey);
    } catch {
      $('#loginError').hidden = false;
      $('#loginError').textContent = 'The demo account is disabled on this server.';
    }
  });
  $('#logoutBtn').addEventListener('click', logout);

  // -------------------------------------------------------------- router

  const views = {};
  const titles = {
    overview: 'Overview', send: 'Send SMS', campaigns: 'Campaigns', inbox: 'Inbox & opt-outs', contacts: 'Contacts',
    subscriptions: 'Subscriptions', ussd: 'USSD apps', airtime: 'Airtime', wallet: 'Wallet & billing', developers: 'Developers',
  };

  async function route() {
    if (!state.key) return;
    clearInterval(state.timer);
    const name = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'overview';
    const view = views[name] ? name : 'overview';
    $$('.side-nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
    $('#viewTitle').textContent = titles[view];
    document.title = `${titles[view]} · VASlink`;
    closeSidebar();
    const root = $('#view');
    root.innerHTML = '<div class="grid"><div class="skeleton" style="width:40%;height:28px"></div><div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:240px"></div></div>';
    try {
      await views[view](root);
      hydrate(root);
    } catch (err) {
      root.innerHTML = `<div class="notice err">${h(err.message)}</div>`;
    }
  }
  addEventListener('hashchange', route);

  const sidebar = $('#sidebar');
  const scrim = $('#scrim');
  function closeSidebar() { sidebar.classList.remove('open'); scrim.classList.remove('show'); }
  $('#burger').addEventListener('click', () => { sidebar.classList.add('open'); scrim.classList.add('show'); });
  scrim.addEventListener('click', closeSidebar);

  const pageHead = (title, sub, actions = '') =>
    `<div class="page-head"><div><h2>${title}</h2><p>${sub}</p></div><div style="display:flex;gap:8px;flex-wrap:wrap">${actions}</div></div>`;

  // ------------------------------------------------------------ overview

  function kpi(label, value, sub, ic, tone) {
    return `<div class="card kpi"><div class="k-top"><span>${label}</span><span class="k-icon ${tone}">${icon(ic)}</span></div>
      <div class="k-value" title="${h(value)}">${value}</div><div class="k-sub">${sub}</div></div>`;
  }

  function barChart(days) {
    const W = 640, H = 240, pad = { l: 36, r: 8, t: 12, b: 28 };
    // Four evenly spaced, "nice" integer ticks (1, 2, 5 × 10^n).
    const max = Math.max(4, ...days.map((d) => d.sent));
    const raw = max / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const top = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag * 4;
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const bw = iw / days.length;
    const y = (v) => pad.t + ih - (v / top) * ih;
    let svg = '';
    for (let i = 0; i <= 4; i++) {
      const v = (top / 4) * i;
      svg += `<line class="gridline" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${num(Math.round(v))}</text>`;
    }
    days.forEach((d, i) => {
      const x = pad.l + i * bw + bw * 0.18;
      const w = (bw * 0.64) / 2;
      const label = new Date(d.date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
      svg += `<rect x="${x}" y="${y(d.sent)}" width="${w - 2}" height="${Math.max(0, pad.t + ih - y(d.sent))}" rx="3" fill="var(--brand)"><title>${label}: ${d.sent} sent</title></rect>`;
      svg += `<rect x="${x + w}" y="${y(d.delivered)}" width="${w - 2}" height="${Math.max(0, pad.t + ih - y(d.delivered))}" rx="3" fill="var(--accent)"><title>${label}: ${d.delivered} delivered</title></rect>`;
      svg += `<text x="${pad.l + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${label}</text>`;
    });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Messages per day">${svg}</svg>`;
  }

  views.overview = async (root) => {
    const render = async () => {
      const s = await api('/stats');
      $('#sideBalance').textContent = kes(s.balance);
      const netTotal = Object.values(s.byNetwork).reduce((a, b) => a + b, 0) || 1;
      const netColors = { Safaricom: 'var(--success)', Airtel: 'var(--danger)', Telkom: 'var(--brand)', Unknown: 'var(--text-faint)' };
      root.innerHTML = `
        ${pageHead('Good to see you 👋', 'Here is what is happening across your services.', '<a href="#/wallet" class="btn btn-ghost btn-sm"><i data-icon="wallet"></i>Top up</a>')}
        <div class="kpis">
          ${kpi('Wallet balance', kes(s.balance), `${kes(s.spend)} spent to date`, 'wallet', 'tone-indigo')}
          ${kpi('Messages sent', num(s.sms.total), `${num(s.sms.pending)} in flight`, 'sms', 'tone-teal')}
          ${kpi('Delivery rate', `${s.sms.deliveryRate}%`, `${num(s.sms.delivered)} delivered · ${num(s.sms.failed)} failed`, 'check', 'tone-green')}
          ${kpi('Active subscribers', num(s.subscribers), `${kes(s.premiumRevenue)} premium revenue`, 'star', 'tone-amber')}
        </div>
        <div class="grid-3-2">
          <div class="card">
            <div class="card-head"><div><h3>Messages, last 7 days</h3><p>Sent vs delivered</p></div>
              <div class="legend"><span><i style="background:var(--brand)"></i>Sent</span><span><i style="background:var(--accent)"></i>Delivered</span></div></div>
            <div class="card-body">${barChart(s.daily)}</div>
          </div>
          <div class="card">
            <div class="card-head"><div><h3>Traffic by network</h3><p>Share of messages</p></div></div>
            <div class="card-body">
              ${Object.keys(s.byNetwork).length ? `<div class="bar-list">${Object.entries(s.byNetwork).sort((a, b) => b[1] - a[1]).map(([n, c]) => `
                <div class="row"><div class="row-top"><span>${h(n)}</span><span class="muted">${num(c)} · ${Math.round((c / netTotal) * 100)}%</span></div>
                <div class="track"><div class="fill" style="width:${(c / netTotal) * 100}%;background:${netColors[n] || 'var(--brand)'}"></div></div></div>`).join('')}</div>`
                : empty('chart', 'No traffic yet. <a href="#/send">Send your first SMS</a>.')}
              <div class="summary" style="margin-top:24px">
                <div class="line"><span class="muted">Airtime disbursed</span><b>${kes(s.airtime)}</b></div>
                <div class="line"><span class="muted">USSD sessions</span><b>${num(s.ussdSessions)}</b></div>
                <div class="line"><span class="muted">Contacts</span><b>${num(s.contacts)}</b></div>
              </div>
            </div>
          </div>
        </div>
        <div class="card" style="margin-top:18px">
          <div class="card-head"><div><h3>Recent campaigns</h3></div><a href="#/campaigns" class="btn btn-ghost btn-sm">View all</a></div>
          ${campaignTable(s.recentCampaigns)}
        </div>`;
      hydrate(root);
      bindCampaignRows(root);
    };
    await render();
    poll(render, 4000);
  };

  // ------------------------------------------------------------ send SMS

  views.send = async (root) => {
    const [senderIds, groups] = await Promise.all([api('/sender-ids'), api('/groups')]);
    const approved = senderIds.filter((s) => s.status === 'approved');
    root.innerHTML = `
      ${pageHead('Compose bulk SMS', 'Personalise, preview the cost, and send now or later.')}
      <div class="grid-3-2">
        <form class="card" id="sendForm">
          <div class="card-body form">
            <div class="row-2">
              <div class="field"><label for="cName">Campaign name</label><input id="cName" placeholder="e.g. October promo"></div>
              <div class="field"><label for="cSender">Sender ID</label>
                <select id="cSender">${approved.map((s) => `<option>${h(s.name)}</option>`).join('')}</select>
                <span class="hint">Request new IDs under <a href="#/developers">Developers</a>.</span></div>
            </div>
            <div class="field">
              <label>Groups</label>
              <div class="chips">${groups.length ? groups.map((g) => `<label class="chip"><input type="checkbox" name="groups" value="${h(g.id)}">${h(g.name)} <span class="muted">${g.size}</span></label>`).join('') : '<span class="muted">No groups yet.</span>'}</div>
            </div>
            <div class="field">
              <label for="cRecipients">Additional numbers</label>
              <textarea id="cRecipients" rows="3" placeholder="0712345678, 0733456789 … (comma, space or one per line)"></textarea>
            </div>
            <div class="field">
              <label for="cMessage">Message</label>
              <textarea id="cMessage" rows="5" placeholder="Hi {first_name}, …" maxlength="1530"></textarea>
              <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
                <div style="display:flex;gap:6px;flex-wrap:wrap">
                  <button type="button" class="tag-btn" data-tag="{name}">{name}</button>
                  <button type="button" class="tag-btn" data-tag="{first_name}">{first_name}</button>
                  <button type="button" class="tag-btn" data-tag="{phone}">{phone}</button>
                </div>
                <div class="counter" id="counter"></div>
              </div>
            </div>
            <div class="row-2">
              <div class="field"><label for="cWhen">Schedule (optional)</label><input type="datetime-local" id="cWhen"><span class="hint">Leave empty to send immediately.</span></div>
            </div>
            <div class="notice err" id="sendErr" hidden></div>
            <div class="form-actions">
              <button type="reset" class="btn btn-ghost">Clear</button>
              <button type="submit" class="btn btn-primary" id="sendBtn"><i data-icon="send"></i>Send campaign</button>
            </div>
          </div>
        </form>
        <div class="grid" style="align-content:start">
          <div class="card">
            <div class="card-head"><h3>Preview</h3><span class="badge plain" id="encBadge">GSM-7</span></div>
            <div class="card-body"><div class="sms-preview"><div class="sender" id="pvSender"></div><div class="bubble" id="pvText">Your message preview will appear here.</div></div></div>
          </div>
          <div class="card">
            <div class="card-head"><h3>Cost estimate</h3></div>
            <div class="card-body" id="estimate"><p class="muted">Add recipients and a message to see the cost.</p></div>
          </div>
        </div>
      </div>`;

    const form = $('#sendForm', root);
    const msg = $('#cMessage', root);
    const sender = $('#cSender', root);
    const selectedGroups = () => $$('input[name=groups]:checked', root).map((i) => i.value);
    const payload = () => ({
      name: $('#cName', root).value,
      senderId: sender.value,
      message: msg.value,
      recipients: $('#cRecipients', root).value,
      groupIds: selectedGroups(),
      scheduleAt: $('#cWhen', root).value ? new Date($('#cWhen', root).value).toISOString() : undefined,
    });

    $$('.tag-btn', root).forEach((b) => b.addEventListener('click', () => {
      const pos = msg.selectionStart ?? msg.value.length;
      msg.value = msg.value.slice(0, pos) + b.dataset.tag + msg.value.slice(msg.selectionEnd ?? pos);
      msg.focus();
      msg.selectionStart = msg.selectionEnd = pos + b.dataset.tag.length;
      update();
    }));

    let debounce;
    async function update() {
      $('#pvSender', root).textContent = sender.value || '';
      $('#pvText', root).textContent = (msg.value || 'Your message preview will appear here.')
        .replace(/\{name\}/gi, 'Amina Wanjiku').replace(/\{first_name\}/gi, 'Amina').replace(/\{phone\}/gi, '+254712345678');
      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        const p = payload();
        try {
          const e = await api('/sms/estimate', { method: 'POST', body: { message: p.message, recipients: p.recipients, groupIds: p.groupIds } });
          $('#encBadge', root).textContent = e.encoding;
          $('#counter', root).innerHTML = `<span><b>${e.length}</b> chars</span><span><b>${e.segments}</b> SMS</span><span><b>${e.remaining}</b> left</span>`;
          const nets = Object.entries(e.byNetwork);
          $('#estimate', root).innerHTML = `
            <div class="summary">
              <div class="line"><span class="muted">Recipients</span><b>${num(e.recipients)}</b></div>
              ${nets.map(([n, v]) => `<div class="line"><span class="muted">${h(n)} · ${num(v.recipients)}</span><span>${kes(v.cost)}</span></div>`).join('')}
              ${e.duplicates ? `<div class="line"><span class="muted">Duplicates removed</span><span>${e.duplicates}</span></div>` : ''}
              ${e.optedOut ? `<div class="line"><span class="muted">Opted out (skipped)</span><span>${e.optedOut}</span></div>` : ''}
              <div class="line total"><span>Total</span><span>${kes(e.cost)}</span></div>
              <div class="line"><span class="muted">Balance after</span><span>${kes(e.balance - e.cost)}</span></div>
            </div>
            ${e.invalid.length ? `<div class="notice warn" style="margin-top:12px">${e.invalid.length} invalid number(s) will be skipped: ${h(e.invalid.slice(0, 5).join(', '))}${e.invalid.length > 5 ? '…' : ''}</div>` : ''}
            ${e.cost > e.balance ? '<div class="notice err" style="margin-top:12px">Insufficient balance. <a href="#/wallet">Top up your wallet</a>.</div>' : ''}`;
        } catch { /* estimate is best-effort */ }
      }, 250);
    }
    form.addEventListener('input', update);
    form.addEventListener('reset', () => setTimeout(update));
    update();

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = $('#sendErr', root);
      err.hidden = true;
      withBusy($('#sendBtn', root), async () => {
        try {
          const c = await api('/sms/send', { method: 'POST', body: payload() });
          toast(c.status === 'scheduled' ? `Scheduled for ${when(c.scheduleAt)}` : `Sending to ${num(c.recipients)} recipients`);
          refreshBalance();
          location.hash = '#/campaigns';
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
        }
      });
    });
  };

  // ----------------------------------------------------------- campaigns

  function progressBar(st, total) {
    const seg = (n, color) => n ? `<span style="width:${(n / total) * 100}%;background:${color}"></span>` : '';
    return `<div class="progress" title="${st.delivered} delivered, ${st.failed} failed, ${st.sent + st.queued + st.scheduled} pending">
      ${seg(st.delivered, 'var(--success)')}${seg(st.failed, 'var(--danger)')}${seg(st.sent, 'var(--brand)')}</div>`;
  }

  function campaignTable(list) {
    if (!list.length) return empty('campaign', 'No campaigns yet. <a href="#/send">Compose one</a>.');
    return `<div class="table-wrap"><table><thead><tr><th>Campaign</th><th>Status</th><th style="min-width:160px">Delivery</th><th class="num">Recipients</th><th class="num">Cost</th><th>Created</th></tr></thead><tbody>
      ${list.map((c) => `<tr class="clickable" data-id="${h(c.id)}">
        <td><b>${h(c.name)}</b><div class="muted truncate">${h(c.message)}</div></td>
        <td>${badge(c.status)}</td>
        <td>${progressBar(c.stats, c.recipients)}<div class="muted" style="font-size:12px;margin-top:4px">${c.stats.delivered} delivered · ${c.stats.failed} failed</div></td>
        <td class="num">${num(c.recipients)}</td>
        <td class="num">${c.billing === 'premium' ? '<span class="badge plain info">premium</span>' : kes(c.cost)}</td>
        <td class="muted">${c.scheduleAt && c.status === 'scheduled' ? `${icon('clock')} ${when(c.scheduleAt)}` : ago(c.createdAt)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  function bindCampaignRows(root) {
    $$('tr[data-id]', root).forEach((tr) => tr.addEventListener('click', () => openCampaign(tr.dataset.id)));
  }

  async function openCampaign(id) {
    const c = await api(`/campaigns/${id}`);
    const m = modal(`
      <div class="card-head"><div><h3>${h(c.name)}</h3><p>${h(c.senderId || '')} · ${when(c.createdAt)}</p></div>
        <button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="card-body grid">
        <div class="kpis" style="margin:0">
          ${kpi('Recipients', num(c.recipients), `${c.invalid} invalid · ${c.duplicates} duplicates`, 'users', 'tone-indigo')}
          ${kpi('Delivered', num(c.stats.delivered), `${c.stats.failed} failed`, 'check', 'tone-green')}
          ${kpi('Pending', num(c.stats.queued + c.stats.sent + c.stats.scheduled), badge(c.status), 'clock', 'tone-amber')}
          ${kpi('Cost', kes(c.cost), c.billing, 'wallet', 'tone-teal')}
        </div>
        <div class="sms-preview" style="min-height:0"><div class="bubble">${h(c.message)}</div></div>
        ${c.status === 'scheduled' ? '<div><button class="btn btn-danger btn-sm" id="cancelCmp">Cancel and refund</button></div>' : ''}
      </div>
      <div class="table-wrap"><table><thead><tr><th>To</th><th>Network</th><th>Status</th><th class="num">SMS</th><th>Detail</th></tr></thead><tbody>
        ${c.messages.map((x) => `<tr><td class="mono">${h(x.to)}</td><td>${h(x.network)}</td><td>${badge(x.status)}</td><td class="num">${x.segments}</td><td class="muted">${h(x.reason || (x.deliveredAt ? when(x.deliveredAt) : ''))}</td></tr>`).join('')}
      </tbody></table></div>`);
    const cancel = $('#cancelCmp', m.el);
    if (cancel) cancel.addEventListener('click', async () => {
      try {
        await api(`/campaigns/${id}/cancel`, { method: 'POST' });
        toast('Campaign cancelled and refunded');
        m.close();
        refreshBalance();
        route();
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  views.campaigns = async (root) => {
    const render = async () => {
      const list = (await api('/campaigns')).filter((c) => !c.system);
      root.innerHTML = `${pageHead('Campaigns', 'Track delivery for every bulk send.', '<a href="#/send" class="btn btn-primary btn-sm"><i data-icon="plus"></i>New campaign</a>')}
        <div class="card">${campaignTable(list)}</div>`;
      hydrate(root);
      bindCampaignRows(root);
    };
    await render();
    poll(render);
  };

  // --------------------------------------------------------------- inbox

  views.inbox = async (root) => {
    const [inbound, optouts, services] = await Promise.all([api('/inbound'), api('/optouts'), api('/services')]);
    const codes = [...new Set(services.map((s) => s.shortcode))];
    root.innerHTML = `
      ${pageHead('Inbox & opt-outs', 'Messages your customers sent to your shortcodes.')}
      <div class="grid-3-2">
        <div class="card">
          <div class="card-head"><h3>Inbound messages</h3><span class="muted">${inbound.length}</span></div>
          ${inbound.length ? `<div class="table-wrap"><table><thead><tr><th>From</th><th>To</th><th>Message</th><th>Action</th><th>Received</th></tr></thead><tbody>
            ${inbound.map((m) => `<tr><td class="mono">${h(m.from)}</td><td class="mono">${h(m.to || '—')}</td><td class="truncate">${h(m.text)}</td>
              <td>${m.action === 'none' ? '<span class="muted">—</span>' : `<span class="badge plain info">${h(m.action.split(':')[0])}</span>`}</td><td class="muted">${ago(m.createdAt)}</td></tr>`).join('')}
            </tbody></table></div>` : empty('inbox', 'No inbound messages yet. Use the simulator to try it out.')}
        </div>
        <div class="grid" style="align-content:start">
          <form class="card" id="moForm">
            <div class="card-head"><div><h3>Inbound simulator</h3><p>Pretend a subscriber texts your shortcode</p></div></div>
            <div class="card-body form">
              <div class="row-2">
                <div class="field"><label for="moFrom">From</label><input id="moFrom" value="0711000222"></div>
                <div class="field"><label for="moTo">Shortcode</label><select id="moTo">${codes.map((c) => `<option>${h(c)}</option>`).join('')}</select></div>
              </div>
              <div class="field"><label for="moText">Message</label><input id="moText" placeholder="Try NEWS, SHAMBA or STOP" value="NEWS"></div>
              <div class="form-actions"><button class="btn btn-primary btn-sm" type="submit">Simulate SMS</button></div>
            </div>
          </form>
          <div class="card">
            <div class="card-head"><h3>Opt-out list</h3><span class="badge plain danger">${optouts.length}</span></div>
            ${optouts.length ? `<div class="table-wrap"><table><tbody>${optouts.map((o) => `<tr><td class="mono">${h(o.phone)}</td><td class="muted">${ago(o.createdAt)}</td></tr>`).join('')}</tbody></table></div>`
              : empty('stop', 'Nobody has opted out.')}
          </div>
        </div>
      </div>`;
    $('#moForm', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/sms/inbound', { method: 'POST', body: { from: $('#moFrom', root).value, to: $('#moTo', root).value, text: $('#moText', root).value } });
        toast(r.action === 'none' ? 'Message received (no keyword matched)' : `Message received → ${r.action}`);
        route();
      } catch (ex) { toast(ex.message, 'err'); }
    });
  };

  // ------------------------------------------------------------ contacts

  views.contacts = async (root) => {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const groupId = params.get('group') || '';
    const [contacts, groups] = await Promise.all([api(`/contacts${groupId ? `?groupId=${encodeURIComponent(groupId)}` : ''}`), api('/groups')]);
    root.innerHTML = `
      ${pageHead('Contacts', 'Your audience, organised into groups.', '<button class="btn btn-primary btn-sm" id="importBtn"><i data-icon="upload"></i>Import contacts</button>')}
      <div class="grid-3-2">
        <div class="card">
          <div class="card-head"><div><h3>${groupId ? h(groups.find((g) => g.id === groupId)?.name || 'Group') : 'All contacts'}</h3><p>${contacts.length} contacts</p></div>
            <input id="search" placeholder="Search…" style="max-width:220px"></div>
          ${contacts.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Phone</th><th>Network</th><th>Groups</th><th></th></tr></thead><tbody id="cRows">
            ${contacts.map((c) => `<tr data-q="${h((c.name + ' ' + c.phone).toLowerCase())}"><td><b>${h(c.name || '—')}</b>${c.optedOut ? ' <span class="badge danger">opted out</span>' : ''}</td><td class="mono">${h(c.phone)}</td><td>${h(c.network)}</td>
              <td>${c.groupIds.map((g) => `<span class="badge plain">${h(groups.find((x) => x.id === g)?.name || g)}</span>`).join(' ')}</td>
              <td class="num"><button class="icon-btn" data-del="${h(c.id)}" aria-label="Delete contact">${icon('trash')}</button></td></tr>`).join('')}
            </tbody></table></div>` : empty('users', 'No contacts here yet.')}
        </div>
        <div class="grid" style="align-content:start">
          <div class="card">
            <div class="card-head"><h3>Groups</h3></div>
            <div class="card-body bar-list">
              <a href="#/contacts" class="row-top" style="color:inherit"><span>${groupId ? '' : '<b>'}All contacts${groupId ? '' : '</b>'}</span><span class="muted">→</span></a>
              ${groups.map((g) => `<div class="row-top"><a href="#/contacts?group=${h(g.id)}" style="color:inherit">${g.id === groupId ? `<b>${h(g.name)}</b>` : h(g.name)} <span class="muted">· ${g.size}</span></a>
                <button class="icon-btn" style="width:30px;height:30px" data-delgroup="${h(g.id)}" aria-label="Delete group">${icon('trash')}</button></div>`).join('')}
            </div>
          </div>
          <form class="card" id="groupForm">
            <div class="card-body form">
              <div class="field"><label for="gName">New group</label><input id="gName" placeholder="e.g. VIP customers" required></div>
              <div class="form-actions"><button class="btn btn-soft btn-sm" type="submit"><i data-icon="plus"></i>Create group</button></div>
            </div>
          </form>
        </div>
      </div>`;

    const search = $('#search', root);
    if (search) search.addEventListener('input', () => {
      const q = search.value.toLowerCase();
      $$('#cRows tr', root).forEach((tr) => { tr.hidden = !tr.dataset.q.includes(q); });
    });
    $$('[data-del]', root).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this contact?')) return;
      await api(`/contacts/${b.dataset.del}`, { method: 'DELETE' });
      toast('Contact deleted');
      route();
    }));
    $$('[data-delgroup]', root).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this group? Contacts are kept.')) return;
      await api(`/groups/${b.dataset.delgroup}`, { method: 'DELETE' });
      toast('Group deleted');
      location.hash = '#/contacts';
      route();
    }));
    $('#groupForm', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/groups', { method: 'POST', body: { name: $('#gName', root).value } });
        toast('Group created');
        route();
      } catch (ex) { toast(ex.message, 'err'); }
    });
    $('#importBtn', root).addEventListener('click', () => {
      const m = modal(`
        <div class="card-head"><div><h3>Import contacts</h3><p>Paste CSV rows: <code>name, phone</code>, or just phone numbers</p></div><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
        <form class="card-body form" id="impForm">
          <div class="field"><label for="impCsv">Contacts</label><textarea id="impCsv" rows="8" placeholder="Jane Doe, 0712345678&#10;John Kamau, +254733456789&#10;0722000111"></textarea>
            <span class="hint">Or choose a .csv file: <input type="file" id="impFile" accept=".csv,text/csv" style="width:auto;border:0;padding:0"></span></div>
          <div class="field"><label for="impGroup">Add to group</label><select id="impGroup"><option value="">None</option>${groups.map((g) => `<option value="${h(g.id)}" ${g.id === groupId ? 'selected' : ''}>${h(g.name)}</option>`).join('')}</select></div>
          <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">Import</button></div>
        </form>`);
      $('#impFile', m.el).addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (f) $('#impCsv', m.el).value = await f.text();
      });
      $('#impForm', m.el).addEventListener('submit', async (e) => {
        e.preventDefault();
        const rows = $('#impCsv', m.el).value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
          .map((l) => l.split(/[,;\t]/).map((x) => x.trim().replace(/^"|"$/g, '')))
          .filter((cols) => !/^(name|phone)$/i.test(cols[0]))
          .map((cols) => cols.length > 1 ? { name: cols[0], phone: cols[1] } : { phone: cols[0] });
        try {
          const r = await api('/contacts', { method: 'POST', body: { contacts: rows, groupId: $('#impGroup', m.el).value || undefined } });
          toast(`${r.created} created, ${r.updated} updated${r.invalid.length ? `, ${r.invalid.length} invalid` : ''}`);
          m.close();
          route();
        } catch (ex) { toast(ex.message, 'err'); }
      });
    });
  };

  // ------------------------------------------------------- subscriptions

  views.subscriptions = async (root) => {
    const services = await api('/services');
    root.innerHTML = `
      ${pageHead('Premium subscriptions', 'Content services billed to subscribers. You earn a revenue share on every delivered message.', '<button class="btn btn-primary btn-sm" id="newSvc"><i data-icon="plus"></i>New service</button>')}
      <div class="product-grid">
        ${services.map((s) => `
          <div class="card">
            <div class="card-body">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
                <div><h3 style="font-size:17px;margin:0">${h(s.name)}</h3><p class="muted" style="margin:2px 0 0;font-size:13.5px">${h(s.description)}</p></div>${badge(s.status)}</div>
              <div class="summary" style="margin:16px 0">
                <div class="line"><span class="muted">Opt-in</span><span>Text <b class="mono">${h(s.keyword)}</b> to <b class="mono">${h(s.shortcode)}</b></span></div>
                <div class="line"><span class="muted">Price per message</span><b>${kes(s.price)}</b></div>
                <div class="line"><span class="muted">Active subscribers</span><b>${num(s.subscribers)}</b></div>
                <div class="line"><span class="muted">Your revenue</span><b style="color:var(--success)">${kes(s.revenue)}</b></div>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button class="btn btn-primary btn-sm" data-broadcast="${h(s.id)}"><i data-icon="campaign"></i>Broadcast</button>
                <button class="btn btn-ghost btn-sm" data-subs="${h(s.id)}"><i data-icon="users"></i>Subscribers</button>
              </div>
            </div>
          </div>`).join('') || `<div class="card">${empty('star', 'No services yet.')}</div>`}
      </div>`;

    $('#newSvc', root).addEventListener('click', () => {
      const m = modal(`
        <div class="card-head"><div><h3>New subscription service</h3><p>Customers opt in by texting the keyword to the shortcode</p></div><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
        <form class="card-body form" id="svcForm">
          <div class="row-2"><div class="field"><label>Name</label><input name="name" required placeholder="Football Scores"></div>
            <div class="field"><label>Price per message (KES)</label><input name="price" type="number" min="0" step="1" value="5" required></div></div>
          <div class="row-2"><div class="field"><label>Keyword</label><input name="keyword" required placeholder="GOAL" style="text-transform:uppercase"></div>
            <div class="field"><label>Shortcode</label><input name="shortcode" required value="22384" inputmode="numeric"></div></div>
          <div class="field"><label>Description</label><input name="description" placeholder="Live scores and match alerts"></div>
          <div class="field"><label>Welcome message</label><textarea name="welcome" rows="2" placeholder="Sent automatically on opt-in"></textarea></div>
          <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">Create service</button></div>
        </form>`);
      $('#svcForm', m.el).addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('/services', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
          toast('Service created');
          m.close();
          route();
        } catch (ex) { toast(ex.message, 'err'); }
      });
    });

    $$('[data-broadcast]', root).forEach((b) => b.addEventListener('click', () => {
      const svc = services.find((s) => s.id === b.dataset.broadcast);
      const m = modal(`
        <div class="card-head"><div><h3>Broadcast · ${h(svc.name)}</h3><p>Sent from ${h(svc.shortcode)} to ${num(svc.subscribers)} active subscriber(s)</p></div><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
        <form class="card-body form" id="bcForm">
          <div class="field"><label>Content</label><textarea name="message" rows="5" required placeholder="Today's update…"></textarea></div>
          <div class="notice info">Premium messages are billed to subscribers at ${kes(svc.price)} each. Your wallet is not charged.</div>
          <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">Send broadcast</button></div>
        </form>`);
      $('#bcForm', m.el).addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const c = await api(`/services/${svc.id}/broadcast`, { method: 'POST', body: { message: e.target.message.value } });
          toast(`Broadcasting to ${c.recipients} subscriber(s)`);
          m.close();
        } catch (ex) { toast(ex.message, 'err'); }
      });
    }));

    $$('[data-subs]', root).forEach((b) => b.addEventListener('click', async () => {
      const svc = services.find((s) => s.id === b.dataset.subs);
      const subs = await api(`/services/${svc.id}/subscribers`);
      const m = modal(`
        <div class="card-head"><div><h3>${h(svc.name)} subscribers</h3><p>${subs.length} total</p></div><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
        <form class="card-body" id="addSub" style="display:flex;gap:8px"><input name="phone" placeholder="Add subscriber, e.g. 0712345678" required><button class="btn btn-primary" type="submit">Add</button></form>
        ${subs.length ? `<div class="table-wrap"><table><thead><tr><th>Phone</th><th>Channel</th><th>Status</th><th>Since</th></tr></thead><tbody>
          ${subs.map((s) => `<tr><td class="mono">${h(s.phone)}</td><td>${h(s.channel)}</td><td>${badge(s.status)}</td><td class="muted">${when(s.subscribedAt)}</td></tr>`).join('')}</tbody></table></div>`
          : empty('users', `No subscribers yet. Text ${h(svc.keyword)} to ${h(svc.shortcode)} from the Inbox simulator.`)}`);
      $('#addSub', m.el).addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api(`/services/${svc.id}/subscribers`, { method: 'POST', body: { phone: e.target.phone.value } });
          toast('Subscriber added');
          m.close();
          route();
        } catch (ex) { toast(ex.message, 'err'); }
      });
    }));
  };

  // ---------------------------------------------------------------- USSD

  function menuTree(node) {
    if (!node.options || !node.options.length) return '';
    return `<ul>${node.options.map((o) => `<li><span class="k">${h(o.key)}</span>${h(o.label)}${o.next?.action ? ' <span class="badge plain info">action</span>' : ''}${menuTree(o.next)}</li>`).join('')}</ul>`;
  }

  views.ussd = async (root) => {
    const [apps, sessions] = await Promise.all([api('/ussd/apps'), api('/ussd/sessions')]);
    let current = apps[0];
    const draw = () => {
      root.innerHTML = `
        ${pageHead('USSD applications', 'Interactive menus that work on every phone, with no data bundle needed.', '<button class="btn btn-primary btn-sm" id="newApp"><i data-icon="plus"></i>New USSD app</button>')}
        ${apps.length > 1 ? `<div class="chips" style="margin-bottom:16px">${apps.map((a) => `<label class="chip"><input type="radio" name="app" value="${h(a.id)}" ${a.id === current?.id ? 'checked' : ''}>${h(a.name)}</label>`).join('')}</div>` : ''}
        ${current ? `
        <div class="grid-3-2">
          <div class="grid" style="align-content:start">
            <div class="card">
              <div class="card-head"><div><h3>${h(current.name)}</h3><p class="mono">${h(current.serviceCode)}</p></div>
                <div style="display:flex;gap:8px;align-items:center">${badge(current.status)}<button class="btn btn-ghost btn-sm" id="editMenu">Edit menu</button></div></div>
              <div class="card-body menu-tree"><b>${h(current.menu.text)}</b>${menuTree(current.menu)}</div>
            </div>
            <div class="card">
              <div class="card-head"><h3>Recent sessions</h3><span class="muted">${sessions.filter((s) => s.appId === current.id).length}</span></div>
              ${sessions.filter((s) => s.appId === current.id).length ? `<div class="table-wrap"><table><thead><tr><th>Phone</th><th>Path</th><th class="num">Hops</th><th>Status</th><th>When</th></tr></thead><tbody>
                ${sessions.filter((s) => s.appId === current.id).slice(0, 15).map((s) => `<tr><td class="mono">${h(s.phone)}</td><td class="mono">${h(s.lastInput || '(root)')}</td><td class="num">${s.hops}</td><td>${badge(s.status)}</td><td class="muted">${ago(s.updatedAt || s.createdAt)}</td></tr>`).join('')}
                </tbody></table></div>` : empty('ussd', 'No sessions yet. Dial the code on the simulator.')}
            </div>
          </div>
          <div class="card">
            <div class="card-head"><div><h3>Simulator</h3><p>Test the live callback</p></div></div>
            <div class="card-body">
              <div class="feature-phone">
                <div class="fp-screen" id="fpScreen"><div class="fp-status"><span>Safaricom</span><span>▮▮▮▯</span></div>Press the green key to dial ${h(current.serviceCode)}</div>
                <div class="fp-input"><input id="fpInput" placeholder="Reply" inputmode="numeric" aria-label="USSD reply"></div>
                <div class="fp-keys">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((k) => `<button type="button" data-key="${k}">${k}</button>`).join('')}
                  <button type="button" class="call" id="fpCall" aria-label="Dial / send">${icon('send')}</button><button type="button" id="fpDel">⌫</button><button type="button" class="end" id="fpEnd" aria-label="End session">${icon('x')}</button></div>
              </div>
            </div>
          </div>
        </div>` : `<div class="card">${empty('ussd', 'No USSD apps yet.')}</div>`}`;
      hydrate(root);
      bind();
    };

    function bind() {
      $$('input[name=app]', root).forEach((r) => r.addEventListener('change', () => { current = apps.find((a) => a.id === r.value); draw(); }));
      $('#newApp', root).addEventListener('click', () => editApp(null));
      if (!current) return;
      $('#editMenu', root).addEventListener('click', () => editApp(current));

      const screen = $('#fpScreen', root);
      const input = $('#fpInput', root);
      let session = null;
      let path = [];
      const status = '<div class="fp-status"><span>Safaricom</span><span>▮▮▮▯</span></div>';
      async function step(text) {
        try {
          const res = await fetch('/api/ussd/callback', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: session, serviceCode: current.serviceCode, phoneNumber: '+254712345678', text }),
          }).then((r) => r.text());
          screen.innerHTML = status + h(res.replace(/^(CON|END) /, ''));
          if (res.startsWith('END')) { session = null; path = []; screen.innerHTML += '\n\n<i>Session ended</i>'; }
        } catch { screen.innerHTML = status + 'Connection problem. Try again.'; }
      }
      $('#fpCall', root).addEventListener('click', () => {
        if (!session) { session = `sim_${Date.now()}`; path = []; input.value = ''; return step(''); }
        if (!input.value) return;
        path.push(input.value.trim());
        input.value = '';
        step(path.join('*'));
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#fpCall', root).click(); });
      $$('[data-key]', root).forEach((b) => b.addEventListener('click', () => { input.value += b.dataset.key; }));
      $('#fpDel', root).addEventListener('click', () => { input.value = input.value.slice(0, -1); });
      $('#fpEnd', root).addEventListener('click', () => { session = null; path = []; screen.innerHTML = `${status}Press the green key to dial ${h(current.serviceCode)}`; });
    }

    function editApp(app) {
      const sample = { text: 'Welcome', options: [{ key: '1', label: 'Option one', next: { text: 'You chose option one.' } }] };
      const m = modal(`
        <div class="card-head"><div><h3>${app ? 'Edit menu' : 'New USSD app'}</h3><p>Each node has <code>text</code> and optional <code>options</code>: [{ key, label, next }]. Leaf nodes end the session.</p></div><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
        <form class="card-body form" id="appForm">
          <div class="row-2"><div class="field"><label>Name</label><input name="name" required value="${h(app?.name || '')}"></div>
            <div class="field"><label>Service code</label><input name="serviceCode" required value="${h(app?.serviceCode || '*384*')}" ${app ? 'disabled' : ''}></div></div>
          <div class="field"><label>Menu (JSON)</label><textarea name="menu" rows="14" class="mono" spellcheck="false">${h(JSON.stringify(app?.menu || sample, null, 2))}</textarea>
            <span class="hint">Use <code>{phone}</code> in text. Add <code>"action": {"type": "subscribe", "serviceId": "svc_…"}</code> on a leaf node to subscribe the caller.</span></div>
          <div class="notice err" id="appErr" hidden></div>
          <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save</button></div>
        </form>`);
      $('#appForm', m.el).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const err = $('#appErr', m.el);
        try {
          const menu = JSON.parse(f.menu.value);
          if (app) await api(`/ussd/apps/${app.id}`, { method: 'PUT', body: { name: f.name.value, menu } });
          else await api('/ussd/apps', { method: 'POST', body: { name: f.name.value, serviceCode: f.serviceCode.value, menu } });
          toast('USSD app saved');
          m.close();
          route();
        } catch (ex) {
          err.textContent = ex instanceof SyntaxError ? `Invalid JSON: ${ex.message}` : ex.message;
          err.hidden = false;
        }
      });
    }

    draw();
  };

  // ------------------------------------------------------------- airtime

  views.airtime = async (root) => {
    const [history, acc] = await Promise.all([api('/airtime'), refreshBalance()]);
    const discount = acc.pricing.airtimeDiscount;
    root.innerHTML = `
      ${pageHead('Airtime', `Send instant top-ups to any network. You pay face value less ${Math.round(discount * 100)}%.`)}
      <div class="grid-3-2">
        <div class="card">
          <div class="card-head"><h3>History</h3></div>
          ${history.length ? `<div class="table-wrap"><table><thead><tr><th>Phone</th><th>Network</th><th class="num">Amount</th><th class="num">Cost</th><th>Status</th><th>When</th></tr></thead><tbody>
            ${history.map((a) => `<tr><td class="mono">${h(a.phone)}</td><td>${h(a.network)}</td><td class="num">${kes(a.amount)}</td><td class="num">${kes(a.cost)}</td><td>${badge(a.status)}</td><td class="muted">${ago(a.createdAt)}</td></tr>`).join('')}
            </tbody></table></div>` : empty('airtime', 'No airtime sent yet.')}
        </div>
        <form class="card" id="airForm">
          <div class="card-head"><div><h3>Send airtime</h3><p>One recipient per line: <code>phone, amount</code></p></div></div>
          <div class="card-body form">
            <div class="field"><label for="airRows">Recipients</label><textarea id="airRows" rows="6" placeholder="0712345678, 100&#10;0733456789, 50"></textarea></div>
            <div class="field"><label for="airDefault">Default amount (KES)</label><input id="airDefault" type="number" min="10" max="10000" value="50">
              <span class="hint">Used for lines without an amount. Between KES 10 and 10,000.</span></div>
            <div class="summary" id="airSum"></div>
            <div class="form-actions"><button class="btn btn-primary" type="submit" id="airBtn"><i data-icon="airtime"></i>Send airtime</button></div>
          </div>
        </form>
      </div>`;

    const parse = () => $('#airRows', root).value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [phone, amount] = l.split(/[,;\s]+/);
      return { phone, amount: Number(amount || $('#airDefault', root).value) };
    });
    const sum = () => {
      const rows = parse();
      const face = rows.reduce((s, r) => s + (r.amount || 0), 0);
      $('#airSum', root).innerHTML = `
        <div class="line"><span class="muted">Recipients</span><b>${rows.length}</b></div>
        <div class="line"><span class="muted">Face value</span><span>${kes(face)}</span></div>
        <div class="line"><span class="muted">Discount (${Math.round(discount * 100)}%)</span><span>− ${kes(face * discount)}</span></div>
        <div class="line total"><span>You pay</span><span>${kes(face * (1 - discount))}</span></div>`;
    };
    $('#airForm', root).addEventListener('input', sum);
    sum();
    $('#airForm', root).addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy($('#airBtn', root), async () => {
        try {
          const r = await api('/airtime/send', { method: 'POST', body: { recipients: parse() } });
          const ok = r.results.filter((x) => x.status === 'success').length;
          toast(`${ok}/${r.results.length} top-ups sent · ${kes(r.total)} charged`);
          refreshBalance();
          route();
        } catch (ex) { toast(ex.message, 'err'); }
      });
    });
  };

  // -------------------------------------------------------------- wallet

  views.wallet = async (root) => {
    const w = await api('/wallet');
    $('#sideBalance').textContent = kes(w.balance);
    root.innerHTML = `
      ${pageHead('Wallet & billing', 'Prepaid balance used by every service.')}
      <div class="grid-3-2">
        <div class="card">
          <div class="card-head"><h3>Transactions</h3></div>
          <div class="table-wrap"><table><thead><tr><th>Description</th><th>Reference</th><th class="num">Amount</th><th class="num">Balance</th><th>Date</th></tr></thead><tbody>
            ${w.transactions.map((t) => `<tr><td>${h(t.description)}</td><td class="mono muted">${h(t.ref || '')}</td>
              <td class="num" style="color:${t.type === 'credit' ? 'var(--success)' : 'var(--text)'};font-weight:600">${t.type === 'credit' ? '+' : '−'} ${kes(t.amount)}</td>
              <td class="num muted">${kes(t.balanceAfter)}</td><td class="muted">${when(t.createdAt)}</td></tr>`).join('')}
          </tbody></table></div>
        </div>
        <div class="grid" style="align-content:start">
          <div class="card" style="background:var(--grad);color:#fff;border:0">
            <div class="card-body">
              <div style="opacity:.85;font-size:13px">Available balance</div>
              <div style="font-size:34px;font-weight:800;letter-spacing:-.03em">${kes(w.balance)}</div>
              <div style="opacity:.85;font-size:13px">≈ ${num(Math.floor(w.balance / 0.8))} Safaricom SMS</div>
            </div>
          </div>
          <form class="card" id="topForm">
            <div class="card-head"><h3>Top up</h3></div>
            <div class="card-body form">
              <div class="chips" id="amounts">${[500, 1000, 5000, 10000].map((a) => `<button type="button" class="chip" data-amt="${a}">${num(a)}</button>`).join('')}</div>
              <div class="field"><label for="tAmount">Amount (KES)</label><input id="tAmount" type="number" min="10" value="1000" required></div>
              <div class="field"><label for="tMethod">Method</label><select id="tMethod"><option value="mpesa">M-Pesa</option><option value="card">Card</option><option value="bank">Bank transfer</option></select></div>
              <div class="field" id="tPhoneField"><label for="tPhone">M-Pesa number</label><input id="tPhone" value="0712345678"><span class="hint">You will get an STK push to approve the payment (simulated here).</span></div>
              <div class="form-actions"><button class="btn btn-primary" type="submit" id="topBtn">Top up wallet</button></div>
            </div>
          </form>
        </div>
      </div>`;
    $$('[data-amt]', root).forEach((b) => b.addEventListener('click', () => { $('#tAmount', root).value = b.dataset.amt; }));
    $('#tMethod', root).addEventListener('change', (e) => { $('#tPhoneField', root).hidden = e.target.value !== 'mpesa'; });
    $('#topForm', root).addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy($('#topBtn', root), async () => {
        try {
          const t = await api('/wallet/topup', { method: 'POST', body: { amount: $('#tAmount', root).value, method: $('#tMethod', root).value, phone: $('#tPhone', root).value } });
          toast(`${kes(t.amount)} added · ref ${t.ref}`);
          route();
        } catch (ex) { toast(ex.message, 'err'); }
      });
    });
  };

  // ---------------------------------------------------------- developers

  views.developers = async (root) => {
    const [senderIds, health] = await Promise.all([api('/sender-ids'), api('/health')]);
    const origin = location.origin;
    root.innerHTML = `
      ${pageHead('Developers', 'Credentials, sender IDs and webhook endpoints.', '<a href="/docs" class="btn btn-ghost btn-sm" target="_blank"><i data-icon="code"></i>API reference</a>')}
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h3>API key</h3><span class="badge success">gateway: ${h(health.provider)}</span></div>
          <div class="card-body form">
            <div style="display:flex;gap:8px"><input id="keyBox" class="mono" readonly value="${h(state.key)}" type="password">
              <button class="icon-btn" id="showKey" aria-label="Show key">${icon('shield')}</button><button class="icon-btn" id="copyKey" aria-label="Copy key">${icon('copy')}</button></div>
            <span class="hint">Send it as the <code>X-API-Key</code> header. Keep it secret.</span>
            <pre class="mono" style="background:var(--bg-soft);padding:14px;border-radius:10px;overflow-x:auto;margin:0">curl ${h(origin)}/api/stats \\
  -H "X-API-Key: $VAS_API_KEY"</pre>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Webhook URLs</h3></div>
          <div class="card-body summary">
            <div class="line"><span class="muted">USSD callback</span><code>${h(origin)}/api/ussd/callback</code></div>
            <div class="line"><span class="muted">Inbound SMS</span><code>${h(origin)}/api/sms/inbound</code></div>
            <div class="line"><span class="muted">Delivery reports</span><code>${h(origin)}/api/callbacks/dlr</code></div>
            <p class="hint" style="margin:8px 0 0">Configure these in your gateway dashboard (e.g. Africa's Talking).</p>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Sender IDs</h3></div>
          <div class="table-wrap"><table><tbody>${senderIds.map((s) => `<tr><td class="mono"><b>${h(s.name)}</b></td><td>${badge(s.status)}</td><td class="muted">${when(s.createdAt)}</td></tr>`).join('')}</tbody></table></div>
          <form class="card-body" id="sidForm" style="display:flex;gap:8px;border-top:1px solid var(--border)">
            <input name="name" placeholder="Request a sender ID (3–11 chars)" maxlength="11" required style="text-transform:uppercase">
            <button class="btn btn-soft" type="submit">Request</button></form>
        </div>
      </div>`;
    $('#showKey', root).addEventListener('click', () => { const b = $('#keyBox', root); b.type = b.type === 'password' ? 'text' : 'password'; });
    $('#copyKey', root).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(state.key); toast('API key copied'); } catch { toast('Copy failed', 'err'); }
    });
    $('#sidForm', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/sender-ids', { method: 'POST', body: { name: e.target.name.value } });
        toast('Sender ID submitted for approval');
        route();
      } catch (ex) { toast(ex.message, 'err'); }
    });
  };

  // ---------------------------------------------------------------- boot

  (async function boot() {
    const saved = store.get('vas-key');
    if (saved && await login(saved)) return;
    $('#auth').hidden = false;
  })();
})();
