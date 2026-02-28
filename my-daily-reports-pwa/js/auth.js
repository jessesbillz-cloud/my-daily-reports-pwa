// ===== AUTH =====
function initSupabase(url, key) {
  supabase = window.supabase.createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });

  supabase.auth.getSession().then(({ data: { session } }) => {
    if (session) {
      currentUser = session.user;
      showAppView();
      loadJobs();
    } else {
      showAuthView();
    }
  });

  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session) {
      currentUser = session.user;
      showAppView();
      loadJobs();
    } else if (event === 'SIGNED_OUT') {
      currentUser = null;
      showAuthView();
    }
  });
}

function showAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t, i) => {
    t.classList.toggle('active', (tab === 'login' && i === 0) || (tab === 'signup' && i === 1));
  });
  document.getElementById('authLoginForm').classList.toggle('hidden', tab !== 'login');
  document.getElementById('authSignupForm').classList.toggle('hidden', tab !== 'signup');
  document.getElementById('authError').textContent = '';
}

async function signInWithGoogle() {
  if (!supabase) { showSetupModal(); return; }
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname }
  });
  if (error) document.getElementById('authError').textContent = error.message;
}

async function signInWithEmail() {
  if (!supabase) { showSetupModal(); return; }
  const email = document.getElementById('authEmail').value.trim();
  const pass = document.getElementById('authPassword').value;
  if (!email || !pass) { document.getElementById('authError').textContent = 'Enter email and password'; return; }
  const btn = document.getElementById('authSubmitBtn');
  btn.disabled = true; btn.textContent = 'Signing in...';
  const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
  btn.disabled = false; btn.textContent = 'Sign In';
  if (error) document.getElementById('authError').textContent = error.message;
}

async function signUpWithEmail() {
  if (!supabase) { showSetupModal(); return; }
  const name = document.getElementById('signupName').value.trim();
  const email = document.getElementById('signupEmail').value.trim();
  const pass = document.getElementById('signupPassword').value;
  if (!email || !pass) { document.getElementById('authError').textContent = 'Enter email and password'; return; }
  const { error } = await supabase.auth.signUp({
    email, password: pass,
    options: { data: { full_name: name } }
  });
  if (error) document.getElementById('authError').textContent = error.message;
  else showToast('Check your email to confirm your account');
}

async function signOut() {
  if (supabase) await supabase.auth.signOut();
  currentUser = null;
  showAuthView();
}

function showAuthView() {
  document.getElementById('authView').classList.remove('hidden');
  document.getElementById('appView').classList.add('hidden');
}

function showAppView() {
  document.getElementById('authView').classList.add('hidden');
  document.getElementById('appView').classList.remove('hidden');
  const name = currentUser?.user_metadata?.full_name || currentUser?.email || '';
  document.getElementById('headerUserName').textContent = name;
  document.getElementById('settingsName').textContent = currentUser?.user_metadata?.full_name || '—';
  document.getElementById('settingsEmail').textContent = currentUser?.email || '—';
  const config = getSupabaseConfig();
  document.getElementById('settingsSupabaseUrl').value = config.url;
  document.getElementById('settingsSupabaseKey').value = config.key;
}

function saveSupabaseConfig() {
  const url = document.getElementById('settingsSupabaseUrl').value.trim();
  const key = document.getElementById('settingsSupabaseKey').value.trim();
  if (!url || !key) { showToast('Please enter both URL and key'); return; }
  localStorage.setItem('mdr_supabase_url', url);
  localStorage.setItem('mdr_supabase_key', key);
  initSupabase(url, key);
  showToast('Supabase reconnected');
}
