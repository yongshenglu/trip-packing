/* 旅行装备清单 — 前端应用逻辑
 * 数据：localStorage 即时存 + 可选 AES-GCM 加密后同步到 secret Gist
 */
'use strict';

const LS_STATE = 'packing.state.v1';
const LS_CFG   = 'packing.cfg.v1';
const ENC_FILE = 'packing.enc';
const CATS = ['证件', '电子', '衣物', '洗漱', '药品', '其他'];

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const nowISO = () => new Date().toISOString();
function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/* ---------------- 数据层 ---------------- */
function mk(name, cat, qty, note) {
  return { id: uid(), name, cat: cat || '其他', qty: qty || 1, note: note || '' };
}

function seedPools() {
  return {
    must: [
      mk('身份证', '证件'), mk('护照/通行证', '证件'), mk('钱包·银行卡', '证件'),
      mk('行程单/车票信息', '证件'), mk('酒店预订信息', '证件'), mk('钥匙', '其他'),
      mk('手机', '电子'), mk('手机充电器', '电子'), mk('数据线', '电子'),
      mk('充电宝', '电子'), mk('耳机', '电子'),
      mk('换洗衣物', '衣物'), mk('内衣裤', '衣物'), mk('袜子', '衣物'),
      mk('外套', '衣物'), mk('睡衣', '衣物'), mk('鞋子', '衣物'),
      mk('牙刷牙膏', '洗漱'), mk('洗面奶', '洗漱'), mk('毛巾', '洗漱'),
      mk('常用药', '药品'), mk('创可贴', '药品'), mk('雨伞', '其他')
    ],
    optional: [
      mk('泳衣', '衣物'), mk('泳镜', '衣物'), mk('拖鞋', '衣物'), mk('遮阳帽', '衣物'), mk('雨衣', '衣物'),
      mk('太阳镜', '其他'), mk('防晒霜', '洗漱'), mk('驱蚊液', '药品'), mk('晕车药', '药品'),
      mk('相机', '电子'), mk('相机电池', '电子'), mk('三脚架', '电子'), mk('自拍杆', '电子'),
      mk('转换插头', '电子'), mk('笔记本电脑', '电子'), mk('电脑充电器', '电子'),
      mk('平板', '电子'), mk('电子书阅读器', '电子'),
      mk('保温杯', '其他'), mk('零食', '其他'), mk('折叠购物袋', '其他'), mk('洗衣袋', '其他'),
      mk('颈枕', '其他'), mk('眼罩耳塞', '其他'), mk('登山杖', '其他'), mk('望远镜', '其他')
    ]
  };
}

function defaultState() {
  return { version: 1, pools: seedPools(), lists: [], templates: [], updatedAt: nowISO() };
}

function normalize(s) {
  s = s || {};
  s.version = 1;
  s.pools = s.pools || {};
  s.pools.must = Array.isArray(s.pools.must) ? s.pools.must : [];
  s.pools.optional = Array.isArray(s.pools.optional) ? s.pools.optional : [];
  s.lists = Array.isArray(s.lists) ? s.lists : [];
  s.templates = Array.isArray(s.templates) ? s.templates : [];
  s.updatedAt = s.updatedAt || nowISO();
  s.lists.forEach(l => {
    l.items = Array.isArray(l.items) ? l.items : [];
    l.items.forEach(i => { i.g = i.g === 'optional' ? 'optional' : 'must'; i.qty = i.qty || 1; });
  });
  s.templates.forEach(t => { t.items = Array.isArray(t.items) ? t.items : []; });
  return s;
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_STATE);
    if (raw) return normalize(JSON.parse(raw));
  } catch (e) { console.warn('读取本地数据失败', e); }
  return defaultState();
}
function loadCfg() {
  try { return JSON.parse(localStorage.getItem(LS_CFG)) || {}; } catch (e) { return {}; }
}
function saveCfg() { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); }
function saveState(silent) {
  state.updatedAt = nowISO();
  try { localStorage.setItem(LS_STATE, JSON.stringify(state)); }
  catch (e) { toast('本地保存失败：' + e.message); }
  if (!silent) scheduleSync();
}

let state = loadState();
let cfg = loadCfg();
let route = { view: 'home', id: null };
const ui = { poolTab: 'must', sheetListId: null, sheetPoolTab: 'must', syncing: false, timer: null, ready: false };

