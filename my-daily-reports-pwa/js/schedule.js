// ===== SCHEDULE STATE =====
let scheduleFiles = [];
let scheduleDur = '';
let scheduleType = '';
let schedCM = new Date().getMonth();
let schedCY = new Date().getFullYear();
let schedMD = {};

// ===== SCHEDULE TABS =====
function switchScheduleSubTab(tab) {
  const tabs = document.querySelectorAll('#jobScheduleTab > .tabs .tab');
  tabs[0].classList.toggle('active', tab === 'calendar');
  tabs[1].classList.toggle('active', tab === 'request');
  document.getElementById('scheduleCalendarView').classList.toggle('hidden', tab !== 'calendar');
  document.getElementById('scheduleRequestView').classList.toggle('hidden', tab !== 'request');
}

// ===== CALENDAR =====
async function loadScheduleData() {
  if (!supabase || !currentJob) return;
  try {
    const { data, error } = await supabase
      .from('inspection_requests')
      .select('*')
      .or('status.neq.cancelled,status.is.null');
    if (error) throw error;

    schedMD = {};
    (data || []).forEach(v => {
      if (!schedMD[v.inspection_date]) schedMD[v.inspection_date] = [];
      schedMD[v.inspection_date].push(v);
    });
    renderScheduleCal();
  } catch (e) {
    console.error('loadScheduleData:', e);
  }
}

function changeScheduleMonth(dir) {
  schedCM += dir;
  if (schedCM > 11) { schedCM = 0; schedCY++; }
  if (schedCM < 0) { schedCM = 11; schedCY--; }
  renderScheduleCal();
}

function renderScheduleCal() {
  const g = document.getElementById('schedCalGrid');
  g.innerHTML = '';
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  document.getElementById('schedMonthLabel').textContent = months[schedCM] + ' ' + schedCY;
  const sd = new Date(schedCY, schedCM, 1).getDay();
  const ld = new Date(schedCY, schedCM + 1, 0).getDate();
  const today = todayISO();

  for (let i = 0; i < sd; i++) {
    const empty = document.createElement('div');
    empty.className = 'day-cell';
    g.appendChild(empty);
  }
  for (let d = 1; d <= ld; d++) {
    const dateStr = schedCY + '-' + String(schedCM + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const cell = document.createElement('div');
    cell.className = 'day-cell';
    if (dateStr === today) cell.classList.add('today');
    cell.innerHTML = '<span class="day-num">' + d + '</span>';

    if (schedMD[dateStr]) {
      const active = schedMD[dateStr].filter(e => e.status !== 'cancelled');
      if (active.length > 0) {
        cell.innerHTML += '<div style="font-size:12px;color:var(--blue);font-weight:700;">' + active.length + '</div>';
      }
    }
    cell.onclick = (() => { const ds = dateStr; return () => showScheduleDay(ds); })();
    g.appendChild(cell);
  }
}

function showScheduleDay(dateStr) {
  const list = document.getElementById('schedDayDetailList');
  document.getElementById('schedDayDetailHeader').textContent = 'Schedule for ' + dateStr;
  const evts = (schedMD[dateStr] || []).filter(e => e.status !== 'cancelled');

  if (evts.length === 0) {
    list.innerHTML = '<div style="color:var(--text-sec);padding:10px;">No inspections scheduled</div>';
  } else {
    list.innerHTML = evts.map(e => {
      const time = e.flexible_display === 'flexible' ? 'Flexible' : (e.inspection_time || '').substring(0, 5);
      const types = (e.inspection_types || []).join(', ');
      return `
        <div class="evt-row">
          <span>${time}</span> — <span>${types}</span>
          ${e.project ? '<span style="color:var(--text-mut);font-size:11px;"> (' + esc(e.project) + ')</span>' : ''}
          ${e.inspection_identifier ? '<div style="color:var(--orange);font-weight:700;font-size:13px;margin:4px 0;">' + esc(e.inspection_identifier) + '</div>' : ''}
          <div style="font-size:11px;color:var(--text-sec);margin-top:4px;">By: ${esc(e.submitted_by || '')}</div>
          <div class="evt-actions">
            <button class="btn-edit" onclick="editScheduleInsp('${e.id}','${e.inspection_date}','${(e.inspection_time || '').substring(0, 5)}')">Edit</button>
            <button class="btn-cancel-evt" onclick="cancelScheduleInsp('${e.id}')">Cancel</button>
          </div>
        </div>
      `;
    }).join('');
  }
  document.getElementById('schedDayDetail').style.display = 'block';
}

// ===== EDIT / CANCEL =====
async function cancelScheduleInsp(id) {
  if (!confirm('Cancel this inspection?')) return;
  const who = prompt('Who is cancelling?');
  if (!who) return;
  const reason = prompt('Reason (optional):') || '';

  try {
    const config = getSupabaseConfig();
    const res = await fetch(config.url + '/functions/v1/update-inspection', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + config.key, 'apikey': config.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: id, action: 'cancel', action_by: who, reason: reason })
    });
    const data = await res.json();
    if (data.success) { showToast('Inspection cancelled'); loadScheduleData(); }
    else { showToast('Error: ' + (data.error || 'Unknown')); }
  } catch (e) {
    // Fallback: direct update
    try {
      await supabase.from('inspection_requests').update({ status: 'cancelled' }).eq('id', id);
      showToast('Inspection cancelled');
      loadScheduleData();
    } catch (e2) {
      showToast('Failed to cancel');
    }
  }
}

