// =============================================
//  schedule.js — Calendar + Inspection Requests
//  Genericized from CSUSM page, no hardcoded data
// =============================================

const Schedule = {

  files: [],
  dur: '',
  type: '',
  cm: new Date().getMonth(),
  cy: new Date().getFullYear(),
  md: {},  // date → [events]

  // ---------- Sub-tabs ----------

  subTab(tab) {
    const tabs = document.querySelectorAll('#jobScheduleTab > .tabs .tab');
    tabs[0].classList.toggle('active', tab === 'calendar');
    tabs[1].classList.toggle('active', tab === 'request');
    $('schedCalView').classList.toggle('hidden', tab !== 'calendar');
    $('schedReqView').classList.toggle('hidden', tab !== 'request');
  },

  // ---------- Calendar ----------

  async loadData() {
    if (!App.supabase || !App.job) return;
    try {
      const { data, error } = await App.supabase
        .from('inspection_requests').select('*')
        .or('status.neq.cancelled,status.is.null');
      if (error) throw error;
      Schedule.md = {};
      (data || []).forEach(v => {
        if (!Schedule.md[v.inspection_date]) Schedule.md[v.inspection_date] = [];
        Schedule.md[v.inspection_date].push(v);
      });
      Schedule.renderCal();
    } catch (e) { console.error('Schedule.loadData:', e); }
  },

  changeMonth(dir) {
    Schedule.cm += dir;
    if (Schedule.cm > 11) { Schedule.cm = 0; Schedule.cy++; }
    if (Schedule.cm < 0)  { Schedule.cm = 11; Schedule.cy--; }
    Schedule.renderCal();
  },

  renderCal() {
    const g = $('schedCalGrid'); g.innerHTML = '';
    const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    $('schedMonthLabel').textContent = names[Schedule.cm] + ' ' + Schedule.cy;
    const sd = new Date(Schedule.cy, Schedule.cm, 1).getDay();
    const ld = new Date(Schedule.cy, Schedule.cm + 1, 0).getDate();
    const today = todayISO();

    for (let i = 0; i < sd; i++) { const e = document.createElement('div'); e.className = 'day-cell'; g.appendChild(e); }
    for (let d = 1; d <= ld; d++) {
      const ds = Schedule.cy + '-' + String(Schedule.cm+1).padStart(2,'0') + '-' + String(d).padStart(2,'0');
      const c = document.createElement('div'); c.className = 'day-cell';
      if (ds === today) c.classList.add('today');
      c.innerHTML = '<span class="day-num">' + d + '</span>';
      const evts = (Schedule.md[ds] || []).filter(e => e.status !== 'cancelled');
      if (evts.length) c.innerHTML += '<div style="font-size:12px;color:var(--blue);font-weight:700">' + evts.length + '</div>';
      c.onclick = (() => { const s = ds; return () => Schedule.showDay(s); })();
      g.appendChild(c);
    }
  },

  showDay(ds) {
    $('schedDayHdr').textContent = 'Schedule for ' + ds;
    const evts = (Schedule.md[ds] || []).filter(e => e.status !== 'cancelled');
    const el = $('schedDayList');
    if (!evts.length) {
      el.innerHTML = '<div style="color:var(--text-sec);padding:10px">No inspections scheduled</div>';
    } else {
      el.innerHTML = evts.map(e => {
        const t = e.flexible_display === 'flexible' ? 'Flexible' : (e.inspection_time||'').substring(0,5);
        const types = (e.inspection_types||[]).join(', ');
        return `<div class="evt-row">
          <span>${t}</span> — <span>${types}</span>
          ${e.project ? '<span style="color:var(--text-mut);font-size:11px"> (' + esc(e.project) + ')</span>' : ''}
          ${e.inspection_identifier ? '<div style="color:var(--orange);font-weight:700;font-size:13px;margin:4px 0">' + esc(e.inspection_identifier) + '</div>' : ''}
          <div style="font-size:11px;color:var(--text-sec);margin-top:4px">By: ${esc(e.submitted_by||'')}</div>
          <div class="evt-actions">
            <button class="evt-btn evt-btn-edit" onclick="Schedule.editInsp('${e.id}','${e.inspection_date}','${(e.inspection_time||'').substring(0,5)}')">Edit</button>
            <button class="evt-btn evt-btn-cancel" onclick="Schedule.cancelInsp('${e.id}')">Cancel</button>
          </div>
        </div>`;
      }).join('');
    }
    $('schedDayDetail').style.display = 'block';
  },

  // ---------- Edit / Cancel ----------

  async cancelInsp(id) {
    if (!confirm('Cancel this inspection?')) return;
    const who = prompt('Who is cancelling?');
    if (!who) return;
    const reason = prompt('Reason (optional):') || '';
    try {
      const c = Config.get();
      const res = await fetch(c.url + '/functions/v1/update-inspection', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + c.key, 'apikey': c.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: id, action: 'cancel', action_by: who, reason }),
      });
      const d = await res.json();
      if (d.success) { showToast('Cancelled'); Schedule.loadData(); }
      else showToast('Error: ' + (d.error || 'Unknown'));
    } catch (e) {
      try { await App.supabase.from('inspection_requests').update({ status: 'cancelled' }).eq('id', id); showToast('Cancelled'); Schedule.loadData(); }
      catch (e2) { showToast('Failed to cancel'); }
    }
  },

  async editInsp(id, oldDate, oldTime) {
    const who = prompt('Who is editing?');
    if (!who) return;
    const newDate = prompt('New date (YYYY-MM-DD):', oldDate);
    const newTime = prompt('New time (HH:MM):', oldTime);
    if (!newDate || !newTime) return;
    try {
      const c = Config.get();
      const res = await fetch(c.url + '/functions/v1/update-inspection', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + c.key, 'apikey': c.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: id, action: 'edit', action_by: who, new_date: newDate, new_time: newTime }),
      });
      const d = await res.json();
      if (d.success) { showToast('Updated'); Schedule.loadData(); }
      else showToast('Error: ' + (d.error || 'Unknown'));
    } catch (e) { showToast('Failed to update'); }
  },

  // ---------- Request form ----------

  handleFiles(input) {
    Array.from(input.files).forEach(f => {
      const max = f.type === 'application/pdf' ? 25*1024*1024 : 10*1024*1024;
      if (f.size > max) { showToast(f.name + ' too large'); return; }
      Schedule.files.push(f);
    });
    Schedule.renderFiles();
    input.value = '';
  },

  renderFiles() {
    const g = $('schedFileGrid'); g.innerHTML = '';
    Schedule.files.forEach((f, i) => {
      const el = document.createElement('div'); el.className = 'file-thumb';
      if (f.type === 'application/pdf') {
        el.innerHTML = '<div class="pdf-tag">PDF<br>' + f.name.substring(0,8) + '…</div>';
      } else {
        const img = document.createElement('img'); img.src = URL.createObjectURL(f); el.appendChild(img);
      }
      const btn = document.createElement('button'); btn.className = 'rm-btn'; btn.innerHTML = '×';
      btn.onclick = () => { Schedule.files.splice(i,1); Schedule.renderFiles(); };
      el.appendChild(btn); g.appendChild(el);
    });
  },

  setDur(val, el) {
    Schedule.dur = val;
    document.querySelectorAll('#schedDurBtns .dur-btn').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
  },

  setType(val, el) {
    Schedule.type = val;
    document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
    $('schedSpecialSub').classList.toggle('show', val === 'Special');
  },

  async submitRequest() {
    const date = $val('schedDate'), time = $val('schedTime');
    let name = $val('schedSubmittedBy');
    const newName = $val('schedNewName');
    if ((!name || name === 'other') && newName) name = newName;

    if (!name || !date || !time || !Schedule.type || !Schedule.dur) {
      showToast('Fill all required fields'); return;
    }

    const btn = $('schedSubmitBtn');
    btn.disabled = true; btn.textContent = 'Submitting…';

    try {
      const c = Config.get();
      const fd = new FormData();
      Schedule.files.forEach((f, i) => fd.append('file_' + i, f));
      fd.append('project', App.job?.name || '');
      fd.append('gc', '');
      fd.append('inspection_date', date);
      fd.append('inspection_time', time);
      fd.append('inspection_types', JSON.stringify([Schedule.type]));
      fd.append('duration', Schedule.dur);
      fd.append('submitted_by', name);
      fd.append('notes', $val('schedNotes'));
      fd.append('subcontractor', '');
      fd.append('location_detail', '');

      const emails = [];
      document.querySelectorAll('#schedEmailList .emailCheck:checked').forEach(cb => emails.push(cb.value));
      const addl = $val('schedAdditionalEmails');
      if (addl) emails.push(...addl.split(',').map(e => e.trim()));
      if (emails.length) fd.append('email_recipients', JSON.stringify(emails));

      const idnt = $val('schedIdentifier');
      if (idnt) fd.append('inspection_identifier', idnt);

      const res = await fetch(c.url + '/functions/v1/submit-inspection', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + c.key, 'apikey': c.key },
        body: fd,
      });
      const d = await res.json();
      if (d.success) {
        showToast('Request submitted');
        Schedule.files = []; $('schedFileGrid').innerHTML = '';
        Schedule.subTab('calendar');
        Schedule.loadData();
      } else {
        showToast('Error: ' + (d.error || 'Unknown'));
      }
    } catch (e) {
      console.error('Schedule.submitRequest:', e);
      showToast('Failed to submit');
    } finally {
      btn.disabled = false; btn.textContent = 'Submit Inspection Request';
    }
  },
};
