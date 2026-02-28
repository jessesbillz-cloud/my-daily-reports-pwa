// =============================================
//  auth.js — authentication
// =============================================

const Auth = {

  initSupabase(url, key) {
    App.supabase = window.supabase.createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

    App.supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        App.user = session.user;
        Auth.showApp();
        Jobs.load();
      } else {
        Auth.showLogin();
      }
    });

    App.supabase.auth.onAuthStateChange((evt, session) => {
      if (evt === 'SIGNED_IN' && session) {
        App.user = session.user;
        Auth.showApp();
        Jobs.load();
      } else if (evt === 'SIGNED_OUT') {
        App.user = null;
        Auth.showLogin();
      }
    });
  },

  showLogin() {
    $('authView').classList.remove('hidden');
    $('appView').classList.add('hidden');
  },

  showApp() {
    $('authView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    const name = App.user?.user_metadata?.full_name || App.user?.email || '';
    $('headerUserName').textContent = name;
    $('settingsName').textContent = App.user?.user_metadata?.full_name || '—';
    $('settingsEmail').textContent = App.user?.email || '—';
    const c = Config.get();
    $set('settingsUrl', c.url);
    $set('settingsKey', c.key);
  },

  tabSwitch(tab) {
    document.querySelectorAll('.auth-tab').forEach((t, i) => {
      t.classList.toggle('active', (tab === 'login' && i === 0) || (tab === 'signup' && i === 1));
    });
    $('authLoginForm').classList.toggle('hidden', tab !== 'login');
    $('authSignupForm').classList.toggle('hidden', tab !== 'signup');
    $('authError').textContent = '';
  },

  async google() {
    if (!App.supabase) { showSetupModal(); return; }
    const { error } = await App.supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (error) $('authError').textContent = error.message;
  },

  async emailLogin() {
    if (!App.supabase) { showSetupModal(); return; }
    const email = $val('authEmail'), pass = $('authPassword').value;
    if (!email || !pass) { $('authError').textContent = 'Enter email and password'; return; }
    const btn = $('authSubmitBtn');
    btn.disabled = true; btn.textContent = 'Signing in…';
    const { error } = await App.supabase.auth.signInWithPassword({ email, password: pass });
    btn.disabled = false; btn.textContent = 'Sign In';
    if (error) $('authError').textContent = error.message;
  },

  async emailSignup() {
    if (!App.supabase) { showSetupModal(); return; }
    const name = $val('signupName'), email = $val('signupEmail'), pass = $('signupPassword').value;
    if (!email || !pass) { $('authError').textContent = 'Enter email and password'; return; }
    const { error } = await App.supabase.auth.signUp({
      email, password: pass,
      options: { data: { full_name: name } },
    });
    if (error) $('authError').textContent = error.message;
    else showToast('Check your email to confirm');
  },

  async signOut() {
    if (App.supabase) await App.supabase.auth.signOut();
    App.user = null;
    Auth.showLogin();
  },

  saveConfig() {
    const url = $val('settingsUrl'), key = $val('settingsKey');
    if (!url || !key) { showToast('Both fields required'); return; }
    Config.set(url, key);
    Auth.initSupabase(url, key);
    showToast('Reconnected');
  },
};
