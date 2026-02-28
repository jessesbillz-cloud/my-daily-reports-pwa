// ===== JOBS CRUD =====
async function loadJobs() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    currentJobs = data || [];
    renderJobs();
  } catch (e) {
    console.error('loadJobs:', e);
    showToast('Failed to load jobs');
  }
}

function renderJobs() {
  const active = currentJobs.filter(j => !j.is_archived);
  const archived = currentJobs.filter(j => j.is_archived);

  const list = document.getElementById('jobsList');
  if (active.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🏗️</div><div class="empty-state-text">No jobs yet. Create your first job to get started.</div></div>';
  } else {
    list.innerHTML = active.map(j => `
      <div class="job-item" onclick="openJob('${j.id}')">
        <div class="job-icon">🏗️</div>
        <div class="job-info">
          <div class="job-name">${esc(j.name)}</div>
          <div class="job-address">${esc(j.site_address || 'No address')}</div>
        </div>
        <div class="job-arrow">›</div>
      </div>
    `).join('');
  }

  const archSection = document.getElementById('archivedSection');
  if (archived.length > 0) {
    archSection.classList.remove('hidden');
    document.getElementById('archivedJobsList').innerHTML = archived.map(j => `
      <div class="job-item" onclick="openJob('${j.id}')">
        <div class="job-icon" style="opacity:0.5;">🏗️</div>
        <div class="job-info">
          <div class="job-name" style="opacity:0.6;">${esc(j.name)}</div>
          <div class="job-address">${esc(j.site_address || '')}</div>
        </div>
        <div class="job-badge">Archived</div>
      </div>
    `).join('');
  } else {
    archSection.classList.add('hidden');
  }
}

function openJob(jobId) {
  currentJob = currentJobs.find(j => j.id === jobId);
  if (!currentJob) return;
  document.getElementById('jobDetailName').textContent = currentJob.name;
  document.getElementById('jobDetailAddress').textContent = currentJob.site_address || '';
  navigate('job-detail');
  switchJobTab('reports');
  loadReports(jobId);
  loadScheduleData();
}

function editCurrentJob() {
  if (!currentJob) return;
  editJob(currentJob.id);
}

function editJob(jobId) {
  const job = currentJobs.find(j => j.id === jobId);
  if (!job) return;
  document.getElementById('editJobId').value = job.id;
  document.getElementById('jobFormTitle').textContent = 'Edit Job';
  document.getElementById('jobName').value = job.name || '';
  document.getElementById('jobAddress').value = job.site_address || '';
  document.getElementById('jobHoursBudget').value = job.hours_budget || '';
  document.getElementById('jobFilenamePattern').value = job.report_filename_pattern || '';
  document.getElementById('jobExportDest').value = job.export_destination || '';
  document.getElementById('jobTemplatePath').value = job.template_path || '';
  document.getElementById('saveJobBtn').textContent = 'Update Job';
  document.getElementById('deleteJobSection').classList.remove('hidden');
  navigate('create-job');
}

async function saveJob() {
  if (!supabase) return;
  const name = document.getElementById('jobName').value.trim();
  if (!name) { showToast('Job name is required'); return; }

  const jobData = {
    name,
    site_address: document.getElementById('jobAddress').value.trim() || null,
    hours_budget: parseInt(document.getElementById('jobHoursBudget').value) || null,
    report_filename_pattern: document.getElementById('jobFilenamePattern').value.trim() || null,
    export_destination: document.getElementById('jobExportDest').value.trim() || null,
    template_path: document.getElementById('jobTemplatePath').value.trim() || null,
  };

  const editId = document.getElementById('editJobId').value;
  try {
    if (editId) {
      const { error } = await supabase.from('jobs').update(jobData).eq('id', editId);
      if (error) throw error;
      showToast('Job updated');
    } else {
      jobData.is_archived = false;
      const { error } = await supabase.from('jobs').insert(jobData);
      if (error) throw error;
      showToast('Job created');
    }
    await loadJobs();
    navigate('home');
  } catch (e) {
    console.error('saveJob:', e);
    showToast('Failed to save job: ' + e.message);
  }
}

async function archiveJob() {
  const id = document.getElementById('editJobId').value;
  if (!id || !confirm('Archive this job?')) return;
  try {
    await supabase.from('jobs').update({ is_archived: true }).eq('id', id);
    showToast('Job archived');
    await loadJobs();
    navigate('home');
  } catch (e) {
    showToast('Failed to archive job');
  }
}

function resetJobForm() {
  document.getElementById('editJobId').value = '';
  document.getElementById('jobFormTitle').textContent = 'New Job';
  document.getElementById('jobName').value = '';
  document.getElementById('jobAddress').value = '';
  document.getElementById('jobHoursBudget').value = '';
  document.getElementById('jobFilenamePattern').value = '';
  document.getElementById('jobExportDest').value = '';
  document.getElementById('jobTemplatePath').value = '';
  document.getElementById('saveJobBtn').textContent = 'Create Job';
  document.getElementById('deleteJobSection').classList.add('hidden');
}

function switchJobTab(tab) {
  document.querySelectorAll('#jobTabBar .tab')[0].classList.toggle('active', tab === 'reports');
  document.querySelectorAll('#jobTabBar .tab')[1].classList.toggle('active', tab === 'schedule');
  document.getElementById('jobReportsTab').classList.toggle('hidden', tab !== 'reports');
  document.getElementById('jobScheduleTab').classList.toggle('hidden', tab !== 'schedule');
  if (tab === 'schedule') loadScheduleData();
}
