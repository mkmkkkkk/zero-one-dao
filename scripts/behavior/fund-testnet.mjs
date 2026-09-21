/** Use only the documented Sepolia faucet/deployer key, never mainnet or relay keys. */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createPublicClient, http } from 'viem';
import { clients, receipt, read, save } from './bond.mjs';
const rpc = 'https://sepolia.base.org';
const pub = createPublicClient({ transport: http(rpc), cacheTime: 0 });
if (await pub.getChainId() !== 84532) throw Error('Sepolia chain guard');
const keyFile = homedir() + '/srv/aow-exit/.env.sepolia';
const line = readFileSync(keyFile, 'utf8').split(/\r?\n/).find(v => /^ANCHOR_PRIVATE_KEY\s*=/.test(v));
if (!line) throw Error('documented Sepolia key missing');
const value = line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
const ctx = await clients(rpc, 84532, value.startsWith('0x') ? value : '0x' + value);
if (ctx.account.address.toLowerCase() !== '0x71208dbf8dd681c5fc2998c8192b633677bfcc10') throw Error('unexpected testnet donor');
const actors = read('evidence/g3/actors.json');
for (const role of ['promisor', 'oracle']) {
  const out = `evidence/g3/funding-${role}.json`;
  if (existsSync(out)) throw Error(out + ' already exists; inspect its receipt before retry');
  const before = { donor: await ctx.pub.getBalance({ address: ctx.account.address }), recipient: await ctx.pub.getBalance({ address: actors[role] }) };
  const hash = await ctx.wallet.sendTransaction({ to: actors[role], value: 10000000000000n });
  // Save broadcast before waiting so a timeout is never followed by blind duplicate funding.
  save(out, { chainId: 84532, donor: ctx.account.address, recipient: actors[role], amount_wei: '10000000000000', hash, before });
  const r = await receipt(ctx.pub, hash);
  const after = { donor: await ctx.pub.getBalance({ address: ctx.account.address, blockNumber: r.blockNumber }), recipient: await ctx.pub.getBalance({ address: actors[role], blockNumber: r.blockNumber }) };
  save(out, { chainId: 84532, donor: ctx.account.address, recipient: actors[role], amount_wei: '10000000000000', hash, before, after, receipt: r });
  console.log(JSON.stringify({ role, hash, before: String(before.recipient), after: String(after.recipient) }));
}
