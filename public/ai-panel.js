'use strict';
/**
 * Reference AI panel controller (from Snake Arcade).
 * Host app may copy to public/ai-panel.js and adapt gameContext() / executeActions().
 * Depends on: UniversalAI, UniversalFeedback, markup in example/ui/ai-panel.html, styles in ai-panel.css.
 */

const PANEL_COPY = {
  en: {title:'AI Assistant',close:'Close',chat:'Chat',feedback:'Feedback',settings:'Settings',logs:'Logs',chatPlaceholder:'Ask about Feedback Hub…',send:'Send',localOn:'Offline guide available · configure a provider in Settings',aiUnavailable:'AI unavailable',aiReady:'AI ready · ',localGuide:'Offline guide',type:'Type',improvement:'Improvement',bug:'Bug',question:'Question',rating:'Rating',message:'Message',feedbackPlaceholder:'Share your feedback…',feedbackHint:'Only send what you enter. Never include passwords or API keys.',sendFeedback:'Send feedback',sending:'Sending…',thanks:'Thank you for your feedback!',enterMessage:'Please enter a message.',provider:'Provider',none:'— None —',apiKey:'API key',keyHint:'Current key: (not configured)',keyPlaceholder:'API key (hidden after saving)',baseUrl:'Base URL (required for Custom / Local)',model:'Model',mode:'Mode',cloud:'Cloud enabled',preferLocal:'Prefer local',localOnly:'Local only',balanced:'Balanced',custom:'Custom',save:'Save settings',check:'Check token',loadModels:'Load models',refreshing:'Refreshing models…',saved:'Saved ✓',saving:'Saving…',checkingToken:'Checking token…',modelsUpdated:'Models updated',noLogs:'(no logs)',refresh:'Refresh',clear:'Clear',notice:'Notice',markRead:'Mark read',donate:'Support the project',noReply:'No response',syncError:'Feedback Hub is unavailable: ',submitError:'Could not send feedback: ',adminRequired:'Sign in at /admin to manage AI settings and logs.'},
  vi: {title:'Trợ lý AI',close:'Đóng',chat:'Trò chuyện',feedback:'Phản hồi',settings:'Cài đặt',logs:'Nhật ký',chatPlaceholder:'Hỏi về Feedback Hub…',send:'Gửi',localOn:'Có hướng dẫn ngoại tuyến · cấu hình nhà cung cấp trong Cài đặt',aiUnavailable:'AI hiện không khả dụng',aiReady:'AI sẵn sàng · ',localGuide:'Hướng dẫn ngoại tuyến',type:'Loại',improvement:'Đề xuất cải thiện',bug:'Lỗi',question:'Câu hỏi',rating:'Đánh giá',message:'Nội dung',feedbackPlaceholder:'Chia sẻ phản hồi của bạn…',feedbackHint:'Chỉ gửi nội dung bạn nhập. Không gửi mật khẩu hoặc API key.',sendFeedback:'Gửi phản hồi',sending:'Đang gửi…',thanks:'Cảm ơn bạn đã gửi phản hồi!',enterMessage:'Vui lòng nhập nội dung.',provider:'Nhà cung cấp',none:'— Chưa chọn —',apiKey:'API key',keyHint:'API key hiện tại: (chưa cấu hình)',keyPlaceholder:'API key (được che sau khi lưu)',baseUrl:'Base URL (bắt buộc với Custom / Local)',model:'Mô hình',mode:'Chế độ',cloud:'Dùng AI đám mây',preferLocal:'Ưu tiên AI cục bộ',localOnly:'Chỉ AI cục bộ',balanced:'Cân bằng',custom:'Tùy chỉnh',save:'Lưu cài đặt',check:'Kiểm tra token',loadModels:'Tải mô hình',refreshing:'Đang tải mô hình…',saved:'Đã lưu ✓',saving:'Đang lưu…',checkingToken:'Đang kiểm tra token…',modelsUpdated:'Đã cập nhật mô hình',noLogs:'(chưa có nhật ký)',refresh:'Làm mới',clear:'Xóa',notice:'Thông báo',markRead:'Đã đọc',donate:'Ủng hộ dự án',noReply:'Chưa có phản hồi',syncError:'Feedback Hub hiện không khả dụng: ',submitError:'Không thể gửi phản hồi: ',adminRequired:'Hãy đăng nhập tại /admin để quản lý AI Settings và nhật ký.'}
};
function panelLanguage() {
  let selected = '';
  try { selected = localStorage.getItem('shfh-lang') || ''; } catch {}
  return selected === 'vi' || selected === 'en' ? selected :
    (String(navigator.language || '').toLowerCase().startsWith('vi') ? 'vi' : 'en');
}
function pt(key) { return PANEL_COPY[panelLanguage()][key] || PANEL_COPY.en[key] || key; }
function applyPanelLanguage() {
  const lang = panelLanguage();
  const selector = document.getElementById('aiPanelLanguage');
  if (selector) selector.value = lang;
  const title = document.querySelector('#aiPanel .panel-title');
  if (title) title.textContent = '✦ ' + pt('title');
  const close = document.getElementById('aiClose');
  if (close) close.setAttribute('aria-label', pt('close'));
  for (const key of ['chat','feedback','settings','logs']) {
    const tab = document.querySelector('.tab[data-tab="' + key + '"]');
    if (!tab) continue;
    const badge = key === 'feedback' ? document.getElementById('fbTabBadge') : null;
    tab.textContent = pt(key) + (badge ? ' ' : '');
    if (badge) tab.appendChild(badge);
  }
  const input = document.getElementById('aiInput'); if (input) input.placeholder = pt('chatPlaceholder');
  const send = document.getElementById('aiSend'); if (send) send.setAttribute('aria-label', pt('send'));
  const fbLabels = [...document.querySelectorAll('#tab-feedback .fb-label')];
  ['type','rating','message'].forEach((k,i)=>{ if(fbLabels[i]) fbLabels[i].textContent=pt(k); });
  const types = document.getElementById('fbType');
  if (types) [...types.options].forEach((o,i)=>o.textContent=pt(i===0?'improvement':i===1?'bug':'question'));
  const fbMessage = document.getElementById('fbMessage'); if(fbMessage) fbMessage.placeholder=pt('feedbackPlaceholder');
  const fbHint = document.querySelector('#tab-feedback .fb-hint'); if(fbHint) fbHint.textContent=pt('feedbackHint');
  const fbSubmit = document.getElementById('fbSubmit'); if(fbSubmit) fbSubmit.textContent=pt('sendFeedback');
  const settingsLabels = [...document.querySelectorAll('#tab-settings .fb-label')];
  ['provider','apiKey','baseUrl','model','mode'].forEach((k,i)=>{ if(settingsLabels[i]) settingsLabels[i].textContent=pt(k); });
  const provider = document.getElementById('setProvider');
  if(provider) [...provider.options].forEach(o=>{if(o.value==='none')o.textContent=pt('none');});
  const keyInput = document.getElementById('setApiKey'); if(keyInput) keyInput.placeholder=pt('keyPlaceholder');
  const mode = document.getElementById('setMode');
  if(mode) [...mode.options].forEach(o=>{const k={cloud_enabled:'cloud',prefer_local:'preferLocal',local_only:'localOnly',balanced:'balanced',custom:'custom'}[o.value];if(k)o.textContent=pt(k);});
  [['setSave','save'],['setTest','check'],['setModels','loadModels'],['logsRefresh','refresh'],['logsClear','clear']].forEach(([id,k])=>{const el=document.getElementById(id);if(el)el.textContent=pt(k);});
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function flatten(src, prefix, out) {
  if (src == null) return;
  if (typeof src === 'string' || typeof src === 'number') {
    if (String(src).trim()) out.push([prefix || 'info', String(src)]);
    return;
  }
  if (Array.isArray(src)) { src.forEach((v, i) => flatten(v, prefix + ' ' + (i + 1), out)); return; }
  if (typeof src === 'object') Object.keys(src).forEach(k => flatten(src[k], prefix ? prefix + ' · ' + k : k, out));
}
function renderDonate(donate) {
  const box = document.getElementById('fbDonate');
  if (!box) return;
  const rows = [];
  flatten(donate, '', rows);
  if (!rows.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<strong>' + escapeHtml(pt('donate')) + '</strong>' + rows.slice(0, 12).map(([k, v]) =>
    '<div class="fb-acc"><div class="fb-k">' + escapeHtml(k) + '</div><code class="fb-val">' + escapeHtml(v) + '</code></div>').join('');
}
function setUnread(n) {
  const badge = document.getElementById('aiBadge');
  const tabBadge = document.getElementById('fbTabBadge');
  const count = Number(n) || 0;
  if (badge) {
    if (count > 0) {
      badge.hidden = false;
      badge.style.display = '';
      badge.textContent = count > 9 ? '9+' : String(count);
    } else {
      badge.hidden = true;
      badge.style.display = 'none';
      badge.textContent = '';
    }
  }
  if (tabBadge) {
    if (count > 0) {
      tabBadge.hidden = false;
      tabBadge.style.display = '';
      tabBadge.textContent = count > 9 ? '9+' : String(count);
    } else {
      tabBadge.hidden = true;
      tabBadge.style.display = 'none';
      tabBadge.textContent = '';
    }
  }
}
function setFabVisible(visible) {
  const fab = document.getElementById('aiFab');
  if (!fab) return;
  fab.hidden = !visible;
  fab.style.display = visible ? '' : 'none';
}
function gameContext() {
  // HOST: non-secret live state for AI. Prefer host-provided window.gameContext.
  if (typeof window.__hostGameContext === 'function') {
    try { return window.__hostGameContext() || {}; } catch (e) {}
  }
  let app = null;
  try { if (typeof currentApp !== 'undefined') app = currentApp; } catch (e) {}
  const screen = document.querySelector('.screen.active') || document.getElementById('dash') || document.querySelector('main');
  return {
    screen: screen ? (screen.id || 'admin') : 'public',
    currentApp: app,
    hub: 'SoloHost Feedback Hub',
  };
}
function executeActions(actions) {
  if (typeof window.__hostExecuteActions === 'function') {
    try { return window.__hostExecuteActions(actions); } catch (e) {}
  }
  (actions || []).forEach(a => {
    if (!a || a.ok === false) return;
    const name = a.action || a.name;
    const value = a.value || (a.args && a.args.value) || '';
    if (name === 'open_tab') document.querySelector('.tab[data-tab="' + (value || 'chat') + '"]')?.click();
  });
}

const aiChat = document.getElementById('aiChat');
const aiInput = document.getElementById('aiInput');
function appendMsg(role, html) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = html;
  if (aiChat) { aiChat.appendChild(div); aiChat.scrollTop = aiChat.scrollHeight; }
  return div;
}

