// ===== GLOBAL STATE =====
let supabase = null;
let currentUser = null;
let currentJobs = [];
let currentJob = null;
let currentReports = [];
let editingReportId = null;
let reportPhotos = [];
let currentPage = 'home';

// ===== UTILITIES =====
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function formatDisplayDate(dateStr) {
  if (!dateStr) return 'Unknown date';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return months[parseInt(parts[1]) - 1] + ' ' + parseInt(parts[2]) + ', ' + parts[0];
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

function getSupabaseConfig() {
  return {
    url: localStorage.getItem('mdr_supabase_url') || '',
    key: localStorage.getItem('mdr_supabase_key') || ''
  };
}

function showSetupModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>Supabase Setup</h3>
      <label class="field-label">Supabase URL</label>
      <input type="text" id="setupUrl" class="field-input" placeholder="https://your-project.supabase.co" value="${getSupabaseConfig().url}">
      <label class="field-label">Supabase Anon Key</label>
      <input type="text" id="setupKey" class="field-input" placeholder="eyJ..." value="${getSupabaseConfig().key}">
      <button class="btn-primary" onclick="saveSetupAndClose(this)">Save & Connect</button>
      <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()" style="width:100%;margin-top:8px;">Cancel</button>
    </div>
  `;
  document.body.appendChild(overlay);
}

function saveSetupAndClose(btn) {
  const url = document.getElementById('setupUrl').value.trim();
  const key = document.getElementById('setupKey').value.trim();
  if (!url || !key) { showToast('Both fields required'); return; }
  localStorage.setItem('mdr_supabase_url', url);
  localStorage.setItem('mdr_supabase_key', key);
  btn.closest('.modal-overlay').remove();
  initSupabase(url, key);
  showToast('Connected to Supabase');
}

// ===== NAVIGATION =====
function navigate(page) {
  if (page === 'create-job' && !document.getElementById('editJobId').value) resetJobForm();
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  const el = document.getElementById('page-' + page);
  if (el) el.classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (page === 'home') document.querySelectorAll('.nav-item')[0].classList.add('active');
  if (page === 'settings') document.querySelectorAll('.nav-item')[1].classList.add('active');
  currentPage = page;
  window.scrollTo(0, 0);
}