/* ---------------- 工具 ---------------- */
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function openSheet(html) {
  const s = $('#sheet');
  s.innerHTML = `<div class="sheet-backdrop" data-act="close-sheet"></div><div class="sheet-body">${html}</div>`;
  s.classList.remove('hidden');
  requestAnimationFrame(() => s.classList.add('open'));
}
function closeSheet() {
  const s = $('#sheet');
  s.classList.remove('open');
  setTimeout(() => { s.classList.add('hidden'); s.innerHTML = ''; }, 170);
}

function askText(title, value, placeholder) {
  return new Promise(resolve => {
    openSheet(
      `<h3>${esc(title)}</h3>
       <form id="askForm" autocomplete="off">
         <input name="v" value="${esc(value || '')}" placeholder="${esc(placeholder || '')}" enterkeyhint="done">
         <div class="sheet-actions">
           <button type="button" class="btn" data-act="close-sheet">取消</button>
           <button class="btn primary">确定</button>
         </div>
       </form>`
    );
    const f = $('#askForm');
    f.addEventListener('submit', e => { e.preventDefault(); const v = f.v.value.trim(); closeSheet(); resolve(v); });
    setTimeout(() => f.v.focus(), 180);
  });
}

/* ---------------- 渲染 ---------------- */
function render() {
  const app = $('#app');
  if (route.view === 'list') {
    app.innerHTML = viewList(route.id);
    document.body.dataset.view = 'list';
  } else {
    app.innerHTML = viewTab() + navBar();
    document.body.dataset.view = 'tab';
  }
  window.scrollTo(0, 0);
}

function navBar() {
  const tabs = [['home', '清单', '🧳'], ['pools', '物品池', '📦'], ['templates', '模板', '🗂'], ['settings', '设置', '⚙️']];
  return `<nav class="nav">${tabs.map(([v, label, ic]) =>
    `<button class="${route.view === v ? 'on' : ''}" data-act="tab" data-view="${v}"><span class="ic">${ic}</span>${label}</button>`
  ).join('')}</nav>`;
}

function viewTab() {
  if (route.view === 'pools') return viewPools();
  if (route.view === 'templates') return viewTemplates();
  if (route.view === 'settings') return viewSettings();
  return viewHome();
}

/* 首页 */
function viewHome() {
  const lists = state.lists.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const tplChips = state.templates.length
    ? `<div class="quick">${state.templates.map(t =>
        `<button class="chip" data-act="from-template" data-id="${t.id}">＋ ${esc(t.title)}</button>`).join('')}</div>`
    : '';
  const body = lists.length
    ? lists.map(listCard).join('')
    : `<div class="empty"><div class="big">🧳</div><p>还没有清单</p><p class="sub">点右上角「新建清单」，从物品池勾选要带的东西</p></div>`;
  return `<header class="top"><h1>旅行装备</h1>
      <button class="btn primary" data-act="new-list">＋ 新建</button>
    </header>
    <div class="wrap">${tplChips}${body}</div>`;
}

function listCard(l) {
  const total = l.items.length;
  const done = l.items.filter(i => i.checked).length;
  const pct = total ? Math.round(done / total * 100) : 0;
  return `<button class="card list-card" data-act="open-list" data-id="${l.id}">
      <div class="row-top">
        <div style="min-width:0">
          <div class="title">${esc(l.title)}</div>
          <div class="sub">${esc(l.date || '未设日期')} · ${done}/${total} 已装</div>
        </div>
        <div class="pct">${pct}%</div>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </button>`;
}

/* 清单详情 */
function listRow(l, it) {
  return `<div class="row ${it.checked ? 'done' : ''}">
      <button class="check ${it.checked ? 'on' : ''}" data-act="toggle" data-id="${l.id}" data-iid="${it.id}">${it.checked ? '✓' : ''}</button>
      <div class="grow" data-act="edit-item" data-id="${l.id}" data-iid="${it.id}">
        <div class="name">${esc(it.name)}</div>
        ${it.note ? `<div class="sub">${esc(it.note)}</div>` : ''}
      </div>
      <div class="stepper">
        <button data-act="qty" data-id="${l.id}" data-iid="${it.id}" data-d="-1">−</button>
        <span>${it.qty}</span>
        <button data-act="qty" data-id="${l.id}" data-iid="${it.id}" data-d="1">+</button>
      </div>
      <button class="del" data-act="del-item" data-id="${l.id}" data-iid="${it.id}">×</button>
    </div>`;
}

