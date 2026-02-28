// ===== APP INIT =====
window.addEventListener('DOMContentLoaded', function () {
  const config = getSupabaseConfig();
  if (config.url && config.key) {
    initSupabase(config.url, config.key);
  } else {
    showAuthView();
  }
});
