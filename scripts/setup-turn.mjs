// Interactive TURN setup.
//
// `wrangler secret put NAME` takes the secret's *name* as its argument and the
// *value* on stdin — a distinction that is easy to get backwards and produces a
// Worker full of oddly named, empty secrets. This script asks for the two
// values and stores them under the exact names the Worker reads.
//
//   npm run setup:turn

import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { stdin, stdout } from 'node:process';

const SECRETS = [
  {
    name: 'TURN_KEY_ID',
    label: 'TURN Key ID',
    hint: 'Cloudflare dashboard -> Realtime -> TURN Keys -> your key',
  },
  {
    name: 'TURN_API_TOKEN',
    label: 'TURN API Token',
    hint: 'shown once when the key was created; make a new key if you lost it',
  },
];

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

console.log('\nDropItOver — TURN setup');
console.log('Paste each value and press Enter. Nothing is written to disk.\n');

try {
  const values = [];

  for (const secret of SECRETS) {
    console.log(`  ${secret.hint}`);
    const answer = (await rl.question(`  ${secret.label}: `)).trim();
    console.log('');

    if (!answer) {
      console.error(`Nothing entered for ${secret.label}. Stopping — no secrets were changed.`);
      process.exit(1);
    }
    values.push({ ...secret, value: answer });
  }

  rl.close();

  for (const secret of values) {
    console.log(`Storing ${secret.name}…`);
    await putSecret(secret.name, secret.value);
  }

  console.log('\nDone. Both secrets are stored under the names the Worker reads.');
  console.log('Check it worked — this should say "hasTurn": true :\n');
  console.log('  npx wrangler deployments list   (optional)');
  console.log('  then open  /api/config  on your site\n');
} catch (err) {
  rl.close();
  console.error(`\nSetup failed: ${err.message}`);
  console.error('Nothing else was changed. Run `npm run setup:turn` again to retry.\n');
  process.exit(1);
}
