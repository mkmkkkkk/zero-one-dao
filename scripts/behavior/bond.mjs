/** Testnet-only clients for the standalone G3 bond; no live relay mutation. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import solc from 'solc';

export const PYTHON = 'state/g3/venv/bin/python';
export const sha = bytes => '0x' + createHash('sha256').update(bytes).digest('hex');
export const read = file => JSON.parse(readFileSync(file, 'utf8'));
export const save = (file, value) => writeFileSync(file, JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v, 2) + '\n');
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
export function compileBond(source = readFileSync('contracts/BehaviorBond.sol', 'utf8')) {
  const input = { language: 'Solidity', sources: { 'BehaviorBond.sol': { content: source } }, settings: {
    evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } }
  }};
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw Error(errors.map(e => e.formattedMessage).join('\n'));
  const artifact = out.contracts['BehaviorBond.sol'].BehaviorBond;
  return { abi: artifact.abi, bytecode: '0x' + artifact.evm.bytecode.object, compiler: solc.version(), sourceSha256: sha(source) };
}
export async function clients(rpc, chainId, key) {
  if (![31337, 84532].includes(chainId)) throw Error('testnet only');
  const url = new URL(rpc);
  if (chainId === 84532 && rpc !== 'https://sepolia.base.org') throw Error('fixed Sepolia RPC only');
  if (chainId === 31337 && url.hostname !== '127.0.0.1') throw Error('local tests require loopback');
  const chain = defineChain({ id: chainId, name: 'G3 testnet', nativeCurrency: { name: 'test ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const transport = http(rpc, { timeout: 20000, retryCount: 2 });
  const pub = createPublicClient({ chain, transport, cacheTime: 0 });
  if (await pub.getChainId() !== chainId) throw Error('RPC chain mismatch');
  const account = privateKeyToAccount(key);
  return { pub, wallet: createWalletClient({ chain, account, transport }), account, chain };
}
export async function receipt(pub, hash) {
  await pub.waitForTransactionReceipt({ hash, confirmations: pub.chain.id === 31337 ? 1 : 2, timeout: 120000, pollingInterval: 1000 });
  // Base RPC may briefly expose preconfirmed receipts with a zero block hash.
  // Require a receipt anchored to a real block before calling it confirmed.
  for (let attempt = 0; attempt < 60; attempt++) {
    const r = await pub.getTransactionReceipt({ hash });
    if (r.status !== 'success') throw Error('transaction reverted: ' + hash);
    if (r.blockHash !== '0x' + '0'.repeat(64)) {
      const block = await pub.getBlock({ blockNumber: r.blockNumber });
      if (block.hash === r.blockHash) return r;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw Error('no canonical receipt yet; recover recorded hash: ' + hash);
}
export async function deploy(ctx, artifact, contract, hash, broadcast = () => {}) {
  const tx = await ctx.wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode,
    args: [hash, contract.beneficiary, contract.oracle.address, BigInt(contract.starts_at), BigInt(contract.expires_at), BigInt(contract.dispute.seconds)],
    value: BigInt(contract.bond.amount_wei) });
  broadcast(tx);
  return receipt(ctx.pub, tx);
}
export async function write(ctx, artifact, address, functionName, args = [], broadcast = () => {}) {
  const request = await ctx.pub.simulateContract({ account: ctx.account, address, abi: artifact.abi, functionName, args });
  const tx = await ctx.wallet.writeContract(request.request);
  broadcast(tx);
  return receipt(ctx.pub, tx);
}
export async function checkBinding(ctx, artifact, address, c, hash) {
  const expected = { contractHash: hash, promisor: c.promisor, beneficiary: c.beneficiary, oracle: c.oracle.address,
    bond: c.bond.amount_wei, startsAt: c.starts_at, expiresAt: c.expires_at, disputeSeconds: c.dispute.seconds };
  for (const [functionName, value] of Object.entries(expected)) {
    const actual = await ctx.pub.readContract({ address, abi: artifact.abi, functionName });
    if (String(actual).toLowerCase() !== String(value).toLowerCase()) throw Error('on-chain binding mismatch: ' + functionName);
  }
}
export function replay(file, out, inject = false) {
  const c = read(file);
  const stdout = execFileSync(PYTHON, ['scripts/behavior/adjudicate.py', file, '--artifact', c.patch.artifact,
    '--out', out, ...(inject ? ['--inject-drift'] : [])], { encoding: 'utf8', timeout: 90000 });
  const result = JSON.parse(stdout);
  const evidence = read(out + '/evidence.json');
  if (result.evidence_hash !== sha(readFileSync(out + '/evidence.json')) || evidence.contract_sha256 !== sha(canonical(c)) || result.verdict !== evidence.verdict) throw Error('evidence binding mismatch');
  return result;
}

export function validateFile(file) {
  execFileSync(PYTHON, ['-c', "import json,sys; sys.path.insert(0,'scripts/behavior'); from adjudicate import validate; validate(json.load(open(sys.argv[1])))", file], { stdio: 'pipe' });
}