function viewList(id) {
  const l = state.lists.find(x => x.id === id);
  if (!l) { route = { view: 'home' }; return viewHome() + navBar(); }
  const total = l.items.length;
  const done = l.items.filter(i => i.checked).length;
  const pct = total ? Math.round(done / total * 100) : 0;

  const group = (key, label) => {
    const items = l.items.filter(i => i.g === key);
    if (!items.length) return '';
    return `<section class="group">
        <h2>${label}<span class="count">${items.filter(i => i.checked).length}/${items.length}</span></h2>
        ${items.map(it => listRow(l, it)).join('')}
      </section>`;
  };

  return `<header class="top">
      <button class="icon-btn" data-act="home">‹</button>
      <h1 data-act="rename-list" data-id="${l.id}">${esc(l.title)}</h1>
      <button class="icon-btn" data-act="list-menu" data-id="${l.id}">⋯</button>
    </header>
    <div class="wrap">
      <div class="card progress-card">
        <div class="row-top"><b>${done} / ${total}</b><span class="sub">${pct}% 已装</span></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div>
      <div class="actions">
        <button class="btn" data-act="add-from-pool" data-id="${l.id}">📦 从池添加</button>
        <button class="btn" data-act="add-manual" data-id="${l.id}">✏️ 手动添加</button>
        <button class="btn" data-act="save-template" data-id="${l.id}">⭐ 存为模板</button>
      </div>
      ${total ? group('must', '必带物品') + group('optional', '非必带物品')
        : `<div class="empty"><div class="big">📝</div><p>清单还是空的</p><p class="sub">点「从池添加」勾选，或手动添加</p></div>`}
    </div>`;
}

/* 物品池 */
function poolRow(it) {
  return `<div class="prow">
      <div class="grow" data-act="edit-pool" data-id="${it.id}">
        <div class="name">${esc(it.name)}</div>
        ${it.note ? `<div class="sub">${esc(it.note)}</div>` : ''}
      </div>
      <span class="tag">${esc(it.cat)}</span>
      <button class="del" data-act="del-pool" data-id="${it.id}">×</button>
    </div>`;
}

function viewPools() {
  const tab = ui.poolTab;
  const items = state.pools[tab];
  return `<header class="top"><h1>物品池</h1></header>
    <div class="seg">
      <button class="${tab === 'must' ? 'on' : ''}" data-act="pool-tab" data-tab="must">必带池 ${state.pools.must.length}</button>
      <button class="${tab === 'optional' ? 'on' : ''}" data-act="pool-tab" data-tab="optional">非必带池 ${state.pools.optional.length}</button>
    </div>
    <div class="wrap">
      <div class="addrow">
        <input id="newPoolName" placeholder="添加物品…" enterkeyhint="done" autocomplete="off">
        <select id="newPoolCat">${CATS.map(c => `<option>${c}</option>`).join('')}</select>
        <button class="btn primary" data-act="add-pool">添加</button>
      </div>
      ${items.length ? items.map(poolRow).join('') : `<div class="empty"><p>这个池还是空的</p><p class="sub">在上面输入物品名称添加</p></div>`}
    </div>`;
}

/* 模板 */
function viewTemplates() {
  const list = state.templates;
  const body = list.length
    ? list.map(t => `<div class="card tpl-card">
        <div class="title">${esc(t.title)}</div>
        <div class="sub">${t.items.length} 件物品${t.createdAt ? ' · ' + fmtDay(t.createdAt) : ''}</div>
        <div class="acts">
          <button class="btn primary" data-act="from-template" data-id="${t.id}">用它建清单</button>
          <button class="btn" data-act="tpl-rename" data-id="${t.id}">重命名</button>
          <button class="btn danger" data-act="tpl-del" data-id="${t.id}">删除</button>
        </div>
      </div>`).join('')
    : `<div class="empty"><div class="big">🗂</div><p>还没有模板</p><p class="sub">在某个清单里点「存为模板」，就能反复复用</p></div>`;
  return `<header class="top"><h1>模板</h1></header><div class="wrap">${body}</div>`;
}

