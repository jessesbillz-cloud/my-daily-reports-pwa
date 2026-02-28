// ===== REPORTS CRUD =====
async function loadReports(jobId) {
  if (!supabase) return;
  try {
    const { data, error } = await supabase
      .from('reports')
      .select('*')
      .eq('job_id', jobId)
      .order('report_date', { ascending: false })
      .limit(50);
    if (error) throw error;
    currentReports = data || [];
    renderReports();
  } catch (e) {
    console.error('loadReports:', e);
    showToast('Failed to load reports');
  }
}

function renderReports() {
  const list = document.getElementById('reportsList');
  if (currentReports.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-text">No reports yet for this job.</div></div>';
    return;
  }
  list.innerHTML = currentReports.map(r => {
    const displayDate = formatDisplayDate(r.report_date);
    const statusClass = r.status === 'submitted' ? 'submitted' : 'draft';
    return `
      <div class="report-item" onclick="openReport('${r.id}')">
        <div class="report-header-row">
          <span class="report-title">Report #${r.report_number || '—'}</span>
          <span class="report-status ${statusClass}">${r.status || 'draft'}</span>
        </div>
        <div class="report-date">${displayDate} · ${esc(r.output_file_name || '')}</div>
      </div>
    `;
  }).join('');
}

function startNewReport() {
  if (!currentJob) return;
  editingReportId = null;
  reportPhotos = [];
  document.getElementById('reportId').value = '';
  document.getElementById('reportJobId').value = currentJob.id;
  document.getElementById('reportFormTitle').textContent = 'New Report';
  document.getElementById('reportFormJobName').textContent = currentJob.name;
  document.getElementById('reportDate').value = todayISO();
  document.getElementById('reportNumber').value = (currentReports.length + 1);

  // Pre-fill from saved job defaults (matches Swift JobPDFDefaultsStore)
  const defaults = JSON.parse(localStorage.getItem('mdr_job_defaults_' + currentJob.id) || '{}');
  document.getElementById('reportProjectName').value = defaults.projectName || currentJob.name || '';
  document.getElementById('reportProjectNumber').value = defaults.projectNumber || '';
  document.getElementById('reportJurisdiction').value = defaults.jurisdiction || '';
  document.getElementById('reportDsaFileNumber').value = defaults.dsaFileNumber || '';
  document.getElementById('reportProjectAddress').value = defaults.projectAddress || currentJob.site_address || '';
  document.getElementById('reportWeather').value = '';
  document.getElementById('reportRegularHours').value = '';
  document.getElementById('reportOvertimeHours').value = '';
  document.getElementById('reportDoubleTimeHours').value = '';
  document.getElementById('reportIorName').value = defaults.iorName || '';
  document.getElementById('reportProjectManager').value = defaults.projectManager || '';
  document.getElementById('reportArchitect').value = defaults.architect || '';
  document.getElementById('reportContractor').value = defaults.contractor || '';
  document.getElementById('reportManpower').value = '';
  document.getElementById('reportEquipment').value = '';
  document.getElementById('reportTrade').value = '';
  document.getElementById('reportGeneralNotes').value = '';
  document.getElementById('reportInspectionActivities').value = '';
  document.getElementById('reportCorrections').value = '';
  document.getElementById('reportObservationLetters').value = '';
  document.getElementById('reportIorNotes').value = '';
  document.getElementById('reportRfis').value = '';
  document.getElementById('reportSubmittals').value = '';
  document.getElementById('reportCcds').value = '';
  document.getElementById('reportAsis').value = '';
  document.getElementById('reportSiteVisits').value = '';
  document.getElementById('reportPhotoGrid').innerHTML = '';
  document.getElementById('deleteReportSection').classList.add('hidden');

  navigate('create-report');
}

async function openReport(reportId) {
  const report = currentReports.find(r => r.id === reportId);
  if (!report) return;

  let draft = report.report_data;

  // Fall back to storage if no inline report_data (matches Swift loadWorkingCopy)
  if (!draft && report.working_copy_path) {
    try {
      const { data } = await supabase.storage
        .from('report-working-copies')
        .download(report.working_copy_path);
      if (data) {
        const text = await data.text();
        draft = JSON.parse(text);
      }
    } catch (e) {
      console.error('Failed to load working copy:', e);
    }
  }

  if (report.status === 'submitted') {
    renderViewReport(report, draft);
    navigate('view-report');
  } else {
    editingReportId = report.id;
    populateReportForm(report, draft);
    navigate('create-report');
  }
}

