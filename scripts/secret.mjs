// Fills in AGENT_SECRET in .env with a random value (once).
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const env = readFileSync('.env', 'utf8');
if (/^AGENT_SECRET=\S/m.test(env)) {
  console.log('AGENT_SECRET is already set.');
} else {
  const secret = randomBytes(24).toString('hex');
  writeFileSync('.env', /^AGENT_SECRET=/m.test(env) ? env.replace(/^AGENT_SECRET=.*$/m, `AGENT_SECRET=${secret}`) : `${env}\nAGENT_SECRET=${secret}\n`);
  console.log('AGENT_SECRET set.');
}
