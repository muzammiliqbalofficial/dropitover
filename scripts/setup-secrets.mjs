// One-shot secret setup.
//
// `wrangler secret put NAME` takes the secret's *name* as its argument and the
// *value* on stdin — easy to get backwards, which leaves a Worker full of oddly
// named, empty secrets. This asks for what it needs, generates what it can, and
// stores everything under the exact names the Worker reads.
//
//   npm run setup

import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { stdin, stdout } from 'node:process';

/** Pipes `value` into `wrangler secret put <name>` so no prompt is involved. */
function putSecret(name, value) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['wrangler', 'secret', 'put', name], {
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: true,
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`wrangler exited with code ${code}`))
    );
    child.stdin.write(`${value}\n`);
    child.stdin.end();
  });
}

const rl = createInterface({ input: stdin, output: stdout });

console.log('\nDropItOver — secret setup\n');

try {
  const secrets = [];

  // The encryption key never needs a human: generate it here.
  secrets.push({ name: 'MASTER_KEY', value: randomBytes(32).toString('hex'), note: 'generated' });
  console.log('  MASTER_KEY      generated (32 random bytes — never shown, never stored on disk)');
  console.log('                  Files encrypted with an older key become unreadable. That is');
  console.log('                  expected on a fresh Worker with nothing stored yet.\n');

  console.log('  TURN relay lets rooms work across different networks (phone data <-> Wi-Fi).');
  console.log('  Get these from: Cloudflare dashboard -> Realtime -> TURN Keys');
  console.log('  Press Enter on both to skip — everything else still works.\n');

  const keyId = (await rl.question('  TURN Key ID (Enter to skip): ')).trim();
  const token = keyId ? (await rl.question('  TURN API Token: ')).trim() : '';
  console.log('');

  if (keyId && token) {
    secrets.push({ name: 'TURN_KEY_ID', value: keyId });
    secrets.push({ name: 'TURN_API_TOKEN', value: token });
  } else if (keyId && !token) {
    console.error('  Key ID given but no token — skipping TURN. Run this again to set both.\n');
  } else {
    console.log('  Skipping TURN. Rooms will work on the same Wi-Fi; across networks they may not.\n');
  }

  rl.close();

  for (const secret of secrets) {
    console.log(`Storing ${secret.name}…`);
    await putSecret(secret.name, secret.value);
  }

  console.log('\nDone — secrets apply immediately, no redeploy needed.');
  console.log('Check it worked: open /api/health on your site.');
  console.log('It should say "encryptionKey":"ok".\n');
} catch (err) {
  rl.close();
  console.error(`\nSetup failed: ${err.message}`);
  console.error('Nothing else was changed. Run `npm run setup` again to retry.\n');
  process.exit(1);
}