function populateReportForm(report, draft) {
  document.getElementById('reportId').value = report.id;
  document.getElementById('reportJobId').value = report.job_id;
  document.getElementById('reportFormTitle').textContent = 'Edit Report #' + (report.report_number || '');
  document.getElementById('reportFormJobName').textContent = report.job_name || currentJob?.name || '';
  document.getElementById('deleteReportSection').classList.remove('hidden');

  const d = draft || {};
  document.getElementById('reportDate').value = report.report_date || d.date || todayISO();
  document.getElementById('reportNumber').value = report.report_number || d.reportNumber || d.report_number || 1;
  document.getElementById('reportProjectName').value = d.projectName || d.project_name || '';
  document.getElementById('reportProjectNumber').value = d.projectNumber || d.project_number || '';
  document.getElementById('reportJurisdiction').value = d.jurisdiction || '';
  document.getElementById('reportDsaFileNumber').value = d.dsaFileNumber || d.dsa_file_number || '';
  document.getElementById('reportProjectAddress').value = d.projectAddress || d.project_address || '';
  document.getElementById('reportWeather').value = d.weather || '';
  document.getElementById('reportRegularHours').value = d.regularHours || d.regular_hours || '';
  document.getElementById('reportOvertimeHours').value = d.overtimeHours || d.overtime_hours || '';
  document.getElementById('reportDoubleTimeHours').value = d.doubleTimeHours || d.double_time_hours || '';
  document.getElementById('reportIorName').value = d.iorName || d.ior_name || '';
  document.getElementById('reportProjectManager').value = d.projectManager || d.project_manager || '';
  document.getElementById('reportArchitect').value = d.architect || '';
  document.getElementById('reportContractor').value = d.contractor || '';
  document.getElementById('reportManpower').value = d.manpower || '';
  document.getElementById('reportEquipment').value = d.equipment || '';
  document.getElementById('reportTrade').value = d.trade || '';
  document.getElementById('reportGeneralNotes').value = d.generalNotes || d.general_notes || '';
  document.getElementById('reportInspectionActivities').value = d.inspectionActivities || d.inspection_activities || '';
  document.getElementById('reportCorrections').value = d.corrections || '';
  document.getElementById('reportObservationLetters').value = d.observationLettersIssued || d.observation_letters_issued || '';
  document.getElementById('reportIorNotes').value = d.iorNotes || d.ior_notes || '';
  document.getElementById('reportRfis').value = d.rfis || '';
  document.getElementById('reportSubmittals').value = d.submittals || '';
  document.getElementById('reportCcds').value = d.ccds || '';
  document.getElementById('reportAsis').value = d.asis || '';
  document.getElementById('reportSiteVisits').value = d.siteVisits || d.site_visits || '';
}

function buildReportDraft() {
  const date = document.getElementById('reportDate').value;
  const num = parseInt(document.getElementById('reportNumber').value) || 1;
  const df = new Date(date + 'T00:00:00');
  const mm = String(df.getMonth() + 1).padStart(2, '0');
  const dd = String(df.getDate()).padStart(2, '0');
  const yyyy = df.getFullYear();
  const outputFileName = 'Report_' + String(num).padStart(2, '0') + '_' + mm + dd + yyyy + '.pdf';

  return {
    id: document.getElementById('reportId').value || crypto.randomUUID(),
    jobId: document.getElementById('reportJobId').value,
    jobName: currentJob?.name || '',
    date: date,
    reportNumber: num,
    projectName: document.getElementById('reportProjectName').value,
    projectNumber: document.getElementById('reportProjectNumber').value,
    jurisdiction: document.getElementById('reportJurisdiction').value,
    dsaApp: '',
    dsaFileNumber: document.getElementById('reportDsaFileNumber').value,
    projectAddress: document.getElementById('reportProjectAddress').value,
    weather: document.getElementById('reportWeather').value,
    regularHours: document.getElementById('reportRegularHours').value,
    overtimeHours: document.getElementById('reportOvertimeHours').value,
    doubleTimeHours: document.getElementById('reportDoubleTimeHours').value,
    iorName: document.getElementById('reportIorName').value,
    projectManager: document.getElementById('reportProjectManager').value,
    architect: document.getElementById('reportArchitect').value,
    contractor: document.getElementById('reportContractor').value,
    manpower: document.getElementById('reportManpower').value,
    equipment: document.getElementById('reportEquipment').value,
    trade: document.getElementById('reportTrade').value,
    generalNotes: document.getElementById('reportGeneralNotes').value,
    inspectionActivities: document.getElementById('reportInspectionActivities').value,
    corrections: document.getElementById('reportCorrections').value,
    observationLettersIssued: document.getElementById('reportObservationLetters').value,
    iorNotes: document.getElementById('reportIorNotes').value,
    projectInspectorSignature: '',
    rfis: document.getElementById('reportRfis').value,
    submittals: document.getElementById('reportSubmittals').value,
    ccds: document.getElementById('reportCcds').value,
    asis: document.getElementById('reportAsis').value,
    siteVisits: document.getElementById('reportSiteVisits').value,
    inspectionRequests: [],
    contractorActivities: [],
    sitePhotosPaths: [],
    outputFileName: outputFileName
  };
}