async function editScheduleInsp(id, oldDate, oldTime) {
  const who = prompt('Who is editing?');
  if (!who) return;
  const newDate = prompt('New date (YYYY-MM-DD):', oldDate);
  const newTime = prompt('New time (HH:MM):', oldTime);
  if (!newDate || !newTime) return;

  try {
    const config = getSupabaseConfig();
    const res = await fetch(config.url + '/functions/v1/update-inspection', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + config.key, 'apikey': config.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: id, action: 'edit', action_by: who, new_date: newDate, new_time: newTime })
    });
    const data = await res.json();
    if (data.success) { showToast('Inspection updated'); loadScheduleData(); }
    else { showToast('Error: ' + (data.error || 'Unknown')); }
  } catch (e) {
    showToast('Failed to update');
  }
}

// ===== REQUEST FORM =====
function handleScheduleFiles(input) {
  Array.from(input.files).forEach(file => {
    if (file.size > (file.type === 'application/pdf' ? 25 * 1024 * 1024 : 10 * 1024 * 1024)) {
      showToast(file.name + ' is too large'); return;
    }
    scheduleFiles.push(file);
  });
  renderScheduleFiles();
  input.value = '';
}

function renderScheduleFiles() {
  const grid = document.getElementById('schedFileGrid');
  grid.innerHTML = '';
  scheduleFiles.forEach((file, i) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    if (file.type === 'application/pdf') {
      item.innerHTML = '<div class="pdf-indicator">PDF<br>' + file.name.substring(0, 8) + '...</div>';
    } else {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      item.appendChild(img);
    }
    const btn = document.createElement('button');
    btn.className = 'remove-btn';
    btn.innerHTML = '×';
    btn.onclick = () => { scheduleFiles.splice(i, 1); renderScheduleFiles(); };
    item.appendChild(btn);
    grid.appendChild(item);
  });
}

function setScheduleDur(dur, el) {
  scheduleDur = dur;
  document.querySelectorAll('#schedDurBtns .dur-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
}

function setScheduleType(type, el) {
  scheduleType = type;
  document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('schedSpecialSub').classList.toggle('show', type === 'Special');
}

async function submitScheduleRequest() {
  const date = document.getElementById('schedDate').value;
  const time = document.getElementById('schedTime').value;
  let name = document.getElementById('schedSubmittedBy').value;
  const newName = document.getElementById('schedNewName').value.trim();
  if ((!name || name === 'other') && newName) name = newName;

  if (!name || !date || !time || !scheduleType || !scheduleDur) {
    showToast('Please fill all required fields');
    return;
  }

  const btn = document.getElementById('schedSubmitBtn');
  btn.disabled = true; btn.textContent = 'Submitting...';

  try {
    const config = getSupabaseConfig();
    const fd = new FormData();
    scheduleFiles.forEach((file, i) => fd.append('file_' + i, file));
    fd.append('project', currentJob?.name || '');
    fd.append('gc', '');
    fd.append('inspection_date', date);
    fd.append('inspection_time', time);
    fd.append('inspection_types', JSON.stringify([scheduleType]));
    fd.append('duration', scheduleDur);
    fd.append('submitted_by', name);
    fd.append('notes', document.getElementById('schedNotes').value);
    fd.append('subcontractor', '');
    fd.append('location_detail', '');

    // Collect email recipients
    const emails = [];
    document.querySelectorAll('#schedEmailList .emailCheck:checked').forEach(cb => emails.push(cb.value));
    const addl = document.getElementById('schedAdditionalEmails').value.trim();
    if (addl) emails.push(...addl.split(',').map(e => e.trim()));
    if (emails.length > 0) fd.append('email_recipients', JSON.stringify(emails));

    const idnt = document.getElementById('schedIdentifier').value.trim();
    if (idnt) fd.append('inspection_identifier', idnt);

    const res = await fetch(config.url + '/functions/v1/submit-inspection', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + config.key, 'apikey': config.key },
      body: fd
    });
    const data = await res.json();
    if (data.success) {
      showToast('Inspection request submitted');
      scheduleFiles = [];
      document.getElementById('schedFileGrid').innerHTML = '';
      switchScheduleSubTab('calendar');
      loadScheduleData();
    } else {
      showToast('Error: ' + (data.error || 'Unknown'));
    }
  } catch (e) {
    console.error('submitScheduleRequest:', e);
    showToast('Failed to submit request');
  } finally {
    btn.disabled = false; btn.textContent = 'Submit Inspection Request';
  }
}
