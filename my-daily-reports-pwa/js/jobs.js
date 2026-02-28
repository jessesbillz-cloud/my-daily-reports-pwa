// =============================================
//  jobs.js — Jobs CRUD
// =============================================

const Jobs = {

  async load() {
    if (!App.supabase) return;
    try {
      const { data, error } = await App.supabase
        .from('jobs').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      App.jobs = data || [];
      Jobs.render();
    } catch (e) {
      console.error('Jobs.load:', e);
      showToast('Failed to load jobs');
    }
  },

  render() {
    const active   = App.jobs.filter(j => !j.is_archived);
    const archived = App.jobs.filter(j =>  j.is_archived);

    const list = $('jobsList');
    if (!active.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">🏗️</div><div class="empty-text">No jobs yet. Create your first job to get started.</div></div>';
    } else {
      list.innerHTML = active.map(j => `
        <div class="job-item" onclick="Jobs.open('${j.id}')">
          <div class="job-icon">🏗️</div>
          <div class="job-info">
            <div class="job-name">${esc(j.name)}</div>
            <div class="job-addr">${esc(j.site_address || 'No address')}</div>
          </div>
          <div class="job-arrow">›</div>
        </div>`).join('');
    }

    const sec = $('archivedSection');
    if (archived.length) {
      sec.classList.remove('hidden');
      $('archivedJobsList').innerHTML = archived.map(j => `
        <div class="job-item" onclick="Jobs.open('${j.id}')">
          <div class="job-icon" style="opacity:.5">🏗️</div>
          <div class="job-info">
            <div class="job-name" style="opacity:.6">${esc(j.name)}</div>
            <div class="job-addr">${esc(j.site_address || '')}</div>
          </div>
          <div class="job-badge">Archived</div>
        </div>`).join('');
    } else {
      sec.classList.add('hidden');
    }
  },

  open(id) {
    App.job = App.jobs.find(j => j.id === id);
    if (!App.job) return;
    $('jobDetailName').textContent = App.job.name;
    $('jobDetailAddr').textContent = App.job.site_address || '';
    nav('job-detail');
    Jobs.switchTab('reports');
    Reports.load(id);
    Schedule.loadData();
  },

  switchTab(tab) {
    const tabs = document.querySelectorAll('#jobTabBar .tab');
    tabs[0].classList.toggle('active', tab === 'reports');
    tabs[1].classList.toggle('active', tab === 'schedule');
    $('jobReportsTab').classList.toggle('hidden', tab !== 'reports');
    $('jobScheduleTab').classList.toggle('hidden', tab !== 'schedule');
    if (tab === 'schedule') Schedule.loadData();
  },

  edit() {
    if (!App.job) return;
    $set('editJobId', App.job.id);
    $('jobFormTitle').textContent = 'Edit Job';
    $set('jobName', App.job.name);
    $set('jobAddress', App.job.site_address);
    $set('jobHoursBudget', App.job.hours_budget);
    $set('jobFilenamePattern', App.job.report_filename_pattern);
    $set('jobExportDest', App.job.export_destination);
    $set('jobTemplatePath', App.job.template_path);
    $('saveJobBtn').textContent = 'Update Job';
    $('deleteJobSection').classList.remove('hidden');
    nav('create-job');
  },

  async save() {
    if (!App.supabase) return;
    const name = $val('jobName');
    if (!name) { showToast('Job name is required'); return; }

    const data = {
      name,
      site_address:             $val('jobAddress') || null,
      hours_budget:             parseInt($val('jobHoursBudget')) || null,
      report_filename_pattern:  $val('jobFilenamePattern') || null,
      export_destination:       $val('jobExportDest') || null,
      template_path:            $val('jobTemplatePath') || null,
    };

    const editId = $val('editJobId');
    try {
      if (editId) {
        const { error } = await App.supabase.from('jobs').update(data).eq('id', editId);
        if (error) throw error;
        showToast('Job updated');
      } else {
        data.is_archived = false;
        const { error } = await App.supabase.from('jobs').insert(data);
        if (error) throw error;
        showToast('Job created');
      }
      await Jobs.load();
      nav('home');
    } catch (e) {
      console.error('Jobs.save:', e);
      showToast('Failed to save: ' + e.message);
    }
  },

  async archive() {
    const id = $val('editJobId');
    if (!id || !confirm('Archive this job?')) return;
    try {
      await App.supabase.from('jobs').update({ is_archived: true }).eq('id', id);
      showToast('Job archived');
      await Jobs.load();
      nav('home');
    } catch (e) {
      showToast('Failed to archive');
    }
  },

  resetForm() {
    $set('editJobId', '');
    $('jobFormTitle').textContent = 'New Job';
    ['jobName','jobAddress','jobHoursBudget','jobFilenamePattern','jobExportDest','jobTemplatePath']
      .forEach(id => $set(id, ''));
    $('saveJobBtn').textContent = 'Create Job';
    $('deleteJobSection').classList.add('hidden');
  },
};