// Matches Swift ReportsService.saveWorkingCopy exactly
async function saveReportDraft() {
  if (!supabase || !currentUser) return;
  const draft = buildReportDraft();

  try {
    // Check if report exists for this user+job+date (matches Swift upsertReportRow)
    const { data: existing } = await supabase
      .from('reports')
      .select('id')
      .eq('user_id', currentUser.id)
      .eq('job_id', draft.jobId)
      .eq('report_date', draft.date);

    let reportId;
    if (existing && existing.length > 0) {
      // Update existing
      reportId = existing[0].id;
      const { error } = await supabase.from('reports').update({
        job_name: draft.jobName,
        report_number: draft.reportNumber,
        output_file_name: draft.outputFileName,
        status: 'draft',
        report_data: draft,
        updated_at: new Date().toISOString()
      }).eq('id', reportId);
      if (error) throw error;
    } else {
      // Insert new
      reportId = draft.id;
      const { error } = await supabase.from('reports').insert({
        id: reportId,
        user_id: currentUser.id,
        job_id: draft.jobId,
        job_name: draft.jobName,
        report_number: draft.reportNumber,
        report_date: draft.date,
        output_file_name: draft.outputFileName,
        status: 'draft',
        report_data: draft
      });
      if (error) throw error;
    }

    // Verify row exists (RLS check, matches Swift)
    const { data: check } = await supabase.from('reports').select('id').eq('id', reportId);
    if (!check || check.length === 0) {
      showToast('RLS may have blocked the save. Check Supabase policies.');
      return;
    }

    // Upload working copy JSON to storage (non-fatal, matches Swift)
    try {
      const jsonStr = JSON.stringify(draft, null, 2);
      const path = 'working-copies/' + currentUser.id + '/' + draft.jobId + '/' + reportId + '.json';
      await supabase.storage
        .from('report-working-copies')
        .upload(path, new Blob([jsonStr], { type: 'application/json' }), { upsert: true });

      await supabase.from('reports').update({
        working_copy_path: path,
        updated_at: new Date().toISOString()
      }).eq('id', reportId);
    } catch (e) {
      console.warn('Storage upload (non-fatal):', e);
    }

    showToast('Draft saved');
    editingReportId = reportId;
    document.getElementById('reportId').value = reportId;
    document.getElementById('deleteReportSection').classList.remove('hidden');
    await loadReports(draft.jobId);
  } catch (e) {
    console.error('saveReportDraft:', e);
    showToast('Failed to save draft: ' + e.message);
  }
}

async function submitReport() {
  if (!confirm('Submit this report? It will be marked as final.')) return;
  await saveReportDraft();
  const reportId = document.getElementById('reportId').value;
  if (!reportId) return;

  try {
    const draft = buildReportDraft();
    await supabase.from('reports').update({
      status: 'submitted',
      output_file_name: draft.outputFileName,
      updated_at: new Date().toISOString()
    }).eq('id', reportId);
    showToast('Report submitted');
    backFromReport();
    await loadReports(draft.jobId);
  } catch (e) {
    console.error('submitReport:', e);
    showToast('Failed to submit report');
  }
}

