import 'dotenv/config';
import readline from 'node:readline';
import bcrypt from 'bcryptjs';
import { config } from '../src/config.js';
import { createDb } from '../src/db/db.js';

async function hiddenQuestion(rl, query) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const onData = (char) => {
      char += '';
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.removeListener('data', onData);
      } else {
        rl.output.write('*');
      }
    };
    stdin.on('data', onData);
    rl.question(query, (value) => {
      rl.history = rl.history.slice(1);
      resolve(value);
    });
  });
}

function fail(message) {
  console.error(`reset-operator: ${message}`);
  process.exit(1);
}

if (!config.demoMode) {
  fail('demo mode is off; refused to run the local reset helper.');
}

const db = createDb(config.dbPath);
try {
  const user = db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get();
  if (!user) {
    fail(
      'no operator account exists. Start the app and create one via POST /api/auth/setup (first-run setup).'
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(
    `This resets the password for operator "${user.username}" and invalidates all of their sessions.`
  );
  console.log('Run it only on the machine that hosts the ApexDialer database.');

  const password = await hiddenQuestion(rl, 'New password (min 12, max 72 characters): ');
  const confirm = await hiddenQuestion(rl, 'Confirm new password: ');
  rl.close();

  if (password.length < 12 || password.length > 72) {
    fail('password must be between 12 and 72 characters.');
  }
  if (password !== confirm) {
    fail('passwords do not match.');
  }

  const tx = db.transaction(() => {
    const hash = bcrypt.hashSync(password, config.auth.bcryptRounds);
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(
      hash,
      user.id
    );
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    db.prepare(
      "INSERT INTO audit_log (actor, action, entity_type, entity_id, details) VALUES ('reset-operator', 'password_reset', 'user', ?, '{}')"
    ).run(String(user.id));
  });
  tx();

  console.log(`Password for "${user.username}" reset. All existing sessions were invalidated; log in again.`);
} finally {
  db.close();
}