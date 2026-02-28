// =============================================
//  state.js — global state + config + helpers
// =============================================

const App = {
  supabase: null,
  user: null,
  jobs: [],
  job: null,        // currently open job
  reports: [],
  page: 'home',
};

// ---------- Supabase config (localStorage) ----------
const Config = {
  DEFAULT_URL: 'https://wluvkmpncafugdbunlkw.supabase.co',
  DEFAULT_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndsdXZrbXBuY2FmdWdkYnVubGt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIzMDU1MTUsImV4cCI6MjA4Nzg4MTUxNX0.HZpQ2xVGpf4EQ0BVDmIEuPqW5T_eNG5OqBNAqT03rH8',
  get() {
    return {
      url: localStorage.getItem('mdr_sb_url') || Config.DEFAULT_URL,
      key: localStorage.getItem('mdr_sb_key') || Config.DEFAULT_KEY,
    };
  },
  set(url, key) {
    localStorage.setItem('mdr_sb_url', url);
    localStorage.setItem('mdr_sb_key', key);
  },
  clear() {
    localStorage.removeItem('mdr_sb_url');
    localStorage.removeItem('mdr_sb_key');
  },
};

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
const $val = (id) => ($(id)?.value ?? '').trim();
const $set = (id, v) => { if ($(id)) $(id).value = v ?? ''; };

function esc(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 2500);
}

// ---------- Date helpers ----------
function todayISO() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
}

function fmtDate(iso) {
  if (!iso) return 'Unknown';
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const p = iso.split('-');
  if (p.length !== 3) return iso;
  return m[+p[1]-1] + ' ' + +p[2] + ', ' + p[0];
}

function outputFileName(num, dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return 'Report_' + String(num).padStart(2,'0') + '_' + mm + dd + d.getFullYear() + '.pdf';
}

// ---------- Navigation ----------
function nav(page) {
  if (page === 'create-job' && !$val('editJobId')) Jobs.resetForm();
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  const el = $('page-' + page);
  if (el) el.classList.remove('hidden');

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (page === 'home')     document.querySelectorAll('.nav-item')[0]?.classList.add('active');
  if (page === 'settings') document.querySelectorAll('.nav-item')[1]?.classList.add('active');

  App.page = page;
  window.scrollTo(0, 0);
}

// ---------- Setup modal ----------
function showSetupModal() {
  const c = Config.get();
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-box">
    <h3>Connect to Supabase</h3>
    <label class="field-label">Project URL</label>
    <input type="text" id="setupUrl" class="field-input" placeholder="https://xxx.supabase.co" value="${esc(c.url)}">
    <label class="field-label">Anon Key</label>
    <input type="text" id="setupKey" class="field-input" placeholder="eyJ..." value="${esc(c.key)}">
    <button class="btn-primary" id="setupSaveBtn">Save &amp; Connect</button>
    <button class="btn-secondary" style="width:100%;margin-top:8px" id="setupCancelBtn">Cancel</button>
  </div>`;
  document.body.appendChild(ov);
  $('setupSaveBtn').onclick = () => {
    const u = $val('setupUrl'), k = $val('setupKey');
    if (!u || !k) { showToast('Both fields required'); return; }
    Config.set(u, k);
    ov.remove();
    Auth.initSupabase(u, k);
    showToast('Connected');
  };
  $('setupCancelBtn').onclick = () => ov.remove();
}