// Matches Swift ReportsService.deleteReport — cascade delete
async function deleteCurrentReport() {
  const reportId = document.getElementById('reportId').value;
  if (!reportId || !confirm('Delete this report permanently?')) return;

  try {
    const report = currentReports.find(r => r.id === reportId);
    await supabase.from('reports').delete().eq('id', reportId);

    // Verify deletion (RLS check)
    const { data: check } = await supabase.from('reports').select('id').eq('id', reportId);
    if (check && check.length > 0) {
      showToast('Delete blocked by RLS. Check Supabase policies.');
      return;
    }

    // Cascade delete storage (non-fatal, matches Swift)
    if (report?.working_copy_path) {
      try { await supabase.storage.from('report-working-copies').remove([report.working_copy_path]); } catch(e) {}
    }
    if (report?.source_doc_path) {
      try { await supabase.storage.from('report-source-docs').remove([report.source_doc_path]); } catch(e) {}
    }
    if (report?.submitted_pdf_path) {
      try { await supabase.storage.from('report-submitted').remove([report.submitted_pdf_path]); } catch(e) {}
    }

    showToast('Report deleted');
    backFromReport();
    if (currentJob) await loadReports(currentJob.id);
  } catch (e) {
    console.error('deleteReport:', e);
    showToast('Failed to delete report');
  }
}

function renderViewReport(report, draft) {
  const d = draft || {};
  const html = `
    <div class="card">
      <div class="card-header">
        <h3>Report #${report.report_number || '—'}</h3>
        <span class="report-status submitted">Submitted</span>
      </div>
      <div class="form-section">
        <div class="form-section-title">Report Info</div>
        <div style="font-size:14px;color:#ccc;line-height:1.8;">
          <strong>Date:</strong> ${formatDisplayDate(report.report_date)}<br>
          <strong>File:</strong> ${esc(report.output_file_name || '')}
        </div>
      </div>
      ${viewSection('Project Information', [
        ['Project Name', d.projectName || d.project_name],
        ['Project #', d.projectNumber || d.project_number],
        ['District', d.jurisdiction],
        ['DSA #', d.dsaFileNumber || d.dsa_file_number],
        ['Address', d.projectAddress || d.project_address],
        ['Weather', d.weather],
      ])}
      ${viewSection('Hours', [
        ['Regular', d.regularHours || d.regular_hours],
        ['Overtime', d.overtimeHours || d.overtime_hours],
        ['Double Time', d.doubleTimeHours || d.double_time_hours],
      ])}
      ${viewSection('Team', [
        ['IOR', d.iorName || d.ior_name],
        ['PM', d.projectManager || d.project_manager],
        ['Architect', d.architect],
        ['Contractor', d.contractor],
      ])}
      ${viewSection('Contractor Activity', [
        ['Manpower', d.manpower], ['Equipment', d.equipment], ['Trade', d.trade],
      ])}
      ${viewSection('Inspection Content', [
        ['General Notes', d.generalNotes || d.general_notes],
        ['Activities', d.inspectionActivities || d.inspection_activities],
        ['Corrections', d.corrections],
        ['Observation Letters', d.observationLettersIssued || d.observation_letters_issued],
        ['IOR Notes', d.iorNotes || d.ior_notes],
      ])}
      ${viewSection('Inspection Requests', [
        ['RFIs', d.rfis], ['Submittals', d.submittals], ['CCDs', d.ccds],
        ['ASIs', d.asis], ['Site Visits', d.siteVisits || d.site_visits],
      ])}
    </div>
  `;
  document.getElementById('viewReportContent').innerHTML = html;
}

function viewSection(title, fields) {
  const rows = fields.filter(([, v]) => v).map(([label, val]) =>
    '<strong>' + label + ':</strong> ' + esc(val)
  ).join('<br>');
  if (!rows) return '';
  return '<div class="form-section"><div class="form-section-title">' + title + '</div><div style="font-size:14px;color:#ccc;line-height:1.8;">' + rows + '</div></div>';
}

function backFromReport() {
  if (currentJob) navigate('job-detail');
  else navigate('home');
}

// ===== REPORT PHOTOS =====
function handleReportPhotos(input) {
  Array.from(input.files).forEach(file => {
    if (file.size > 10 * 1024 * 1024) { showToast(file.name + ' is too large'); return; }
    reportPhotos.push(file);
  });
  renderReportPhotos();
  input.value = '';
}

function renderReportPhotos() {
  const grid = document.getElementById('reportPhotoGrid');
  grid.innerHTML = '';
  reportPhotos.forEach((file, i) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    item.appendChild(img);
    const btn = document.createElement('button');
    btn.className = 'remove-btn';
    btn.innerHTML = '×';
    btn.onclick = () => { reportPhotos.splice(i, 1); renderReportPhotos(); };
    item.appendChild(btn);
    grid.appendChild(item);
  });
}