const ai = window.UniversalAI.create({
  button: document.getElementById('aiFab'),
  onOpen() {
    const ov = document.getElementById('aiOverlay');
    if (ov) ov.hidden = false;
    setFabVisible(false);
    refreshStatus();
    loadSettings();
  },
  onActions: executeActions
});

function closeAIPanel() {
  const ov = document.getElementById('aiOverlay');
  if (ov) ov.hidden = true;
  setFabVisible(true);
}
document.getElementById('aiClose')?.addEventListener('click', closeAIPanel);
document.getElementById('aiOverlay')?.addEventListener('click', e => {
  if (e.target.id === 'aiOverlay') closeAIPanel();
});
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  document.getElementById('tab-' + t.dataset.tab)?.classList.add('active');
  if (t.dataset.tab === 'settings') loadSettings();
  if (t.dataset.tab === 'logs') loadLogs();
  
}));

async function refreshStatus() {
  const bar = document.getElementById('aiStatusBar');
  const dot = document.getElementById('aiStatusDot');
  try {
    const j = await ai.status();
    const configured = !!(j.configured || (j.settings && j.settings.hasKey));
    const provider = (j.settings && j.settings.provider) || j.provider || '';
    if (bar) bar.textContent = configured ? (pt('aiReady') + provider) : pt('localOn');
    if (dot) { dot.classList.toggle('on', configured); dot.classList.toggle('off', !configured); }
  } catch (e) {
    if (bar) bar.textContent = pt('aiUnavailable');
  }
}

