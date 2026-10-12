export function seed(db) {
  const setSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  );
  setSetting.run('demo_mode', 'true');
  setSetting.run('telephony_provider', 'none');
  setSetting.run('live_enabled', 'false');
}