/* 设置 */
function viewSettings() {
  const linked = !!cfg.gistId;
  return `<header class="top"><h1>设置</h1></header>
  <div class="wrap">
    <section class="sec">
      <h3>多端同步 <span class="pill">${linked ? '已连接' : '未连接'}</span></h3>
      <p class="desc">数据在本机用你的口令加密（PBKDF2 + AES-GCM），再存进你自己的 GitHub secret Gist。网页代码公开，但里面没有任何数据；Gist 未列出、只有你的账号能读到密文。</p>
      <div class="field"><label>同步口令（一定记住，丢了无法恢复）</label>
        <input id="cfgPass" type="password" value="${esc(cfg.pass || '')}" placeholder="自己定一个长口令" autocomplete="off">
      </div>
      <div class="field"><label>GitHub Token（fine-grained，仅 gist 权限）</label>
        <input id="cfgToken" type="password" value="${esc(cfg.token || '')}" placeholder="github_pat_…" autocomplete="off">
      </div>
      <div class="field"><label>Gist ID（首次上传后自动填入）</label>
        <input id="cfgGist" value="${esc(cfg.gistId || '')}" placeholder="例如 9a8b7c6d…" autocomplete="off">
      </div>
      <div class="field inline">
        <label for="cfgAuto">改动后自动上传</label>
        <input id="cfgAuto" type="checkbox" ${cfg.auto !== false ? 'checked' : ''} style="width:20px;height:20px;accent-color:var(--accent)">
      </div>
      <div class="row-btns">
        <button class="btn primary" data-act="sync-push">立即上传</button>
        <button class="btn" data-act="sync-pull">从云端下载</button>
      </div>
      <div class="row-btns">${linked ? `<button class="btn ghost" data-act="sync-unlink">断开云端</button>` : ''}</div>
      <div class="status" id="syncStatus"></div>
    </section>

    <section class="sec">
      <h3>备份文件</h3>
      <p class="desc">导出一份加密文件存到微信/网盘，换手机或口令丢失前多一层保险。</p>
      <div class="row-btns">
        <button class="btn" data-act="export">导出加密文件</button>
        <button class="btn" data-act="import">导入文件</button>
      </div>
      <input type="file" id="importFile" accept=".enc,.json,.txt" class="hidden">
    </section>

    <section class="sec">
      <h3>数据</h3>
      <p class="desc">当前 ${state.lists.length} 个清单 · ${state.pools.must.length + state.pools.optional.length} 个池物品 · ${state.templates.length} 个模板</p>
      <div class="row-btns">
        <button class="btn danger" data-act="reset">清空本机数据</button>
      </div>
    </section>
    <p class="sub" style="text-align:center;margin:18px 0 6px">旅行装备清单 · v1</p>
  </div>`;
}

/* ---------------- 加密与同步 ---------------- */
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = buf => btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function deriveKey(pass, salt) {
  if (!window.crypto || !crypto.subtle) throw new Error('当前环境不支持加密，请用 https 或 localhost 打开');
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 300000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function encryptState(obj, pass, salt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct), ts: obj.updatedAt || nowISO() };
}

async function decryptPayload(p, pass) {
  if (!p || !p.ct) throw new Error('密文格式不对');
  try {
    const key = await deriveKey(pass, unb64(p.salt));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(p.iv) }, key, unb64(p.ct));
    return JSON.parse(dec.decode(pt));
  } catch (e) {
    throw new Error('解密失败：同步口令不对，或云端数据已损坏');
  }
}

async function gh(path, opts = {}) {
  if (!cfg.token) throw new Error('还没填 GitHub Token');
  const res = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + cfg.token,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const txt = (await res.text()).slice(0, 200);
    throw new Error(`GitHub ${res.status}：${txt}`);
  }
  return res.status === 204 ? null : res.json();
}