async function sendAI() {
  const text = (aiInput.value || '').trim();
  if (!text) return;
  aiInput.value = '';
  appendMsg('user', escapeHtml(text));
  const loading = appendMsg('ai', '…');
  try {
    const out = await ai.chat(text, gameContext());
    loading.remove();
    executeActions(out.actions);
    const local = out.source === 'local' || out.configured === false;
    appendMsg('ai', escapeHtml(out.reply || pt('noReply')).replace(/\n/g, '<br>') +
      (local ? '<div style="opacity:.55;font-size:.75rem">' + escapeHtml(pt('localGuide')) + '</div>' : ''));
  } catch (e) {
    loading.remove();
    appendMsg('ai', escapeHtml(e.message || 'AI connection failed'));
  }
}
document.getElementById('aiSend')?.addEventListener('click', sendAI);
aiInput?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendAI(); } });

function fillModelSelect(models, current) {
  const sel = document.getElementById('setModel');
  if (!sel) return;
  if (!Array.isArray(models) || !models.length) {
    if (sel.tagName === 'SELECT') {
      sel.outerHTML = '<input type="text" id="setModel" placeholder="auto" value="' + escapeHtml(current || 'auto') + '">';
    } else {
      sel.value = current || 'auto';
    }
    return;
  }
  const opts = ['<option value="auto">auto</option>'].concat(
    models.slice(0, 40).map(m => {
      const id = typeof m === 'string' ? m : (m.id || m.name || '');
      return '<option value="' + escapeHtml(id) + '">' + escapeHtml(id) + '</option>';
    })
  );
  if (sel.tagName !== 'SELECT') {
    sel.outerHTML = '<select id="setModel">' + opts.join('') + '</select>';
  } else {
    sel.innerHTML = opts.join('');
  }
  const el = document.getElementById('setModel');
  if (el) el.value = current || 'auto';
}

