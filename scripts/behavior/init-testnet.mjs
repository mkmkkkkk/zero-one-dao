/** Fresh G3 actors only. No existing account is used as promisor/oracle. */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http } from 'viem';
import { execFileSync } from 'node:child_process';
import { PYTHON, save } from './bond.mjs';
mkdirSync('state/g3/keys', { recursive: true, mode: 0o700 });
const addresses = {};
for (const role of ['promisor', 'oracle', 'beneficiary']) {
  const file = `state/g3/keys/${role}.key`;
  if (!existsSync(file)) writeFileSync(file, generatePrivateKey(), { mode: 0o600, flag: 'wx' });
  addresses[role] = privateKeyToAccount(readFileSync(file, 'utf8').trim()).address;
}
const p = createPublicClient({ transport: http('https://sepolia.base.org') });
if (await p.getChainId() !== 84532) throw Error('not Sepolia');
const now = Number((await p.getBlock()).timestamp);
save('evidence/g3/actors.json', addresses);
console.log(execFileSync(PYTHON, ['scripts/behavior/prepare.py', '--promisor', addresses.promisor,
  '--oracle', addresses.oracle, '--beneficiary', addresses.beneficiary, '--starts', String(now),
  '--expires', String(now + 3600), '--id', 'g3-schema-replay-example', '--out', 'evidence/g3/example.contract.json'], { encoding: 'utf8' }));
