/** Local-only full-token comparison fixtures; never deployed by the product. */
import { readFileSync } from 'node:fs';
import solc from 'solc';
import type { Abi, Hex } from 'viem';
import type { Mirror } from '../../../../scenarios/lib.js';
export async function installVariant(m: Mirror, variant: string) {
  if (!m.devnet || !m.devnet.rpcUrl.startsWith('http://127.0.0.1:')) throw new Error('owned local Anvil only');
  const source = readFileSync(`evidence/audit/governance-nav/retention/${variant === 'a' ? 'EpochLots' : variant === 'legacy' ? 'Monolithic' : 'Eager'}.sol.txt`, 'utf8');
  const sources: Record<string, {content: string}> = { 'contracts/NavShareToken.sol': { content: source } };
  if (variant === 'b') {
    let baal = readFileSync('contracts/vendor/Baal.sol', 'utf8');
    baal = baal.replace('interface IZeroOneShares {', 'interface IZeroOneShares {\n    function closeProposal(uint256 id) external;');
    baal = baal.replace('        emit ProcessProposal(id,', '        IZeroOneShares(address(sharesToken)).closeProposal(id); // ZERO ONE: eager fixture cleanup\n        emit ProcessProposal(id,');
    baal = baal.replace('        emit CancelProposal(id);', '        IZeroOneShares(address(sharesToken)).closeProposal(id); // ZERO ONE: eager fixture cleanup\n        emit CancelProposal(id);');
    sources['contracts/vendor/Baal.sol'] = { content: baal };
  }
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: { evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }), { import: (p: string) => { for (const f of [p, `node_modules/${p}`]) { try { return { contents: readFileSync(f, 'utf8') }; } catch {} } return { error: p }; } }));
  if ((out.errors ?? []).some((e: any) => e.severity === 'error')) throw new Error(JSON.stringify(out.errors));
  const a = out.contracts['contracts/NavShareToken.sol'].NavShareToken;
  const c = m.actors.F;
  const hash = await c.walletClient.deployContract({ abi: a.abi as Abi, bytecode: `0x${a.evm.bytecode.object}` as Hex, args: ['Comparison', 'CMP', m.dao.baal, m.dao.safe, m.dao.settlement], account: c.account, chain: c.chain });
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('variant deploy failed');
  const code = await c.publicClient.getCode({ address: receipt.contractAddress });
  await c.publicClient.request({ method: 'anvil_setCode', params: [m.dao.shares, code] } as never);
  if (await c.publicClient.getCode({ address: m.dao.shares }) !== code) throw new Error('runtime readback mismatch');
  if (variant === 'b') {
    const b = out.contracts['contracts/vendor/Baal.sol'].Baal;
    const tx = await c.walletClient.deployContract({ abi: b.abi as Abi, bytecode: `0x${b.evm.bytecode.object}` as Hex, account: c.account, chain: c.chain });
    const r = await c.publicClient.waitForTransactionReceipt({ hash: tx });
    if (r.status !== 'success' || !r.contractAddress) throw new Error('Baal fixture deploy');
    const runtime = await c.publicClient.getCode({ address: r.contractAddress });
    await c.publicClient.request({ method: 'anvil_setCode', params: [m.dao.baal, runtime] } as never);
    if (await c.publicClient.getCode({address:m.dao.baal}) !== runtime) throw new Error('Baal fixture readback');
    m.abi.baal = b.abi;
  }
  m.abi.shares = a.abi;
  console.log(`FIXTURE ${variant}: real compiled runtime installed in EMPTY local DAO; receipt=${hash}`);
}