function setStatus(msg, kind) {
  const el = $('#syncStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function scheduleSync() {
  if (!ui.ready || !cfg.auto || !cfg.gistId || !cfg.pass || !cfg.token) return;
  clearTimeout(ui.timer);
  ui.timer = setTimeout(() => { pushCloud().catch(err => console.warn('自动上传失败', err)); }, 2500);
}

async function pushCloud() {
  if (ui.syncing) return;
  if (!cfg.pass) throw new Error('请先设置同步口令');
  ui.syncing = true;
  try {
    const salt = cfg.salt ? unb64(cfg.salt) : crypto.getRandomValues(new Uint8Array(16));
    const payload = await encryptState(state, cfg.pass, salt);
    const content = JSON.stringify(payload);
    if (cfg.gistId) {
      await gh('/gists/' + cfg.gistId, { method: 'PATCH', body: JSON.stringify({ files: { [ENC_FILE]: { content } } }) });
    } else {
      const g = await gh('/gists', {
        method: 'POST',
        body: JSON.stringify({
          description: '旅行装备清单（加密数据，勿公开）',
          public: false,
          files: { [ENC_FILE]: { content } }
        })
      });
      cfg.gistId = g.id;
    }
    cfg.salt = b64(salt);
    saveCfg();
    setStatus('已上传 · ' + new Date().toLocaleTimeString(), 'ok');
  } finally {
    ui.syncing = false;
  }
}

async function pullCloud(raw) {
  if (!cfg.gistId) throw new Error('还没有云端数据，先点「立即上传」');
  if (!cfg.pass) throw new Error('请先填写同步口令');
  let payload = raw;
  if (!payload) {
    const g = await gh('/gists/' + cfg.gistId);
    const f = g.files && g.files[ENC_FILE];
    if (!f) throw new Error('云端 Gist 里找不到 ' + ENC_FILE);
    let text = f.content;
    if (f.truncated && f.raw_url) text = await (await fetch(f.raw_url)).text();
    payload = JSON.parse(text);
  }
  return decryptPayload(payload, cfg.pass);
}

function applyRemote(remote) {
  state = normalize(remote);
  localStorage.setItem(LS_STATE, JSON.stringify(state));
  render();
}

/* ---------------- 事件 ---------------- */
async function handleAction(act, el) {
  const id = el.dataset.id, iid = el.dataset.iid;
  const curList = () => state.lists.find(x => x.id === (id || route.id));

  switch (act) {
    case 'tab':
      route = { view: el.dataset.view, id: null };
      render();
      break;

    case 'home':
      route = { view: 'home', id: null };
      render();
      break;

    case 'open-list': {
      const l = state.lists.find(x => x.id === id);
      if (!l) return;
      route = { view: 'list', id };
      render();
      break;
    }

    case 'new-list': {
      const name = await askText('新建清单', '新的旅行', '比如：日本关西 5 天');
      if (!name) return;
      const l = { id: uid(), title: name, date: '', createdAt: nowISO(), items: [] };
      state.lists.push(l);
      saveState();
      route = { view: 'list', id: l.id };
      render();
      break;
    }

    case 'rename-list': {
      const l = curList();
      if (!l) return;
      const v = await askText('清单名称', l.title);
      if (!v) return;
      l.title = v; saveState(); render();
      break;
    }

    case 'list-menu': {
      const l = curList();
      if (!l) return;
      openSheet(`<h3>${esc(l.title)}</h3>
        <div class="menu">
          <button data-act="set-date" data-id="${l.id}">📅 设置出行日期${l.date ? '（' + esc(l.date) + '）' : ''}</button>
          <button data-act="select-all" data-id="${l.id}">✅ 全部标记为已装</button>
          <button data-act="unselect-all" data-id="${l.id}">↩️ 全部取消勾选</button>
          <button data-act="save-template" data-id="${l.id}">⭐ 存为模板</button>
          <button class="danger" data-act="del-list" data-id="${l.id}">🗑 删除这个清单</button>
        </div>
        <div class="sheet-actions"><button class="btn" data-act="close-sheet">关闭</button></div>`);
      break;
    }

    case 'set-date': {
      const l = state.lists.find(x => x.id === id);
      if (!l) return;
      closeSheet();
      const v = await askText('出行日期', l.date, '如 2026-10-01 或 10月1日');
      if (v === undefined) return;
      l.date = v; saveState(); render();
      break;
    }

    case 'select-all':
    case 'unselect-all': {
      const l = state.lists.find(x => x.id === id);
      if (!l) return;
      const on = act === 'select-all';
      l.items.forEach(i => { i.checked = on; });
      saveState(); closeSheet(); render();
      break;
    }

    case 'del-list': {
      const l = state.lists.find(x => x.id === id);
      if (!l) return;
      if (!confirm(`删除「${l.title}」？此操作不可撤销。`)) return;
      state.lists = state.lists.filter(x => x.id !== id);
      saveState(); closeSheet(); route = { view: 'home', id: null }; render();
      break;
    }

    case 'toggle': {
      const l = state.lists.find(x => x.id === id);
      const it = l && l.items.find(i => i.id === iid);
      if (!it) return;
      it.checked = !it.checked;
      saveState();
      render();
      if (it.checked && l.items.every(i => i.checked)) toast('全部装好，出发 🎒');
      break;
    }

    case 'qty': {
      const l = state.lists.find(x => x.id === id);
      const it = l && l.items.find(i => i.id === iid);
      if (!it) return;
      it.qty = Math.max(1, (it.qty || 1) + Number(el.dataset.d || 1));
      saveState(); render();
      break;
    }

    case 'del-item': {
      const l = state.lists.find(x => x.id === id);
      if (!l) return;
      l.items = l.items.filter(i => i.id !== iid);
      saveState(); render();
      break;
    }

    case 'edit-item': {
      const l = state.lists.find(x => x.id === id);
      const it = l && l.items.find(i => i.id === iid);
      if (!it) return;
      openSheet(`<h3>${esc(it.name)}</h3>
        <form id="editItemForm">
          <input name="name" value="${esc(it.name)}" placeholder="物品名称">
          <input name="note" value="${esc(it.note || '')}" placeholder="备注（可选）">
          <div class="sheet-actions">
            <button type="button" class="btn" data-act="close-sheet">取消</button>
            <button class="btn primary">保存</button>
          </div>
        </form>`);
      const f = $('#editItemForm');
      f.addEventListener('submit', e => {
        e.preventDefault();
        const n = f.name.value.trim();
        if (!n) return;
        it.name = n; it.note = f.note.value.trim();
        saveState(); closeSheet(); render();
      });
      break;
    }

    case 'add-manual': {
      const l = curList();
      if (!l) return;
      openSheet(`<h3>手动添加物品</h3>
        <form id="manualForm">
          <input name="name" placeholder="物品名称" autocomplete="off">
          <select name="g" style="width:100%;padding:12px;border-radius:11px;border:1px solid var(--line);background:var(--bg);margin-bottom:10px">
            <option value="must">必带</option><option value="optional">非必带</option>
          </select>
          <input name="note" placeholder="备注（可选）">
          <div class="sheet-actions">
            <button type="button" class="btn" data-act="close-sheet">取消</button>
            <button class="btn primary">添加</button>
          </div>
        </form>`);
      const f = $('#manualForm');
      f.addEventListener('submit', e => {
        e.preventDefault();
        const n = f.name.value.trim();
        if (!n) return;
        l.items.push({ id: uid(), name: n, cat: '其他', qty: 1, checked: false, g: f.g.value, note: f.note.value.trim() });
        saveState(); closeSheet(); render();
      });
      setTimeout(() => f.name.focus(), 180);
      break;
    }

    case 'add-from-pool': {
      const l = curList();
      if (!l) return;
      ui.sheetListId = l.id;
      ui.sheetPoolTab = 'must';
      renderPoolSheet();
      break;
    }

    case 'sheet-pool-tab': {
      ui.sheetPoolTab = el.dataset.tab;
      renderPoolSheet();
      break;
    }

    case 'sheet-do-add': {
      const l = state.lists.find(x => x.id === ui.sheetListId);
      if (!l) return;
      const tab = ui.sheetPoolTab;
      const picked = $$('#sheet input[type=checkbox]:checked:not(:disabled)').map(c => c.value);
      if (!picked.length) { toast('还没有勾选物品'); return; }
      picked.forEach(pid => {
        const p = state.pools[tab].find(x => x.id === pid);
        if (!p) return;
        l.items.push({ id: uid(), name: p.name, cat: p.cat, qty: p.qty || 1, note: p.note || '', checked: false, g: tab });
      });
      saveState(); closeSheet(); render();
      toast(`已添加 ${picked.length} 件`);
      break;
    }

    case 'save-template': {
      const l = curList() || state.lists.find(x => x.id === id);
      if (!l) { closeSheet(); return; }
      if (!l.items.length) { toast('清单是空的，先加物品'); return; }
      const name = await askText('模板名称', l.title, '比如：海边度假 / 高原徒步');
      if (!name) return;
      state.templates.push({
        id: uid(), title: name, createdAt: nowISO(),
        items: l.items.map(i => ({ name: i.name, cat: i.cat || '其他', qty: i.qty || 1, note: i.note || '', g: i.g || 'must' }))
      });
      saveState(); closeSheet();
      toast('已存为模板');
      break;
    }

    case 'from-template': {
      const t = state.templates.find(x => x.id === id);
      if (!t) return;
      const name = await askText('新清单名称', t.title, '比如：2026 春节 大理');
      if (!name) return;
      const l = {
        id: uid(), title: name, date: '', createdAt: nowISO(),
        items: t.items.map(i => ({ id: uid(), name: i.name, cat: i.cat || '其他', qty: i.qty || 1, note: i.note || '', checked: false, g: i.g || 'must' }))
      };
      state.lists.push(l);
      saveState();
      route = { view: 'list', id: l.id };
      render();
      break;
    }

    case 'tpl-rename': {
      const t = state.templates.find(x => x.id === id);
      if (!t) return;
      const v = await askText('模板名称', t.title);
      if (!v) return;
      t.title = v; saveState(); render();
      break;
    }

    case 'tpl-del': {
      const t = state.templates.find(x => x.id === id);
      if (!t) return;
      if (!confirm(`删除模板「${t.title}」？`)) return;
      state.templates = state.templates.filter(x => x.id !== id);
      saveState(); render();
      break;
    }

    case 'pool-tab':
      ui.poolTab = el.dataset.tab;
      render();
      break;

    case 'add-pool': {
      const input = $('#newPoolName');
      const cat = $('#newPoolCat');
      if (!input) return;
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      const pool = state.pools[ui.poolTab];
      if (pool.some(x => x.name === name)) { toast('池里已经有这个物品了'); return; }
      pool.push(mk(name, cat ? cat.value : '其他'));
      saveState();
      render();
      const again = $('#newPoolName');
      if (again) again.focus();
      break;
    }

    case 'del-pool': {
      const pool = state.pools[ui.poolTab];
      const it = pool.find(x => x.id === id);
      if (!it) return;
      pool.splice(pool.indexOf(it), 1);
      saveState(); render();
      toast('已从池中删除（历史清单不受影响）');
      break;
    }

    case 'edit-pool': {
      const pool = state.pools[ui.poolTab];
      const it = pool.find(x => x.id === id);
      if (!it) return;
      openSheet(`<h3>编辑物品</h3>
        <form id="editPoolForm">
          <input name="name" value="${esc(it.name)}" placeholder="名称">
          <input name="note" value="${esc(it.note || '')}" placeholder="备注（可选）">
          <select name="cat" style="width:100%;padding:12px;border-radius:11px;border:1px solid var(--line);background:var(--bg);margin-bottom:10px">
            ${CATS.map(c => `<option ${c === it.cat ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
          <div class="sheet-actions">
            <button type="button" class="btn" data-act="close-sheet">取消</button>
            <button class="btn primary">保存</button>
          </div>
        </form>`);
      const f = $('#editPoolForm');
      f.addEventListener('submit', e => {
        e.preventDefault();
        const n = f.name.value.trim();
        if (!n) return;
        it.name = n; it.note = f.note.value.trim(); it.cat = f.cat.value;
        saveState(); closeSheet(); render();
      });
      break;
    }

    case 'sync-push': {
      cfg.pass = ($('#cfgPass') || {}).value || '';
      cfg.token = ($('#cfgToken') || {}).value || '';
      const gid = ($('#cfgGist') || {}).value || '';
      cfg.gistId = gid || cfg.gistId;
      cfg.auto = ($('#cfgAuto') || {}).checked !== false;
      saveCfg();
      setStatus('加密并上传中…');
      try {
        await pushCloud();
        render();
        setStatus('已上传 · ' + new Date().toLocaleTimeString() + '（Gist ID 已保存）', 'ok');
      } catch (e) { setStatus(e.message, 'err'); }
      break;
    }

    case 'sync-pull': {
      cfg.pass = ($('#cfgPass') || {}).value || cfg.pass;
      cfg.token = ($('#cfgToken') || {}).value || cfg.token;
      cfg.gistId = ($('#cfgGist') || {}).value || cfg.gistId;
      saveCfg();
      setStatus('从云端下载中…');
      try {
        const remote = await pullCloud();
        if (!confirm('用云端数据覆盖本机？（本机未上传的改动会丢失，建议先「立即上传」）')) { setStatus('已取消'); return; }
        applyRemote(remote);
        setStatus('已从云端恢复 · ' + new Date().toLocaleTimeString(), 'ok');
        toast('已同步云端的 ' + state.lists.length + ' 个清单');
      } catch (e) { setStatus(e.message, 'err'); }
      break;
    }

    case 'sync-unlink': {
      if (!confirm('断开云端连接？本机数据保留，不再自动上传。')) return;
      delete cfg.gistId; delete cfg.salt;
      saveCfg(); render(); toast('已断开云端');
      break;
    }

    case 'export': {
      if (!cfg.pass) { toast('先在设置里填同步口令（用于加密导出）'); return; }
      try {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const payload = await encryptState(state, cfg.pass, salt);
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `旅行装备-${new Date().toISOString().slice(0, 10)}.enc`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        toast('已导出加密文件');
      } catch (e) { toast('导出失败：' + e.message); }
      break;
    }

    case 'import': {
      const inp = $('#importFile');
      if (!inp) return;
      inp.onchange = async () => {
        const file = inp.files && inp.files[0];
        if (!file) return;
        if (!cfg.pass) { toast('先填同步口令'); return; }
        try {
          const payload = JSON.parse(await file.text());
          const data = await decryptPayload(payload, cfg.pass);
          if (!confirm('用文件内容覆盖本机数据？')) return;
          applyRemote(data);
          toast('导入成功');
        } catch (e) { toast('导入失败：口令不对或文件损坏'); }
      };
      inp.click();
      break;
    }

    case 'reset': {
      if (!confirm('清空本机所有清单、池和模板？（云端数据不受影响，可再下载）')) return;
      localStorage.removeItem(LS_STATE);
      state = defaultState();
      saveState(true);
      render();
      toast('已重置为初始物品池');
      break;
    }

    case 'close-sheet':
      closeSheet();
      break;
  }
}

function renderPoolSheet() {
  const tab = ui.sheetPoolTab;
  const l = state.lists.find(x => x.id === ui.sheetListId);
  if (!l) { closeSheet(); return; }
  const exists = new Set(l.items.map(i => i.name));
  const items = state.pools[tab];
  const rows = items.length
    ? items.map(p => `<label class="sel ${exists.has(p.name) ? 'has' : ''}">
        <input type="checkbox" value="${p.id}" ${exists.has(p.name) ? 'disabled' : ''}>
        <span class="grow">${esc(p.name)}</span>
        ${exists.has(p.name) ? '<span class="tag gray">已在清单</span>' : `<span class="tag">${esc(p.cat)}</span>`}
      </label>`).join('')
    : `<p class="sub" style="padding:14px 2px">这个池还是空的，去「物品池」添加</p>`;

  openSheet(`<h3>从池添加</h3>
    <div class="seg small">
      <button class="${tab === 'must' ? 'on' : ''}" data-act="sheet-pool-tab" data-tab="must">必带池</button>
      <button class="${tab === 'optional' ? 'on' : ''}" data-act="sheet-pool-tab" data-tab="optional">非必带池</button>
    </div>
    <div class="sel-list">${rows}</div>
    <div class="sheet-actions">
      <button class="btn" data-act="close-sheet">取消</button>
      <button class="btn primary" data-act="sheet-do-add">添加所选</button>
    </div>`);
}

/* ---------------- 启动 ---------------- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'close-sheet') { e.preventDefault(); }
  handleAction(act, el).catch(err => {
    console.error(err);
    toast(err.message || '出错了');
  });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSheet();
  if (e.key === 'Enter' && e.target && e.target.id === 'newPoolName') {
    const btn = $('[data-act="add-pool"]');
    if (btn) btn.click();
  }
});

(async function boot() {
  render();
  ui.ready = true;

  // 首次带凭证打开：自动拉取云端较新数据（本机从未存过数据时直接采用云端）
  const fresh = localStorage.getItem(LS_STATE) === null;
  if (cfg.gistId && cfg.pass && cfg.token) {
    try {
      const remote = await pullCloud();
      if (remote && (fresh || (remote.updatedAt && remote.updatedAt > state.updatedAt))) {
        applyRemote(remote);
        toast(fresh ? '已从云端恢复数据' : '已同步云端最新数据');
      }
    } catch (e) { console.warn('自动同步失败', e); }
  }
})();