async function loadSettings() {
  const sel = document.getElementById('setProvider');
  const status = document.getElementById('setStatus');
  try {
    const [st, cat] = await Promise.all([ai.settings(), ai.catalog()]);
    const providers = (cat && cat.providers) || (Array.isArray(cat) ? cat : []);
    if (sel && providers.length) {
      sel.innerHTML = '<option value="none">— None —</option>' +
        providers.map(p => '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name || p.id) + '</option>').join('');
      sel.value = st.provider || 'none';
    }
    const keyHint = document.getElementById('setKeyHint');
    if (keyHint) keyHint.textContent = st.hasKey ? ('Key hiện tại: ' + (st.maskedKey || '****')) : 'Key hiện tại: (chưa có)';
    const apiKey = document.getElementById('setApiKey');
    if (apiKey) apiKey.value = '';
    const base = document.getElementById('setBaseUrl');
    if (base) base.value = st.baseUrl || '';
    fillModelSelect([], st.model || 'auto');
    const mode = document.getElementById('setMode');
    if (mode) mode.value = st.mode || 'cloud_enabled';
    if (status) status.textContent = '';
  } catch (e) {
    if (status) status.textContent = (String(e.message).includes('401') ? pt('adminRequired') : e.message);
  }
}

document.getElementById('setSave')?.addEventListener('click', async () => {
  const status = document.getElementById('setStatus');
  if (status) status.textContent = pt('saving');
  try {
    const body = {
      provider: document.getElementById('setProvider')?.value,
      baseUrl: document.getElementById('setBaseUrl')?.value.trim(),
      model: document.getElementById('setModel')?.value.trim() || 'auto',
      mode: document.getElementById('setMode')?.value
    };
    const key = document.getElementById('setApiKey')?.value.trim();
    if (key) body.apiKey = key;
    const j = await ai.saveSettings(body);
    if (status) status.textContent = j.ok === false ? (j.error || 'Failed') : pt('saved');
    await loadSettings();
    refreshStatus();
  } catch (e) {
    if (status) status.textContent = String(e.message).includes('401') ? pt('adminRequired') : e.message;
  }
});

document.getElementById('setTest')?.addEventListener('click', async () => {
  const status = document.getElementById('setStatus');
  if (status) status.textContent = pt('checkingToken');
  try {
    // save current form first so server tests the right provider/key
    const body = {
      provider: document.getElementById('setProvider')?.value,
      baseUrl: document.getElementById('setBaseUrl')?.value.trim(),
      model: document.getElementById('setModel')?.value.trim() || 'auto',
      mode: document.getElementById('setMode')?.value
    };
    const key = document.getElementById('setApiKey')?.value.trim();
    if (key) body.apiKey = key;
    await ai.saveSettings(body);
    const r = await ai.testConnection();
    if (r.ok) {
      const models = r.models || [];
      fillModelSelect(models, r.model || 'auto');
      if (status) status.textContent = 'Token OK' + (r.model ? ' · model: ' + r.model : '') + (models.length ? '. Models: ' + models.slice(0, 6).map(m => m.id || m).join(', ') : '. (server lists no models)') + (r.warning ? ' ⚠ ' + r.warning : '');
    } else {
      if (status) status.textContent = r.warning || r.error || 'Token check failed';
      if (r.suggested_provider) {
        const sel = document.getElementById('setProvider');
        if (sel) sel.value = r.suggested_provider;
      }
    }
  } catch (e) {
    if (status) status.textContent = String(e.message).includes('401') ? pt('adminRequired') : e.message;
  }
});

async function refreshModelsClick() {
  const status = document.getElementById('setStatus');
  if (status) status.textContent = pt('refreshing');
  try {
    const r = await ai.models();
    fillModelSelect(r.models || r || [], document.getElementById('setModel')?.value || 'auto');
    if (status) status.textContent = r.warning || pt('modelsUpdated');
  } catch (e) {
    if (status) status.textContent = String(e.message).includes('401') ? pt('adminRequired') : e.message;
  }
}
// HTML button is id="setModels"; keep the legacy id working too.
['setModels', 'setRefreshModels'].forEach(id => document.getElementById(id)?.addEventListener('click', refreshModelsClick));

async function loadLogs() {
  const view = document.getElementById('logsView');
  if (!view) return;
  try {
    const r = await fetch('/api/logs');
    const j = await r.json();
    view.textContent = (j.logs || []).map(l => (l.ts || '') + ' [' + l.level + '] ' + l.msg).join('\n') || pt('noLogs');
  } catch (e) {
    view.textContent = e.message;
  }
}
document.getElementById('logsRefresh')?.addEventListener('click', loadLogs);
document.getElementById('logsClear')?.addEventListener('click', async () => {
  await fetch('/api/logs', { method: 'DELETE' });
  loadLogs();
});

const fb = window.UniversalFeedback.create({
  onUnread: setUnread,
  onSync(sync) {
    renderDonate(sync.donate);
    renderNotices(sync.notices);
  }
});
function renderNotices(notices) {
  const el = document.getElementById('fbNotices');
  if (!el) return;
  el.innerHTML = (notices || []).map(n =>
    '<div class="fb-notice"><strong>' + escapeHtml(n.title || pt('notice')) + '</strong>' +
    (n.body ? '<div>' + escapeHtml(n.body) + '</div>' : '') +
    (n.id ? '<button type="button" data-mark="' + escapeHtml(n.id) + '">' + escapeHtml(pt('markRead')) + '</button>' : '') +
    '</div>'
  ).join('');
  el.querySelectorAll('[data-mark]').forEach(btn => btn.addEventListener('click', async () => {
    await fb.markRead(btn.dataset.mark);
    btn.closest('.fb-notice')?.remove();
  }));
}
let fbRating = 0;
document.querySelectorAll('#fbStars button').forEach(b => b.addEventListener('click', () => {
  fbRating = Number(b.dataset.r);
  document.querySelectorAll('#fbStars button').forEach(x => x.classList.toggle('on', Number(x.dataset.r) <= fbRating));
}));
document.getElementById('fbSubmit')?.addEventListener('click', async () => {
  const status = document.getElementById('fbStatus');
  const msg = (document.getElementById('fbMessage')?.value || '').trim();
  if (!msg) { if (status) status.textContent = pt('enterMessage'); return; }
  if (status) status.textContent = pt('sending');
  try {
    await fb.send({ type: document.getElementById('fbType')?.value, message: msg, rating: fbRating });
    if (status) status.textContent = pt('thanks');
    const ta = document.getElementById('fbMessage');
    if (ta) ta.value = '';
  } catch (e) {
    if (status) status.textContent = pt('submitError') + e.message;
  }
});

applyPanelLanguage();
document.getElementById('aiPanelLanguage')?.addEventListener('change', e => { const lang=e.target.value==='vi'?'vi':'en'; try{localStorage.setItem('shfh-lang',lang);}catch{} applyPanelLanguage(); });
refreshStatus();
loadSettings();
fb.sync().catch(e => {
  const st = document.getElementById('fbStatus');
  if (st) st.textContent = pt('syncError') + e.message;
});
setUnread(0);
setFabVisible(true);
window.setInterval(() => { if (document.visibilityState !== 'hidden') fb.sync().catch(() => {}); }, 60000);
