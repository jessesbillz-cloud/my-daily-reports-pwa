// =============================================
//  reports.js — Reports CRUD
//  1:1 match to Swift ReportsService
// =============================================

const Reports = {

  photos: [],

  // ---------- Load & render ----------

  async load(jobId) {
    if (!App.supabase) return;
    try {
      const { data, error } = await App.supabase
        .from('reports').select('*')
        .eq('job_id', jobId)
        .order('report_date', { ascending: false })
        .limit(50);
      if (error) throw error;
      App.reports = data || [];
      Reports.render();
    } catch (e) {
      console.error('Reports.load:', e);
      showToast('Failed to load reports');
    }
  },

  render() {
    const el = $('reportsList');
    if (!App.reports.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">No reports yet for this job.</div></div>';
      return;
    }
    el.innerHTML = App.reports.map(r => {
      const sc = r.status === 'submitted' ? 'status-submitted' : 'status-draft';
      return `<div class="report-item" onclick="Reports.open('${r.id}')">
        <div class="report-row">
          <span class="report-title">Report #${r.report_number || '—'}</span>
          <span class="report-status ${sc}">${r.status || 'draft'}</span>
        </div>
        <div class="report-date">${fmtDate(r.report_date)} · ${esc(r.output_file_name || '')}</div>
      </div>`;
    }).join('');
  },

  // ---------- New report ----------

  startNew() {
    if (!App.job) return;
    Reports.photos = [];
    $set('rptId', '');
    $set('rptJobId', App.job.id);
    $('rptFormTitle').textContent = 'New Report';
    $('rptFormJobName').textContent = App.job.name;
    $set('rptDate', todayISO());
    $set('rptNumber', App.reports.length + 1);

    // Pre-fill from saved defaults (matches Swift JobPDFDefaultsStore)
    const defs = JSON.parse(localStorage.getItem('mdr_defaults_' + App.job.id) || '{}');
    $set('rptProjectName',    defs.projectName || App.job.name || '');
    $set('rptProjectNumber',  defs.projectNumber || '');
    $set('rptJurisdiction',   defs.jurisdiction || '');
    $set('rptDsaFileNumber',  defs.dsaFileNumber || '');
    $set('rptProjectAddress', defs.projectAddress || App.job.site_address || '');
    $set('rptIorName',        defs.iorName || '');
    $set('rptProjectManager', defs.projectManager || '');
    $set('rptArchitect',      defs.architect || '');
    $set('rptContractor',     defs.contractor || '');

    // Clear variable fields
    ['rptWeather','rptRegularHours','rptOvertimeHours','rptDoubleTimeHours',
     'rptManpower','rptEquipment','rptTrade',
     'rptGeneralNotes','rptInspectionActivities','rptCorrections',
     'rptObservationLetters','rptIorNotes',
     'rptRfis','rptSubmittals','rptCcds','rptAsis','rptSiteVisits'
    ].forEach(id => $set(id, ''));
    $('rptPhotoGrid').innerHTML = '';
    $('deleteRptSection').classList.add('hidden');
    nav('create-report');
  },

  // ---------- Open existing ----------

  async open(id) {
    const rpt = App.reports.find(r => r.id === id);
    if (!rpt) return;

    // Priority: report_data JSONB → storage fallback (matches Swift)
    let draft = rpt.report_data;
    if (!draft && rpt.working_copy_path) {
      try {
        const { data } = await App.supabase.storage
          .from('report-working-copies').download(rpt.working_copy_path);
        if (data) draft = JSON.parse(await data.text());
      } catch (e) { console.warn('Working copy fallback failed:', e); }
    }

    if (rpt.status === 'submitted') {
      Reports.renderView(rpt, draft);
      nav('view-report');
    } else {
      Reports.fillForm(rpt, draft);
      nav('create-report');
    }
  },

  // ---------- Fill form for editing ----------

  fillForm(rpt, d) {
    d = d || {};
    $set('rptId', rpt.id);
    $set('rptJobId', rpt.job_id);
    $('rptFormTitle').textContent = 'Edit Report #' + (rpt.report_number || '');
    $('rptFormJobName').textContent = rpt.job_name || App.job?.name || '';
    $('deleteRptSection').classList.remove('hidden');

    // Helper: try camelCase then snake_case
    const v = (cc, sc) => d[cc] || d[sc] || '';

    $set('rptDate',              rpt.report_date || d.date || todayISO());
    $set('rptNumber',            rpt.report_number || v('reportNumber','report_number') || 1);
    $set('rptProjectName',       v('projectName','project_name'));
    $set('rptProjectNumber',     v('projectNumber','project_number'));
    $set('rptJurisdiction',      d.jurisdiction || '');
    $set('rptDsaFileNumber',     v('dsaFileNumber','dsa_file_number'));
    $set('rptProjectAddress',    v('projectAddress','project_address'));
    $set('rptWeather',           d.weather || '');
    $set('rptRegularHours',      v('regularHours','regular_hours'));
    $set('rptOvertimeHours',     v('overtimeHours','overtime_hours'));
    $set('rptDoubleTimeHours',   v('doubleTimeHours','double_time_hours'));
    $set('rptIorName',           v('iorName','ior_name'));
    $set('rptProjectManager',    v('projectManager','project_manager'));
    $set('rptArchitect',         d.architect || '');
    $set('rptContractor',        d.contractor || '');
    $set('rptManpower',          d.manpower || '');
    $set('rptEquipment',         d.equipment || '');
    $set('rptTrade',             d.trade || '');
    $set('rptGeneralNotes',      v('generalNotes','general_notes'));
    $set('rptInspectionActivities', v('inspectionActivities','inspection_activities'));
    $set('rptCorrections',       d.corrections || '');
    $set('rptObservationLetters', v('observationLettersIssued','observation_letters_issued'));
    $set('rptIorNotes',          v('iorNotes','ior_notes'));
    $set('rptRfis',              d.rfis || '');
    $set('rptSubmittals',        d.submittals || '');
    $set('rptCcds',              d.ccds || '');
    $set('rptAsis',              d.asis || '');
    $set('rptSiteVisits',        v('siteVisits','site_visits'));
  },

  // ---------- Build draft object ----------

  buildDraft() {
    const date = $val('rptDate');
    const num  = parseInt($val('rptNumber')) || 1;
    return {
      id:                       $val('rptId') || crypto.randomUUID(),
      jobId:                    $val('rptJobId'),
      jobName:                  App.job?.name || '',
      date,
      reportNumber:             num,
      projectName:              $val('rptProjectName'),
      projectNumber:            $val('rptProjectNumber'),
      jurisdiction:             $val('rptJurisdiction'),
      dsaApp:                   '',
      dsaFileNumber:            $val('rptDsaFileNumber'),
      projectAddress:           $val('rptProjectAddress'),
      weather:                  $val('rptWeather'),
      regularHours:             $val('rptRegularHours'),
      overtimeHours:            $val('rptOvertimeHours'),
      doubleTimeHours:          $val('rptDoubleTimeHours'),
      iorName:                  $val('rptIorName'),
      projectManager:           $val('rptProjectManager'),
      architect:                $val('rptArchitect'),
      contractor:               $val('rptContractor'),
      manpower:                 $val('rptManpower'),
      equipment:                $val('rptEquipment'),
      trade:                    $val('rptTrade'),
      generalNotes:             $val('rptGeneralNotes'),
      inspectionActivities:     $val('rptInspectionActivities'),
      corrections:              $val('rptCorrections'),
      observationLettersIssued: $val('rptObservationLetters'),
      iorNotes:                 $val('rptIorNotes'),
      projectInspectorSignature:'',
      rfis:                     $val('rptRfis'),
      submittals:               $val('rptSubmittals'),
      ccds:                     $val('rptCcds'),
      asis:                     $val('rptAsis'),
      siteVisits:               $val('rptSiteVisits'),
      inspectionRequests:       [],
      contractorActivities:     [],
      sitePhotosPaths:          [],
      outputFileName:           outputFileName(num, date),
    };
  },

  // ---------- Save draft (matches Swift upsertReportRow) ----------

  async saveDraft() {
    if (!App.supabase || !App.user) return;
    const draft = Reports.buildDraft();

    try {
      // Check existing by user+job+date (same upsert logic as Swift)
      const { data: existing } = await App.supabase
        .from('reports').select('id')
        .eq('user_id', App.user.id)
        .eq('job_id', draft.jobId)
        .eq('report_date', draft.date);

      let reportId;
      if (existing?.length) {
        reportId = existing[0].id;
        const { error } = await App.supabase.from('reports').update({
          job_name: draft.jobName,
          report_number: draft.reportNumber,
          output_file_name: draft.outputFileName,
          status: 'draft',
          report_data: draft,
          updated_at: new Date().toISOString(),
        }).eq('id', reportId);
        if (error) throw error;
      } else {
        reportId = draft.id;
        const { error } = await App.supabase.from('reports').insert({
          id: reportId,
          user_id: App.user.id,
          job_id: draft.jobId,
          job_name: draft.jobName,
          report_number: draft.reportNumber,
          report_date: draft.date,
          output_file_name: draft.outputFileName,
          status: 'draft',
          report_data: draft,
        });
        if (error) throw error;
      }

      // RLS verification (matches Swift)
      const { data: check } = await App.supabase.from('reports').select('id').eq('id', reportId);
      if (!check?.length) { showToast('RLS blocked save — check Supabase policies'); return; }

      // Upload working copy JSON to storage (non-fatal, matches Swift)
      try {
        const path = 'working-copies/' + App.user.id + '/' + draft.jobId + '/' + reportId + '.json';
        await App.supabase.storage.from('report-working-copies')
          .upload(path, new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' }), { upsert: true });
        await App.supabase.from('reports').update({
          working_copy_path: path, updated_at: new Date().toISOString()
        }).eq('id', reportId);
      } catch (e) { console.warn('Storage upload (non-fatal):', e); }

      showToast('Draft saved');
      $set('rptId', reportId);
      $('deleteRptSection').classList.remove('hidden');
      await Reports.load(draft.jobId);
    } catch (e) {
      console.error('Reports.saveDraft:', e);
      showToast('Failed to save: ' + e.message);
    }
  },

  // ---------- Submit ----------

  async submit() {
    if (!confirm('Submit this report? It will be marked as final.')) return;
    await Reports.saveDraft();
    const id = $val('rptId');
    if (!id) return;
    try {
      const draft = Reports.buildDraft();
      await App.supabase.from('reports').update({
        status: 'submitted',
        output_file_name: draft.outputFileName,
        updated_at: new Date().toISOString(),
      }).eq('id', id);
      showToast('Report submitted');
      Reports.back();
      await Reports.load(draft.jobId);
    } catch (e) {
      console.error('Reports.submit:', e);
      showToast('Failed to submit');
    }
  },

  // ---------- Delete (cascade, matches Swift) ----------

  async deleteCurrent() {
    const id = $val('rptId');
    if (!id || !confirm('Delete this report permanently?')) return;
    try {
      const rpt = App.reports.find(r => r.id === id);
      await App.supabase.from('reports').delete().eq('id', id);

      // RLS verification
      const { data: check } = await App.supabase.from('reports').select('id').eq('id', id);
      if (check?.length) { showToast('Delete blocked by RLS'); return; }

      // Cascade storage cleanup (non-fatal, matches Swift)
      const buckets = [
        ['report-working-copies', rpt?.working_copy_path],
        ['report-source-docs',    rpt?.source_doc_path],
        ['report-submitted',      rpt?.submitted_pdf_path],
      ];
      for (const [bucket, path] of buckets) {
        if (path) try { await App.supabase.storage.from(bucket).remove([path]); } catch(e) {}
      }

      showToast('Report deleted');
      Reports.back();
      if (App.job) await Reports.load(App.job.id);
    } catch (e) {
      console.error('Reports.delete:', e);
      showToast('Failed to delete');
    }
  },

  // ---------- View submitted report ----------

  renderView(rpt, d) {
    d = d || {};
    const v = (cc, sc) => d[cc] || d[sc] || '';
    const sect = (title, fields) => {
      const rows = fields.filter(([,val]) => val).map(([lbl, val]) => `<strong>${lbl}:</strong> ${esc(val)}`).join('<br>');
      return rows ? `<div class="form-sect"><div class="form-sect-title">${title}</div><div style="font-size:14px;color:#ccc;line-height:1.8">${rows}</div></div>` : '';
    };
    $('viewRptContent').innerHTML = `<div class="card">
      <div class="card-header"><h3>Report #${rpt.report_number||'—'}</h3><span class="report-status status-submitted">Submitted</span></div>
      <div class="form-sect"><div class="form-sect-title">Report Info</div>
        <div style="font-size:14px;color:#ccc;line-height:1.8"><strong>Date:</strong> ${fmtDate(rpt.report_date)}<br><strong>File:</strong> ${esc(rpt.output_file_name||'')}</div>
      </div>
      ${sect('Project Information',[['Project Name',v('projectName','project_name')],['Project #',v('projectNumber','project_number')],['District',d.jurisdiction],['DSA #',v('dsaFileNumber','dsa_file_number')],['Address',v('projectAddress','project_address')],['Weather',d.weather]])}
      ${sect('Hours',[['Regular',v('regularHours','regular_hours')],['Overtime',v('overtimeHours','overtime_hours')],['Double Time',v('doubleTimeHours','double_time_hours')]])}
      ${sect('Team',[['IOR',v('iorName','ior_name')],['PM',v('projectManager','project_manager')],['Architect',d.architect],['Contractor',d.contractor]])}
      ${sect('Contractor Activity',[['Manpower',d.manpower],['Equipment',d.equipment],['Trade',d.trade]])}
      ${sect('Inspection Content',[['General Notes',v('generalNotes','general_notes')],['Activities',v('inspectionActivities','inspection_activities')],['Corrections',d.corrections],['Observation Letters',v('observationLettersIssued','observation_letters_issued')],['IOR Notes',v('iorNotes','ior_notes')]])}
      ${sect('Inspection Requests',[['RFIs',d.rfis],['Submittals',d.submittals],['CCDs',d.ccds],['ASIs',d.asis],['Site Visits',v('siteVisits','site_visits')]])}
    </div>`;
  },

  back() { App.job ? nav('job-detail') : nav('home'); },

  // ---------- Photos ----------

  handlePhotos(input) {
    Array.from(input.files).forEach(f => {
      if (f.size > 10*1024*1024) { showToast(f.name + ' too large'); return; }
      Reports.photos.push(f);
    });
    Reports.renderPhotos();
    input.value = '';
  },

  renderPhotos() {
    const g = $('rptPhotoGrid'); g.innerHTML = '';
    Reports.photos.forEach((f, i) => {
      const el = document.createElement('div'); el.className = 'file-thumb';
      const img = document.createElement('img'); img.src = URL.createObjectURL(f); el.appendChild(img);
      const btn = document.createElement('button'); btn.className = 'rm-btn'; btn.innerHTML = '×';
      btn.onclick = () => { Reports.photos.splice(i,1); Reports.renderPhotos(); };
      el.appendChild(btn); g.appendChild(el);
    });
  },
};
