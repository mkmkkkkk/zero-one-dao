import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {attach} from './phase5-resume-fixture.js';
import {assert,deposit,fmt,processProposal,propose,ragequit,read,UNIT,usdcOf,vote,warpPastGrace} from './lib.js';
interface Row {
  id: string;
  expected: string;
  observed: string;
  ok: boolean;
  receipt?: string;
}
const rows: Row[] = [];
function row(id: string, expected: string, observed: string, ok: boolean, receipt?: string): void {
  rows.push({ id, expected, observed, ok, receipt });
  console.log(`   CASE ${id} | expected: ${expected} | observed: ${observed} | ${ok ? "OK" : "MISMATCH"}${receipt ? ` | receipt: ${receipt}` : ""}`);
}


const root='evidence/testnet/phase5',file=readdirSync(`${root}/scenario-daos`).filter(x=>x.startsWith('corner-votes-')).sort().at(-1)!;
const mirror=await attach(`${root}/scenario-daos/${file}`);
assert(await read<number>(mirror,'baal','proposalCount')===2 && await read<bigint>(mirror,'shares','totalSupply')===100n*UNIT,'resume unchanged 100-share fixture after reverted proposal submission');
const nav={treasury:await usdcOf(mirror,mirror.dao.safe),supply:await read<bigint>(mirror,'shares','totalSupply')};
const usdcFor=(shares:bigint)=>(shares*nav.treasury+nav.supply-1n)/nav.supply;
    const supply1 = await read<bigint>(mirror, "shares", "totalSupply");
    const bShares = await read<bigint>(mirror, "shares", "balanceOf", [mirror.actors.B.account.address]);
    const below = await propose(mirror, "F", [], "corner: retention 33.9% exits");
    await vote(mirror, "F", below.id, true);
    const exitBelow = await ragequit(mirror, "B", supply1 * 339n / 1000n);
    await warpPastGrace(mirror, below.id);
    const belowDone = await processProposal(mirror, "A", below);
    row("minRetention-33.9pct", "33.9% deficit leaves 66.1%, proposal passes", `burned ${exitBelow.burned}; supply ${supply1}; passed=${belowDone.info.status.passed}`, exitBelow.burned * 1000n === supply1 * 339n && belowDone.info.status.passed, belowDone.receipt.hash);
    await deposit(mirror, "B", exitBelow.paid);
    const boundary = await propose(mirror, "F", [], "corner: retention boundary 34% exits");
    await vote(mirror, "F", boundary.id, true);
    const exitB = await ragequit(mirror, "B");
    const remaining1 = await read<bigint>(mirror, "shares", "totalSupply");
    await warpPastGrace(mirror, boundary.id);
    const boundaryDone = await processProposal(mirror, "A", boundary);
    row("minRetention-exactly-34pct", `remaining ${fmt(remaining1)} of ${fmt(supply1)} = ${Number((remaining1 * 10_000n) / supply1) / 100}% >= 66% -> passes`, `B exited ${fmt(bShares)} (${Number((bShares * 10_000n) / supply1) / 100}%); passed=${boundaryDone.info.status.passed}`, bShares * 100n === supply1 * 34n && remaining1 * 100n === supply1 * 66n && boundaryDone.info.status.passed, boundaryDone.receipt.hash);
    await deposit(mirror, "C", usdcFor(40n * UNIT));
    const supply2 = await read<bigint>(mirror, "shares", "totalSupply");
    const cShares = await read<bigint>(mirror, "shares", "balanceOf", [mirror.actors.C.account.address]);
    const over = await propose(mirror, "F", [], "corner: retention > 34% exits");
    await vote(mirror, "F", over.id, true);
    const exitC = await ragequit(mirror, "C");
    const remaining2 = await read<bigint>(mirror, "shares", "totalSupply");
    await warpPastGrace(mirror, over.id);
    const overDone = await processProposal(mirror, "A", over);
    row("minRetention-over-34pct", `remaining ${fmt(remaining2)} of ${fmt(supply2)} = ${Number((remaining2 * 10_000n) / supply2) / 100}% < 66% -> fails`, `C exited ${fmt(cShares)} (${Number((cShares * 10_000n) / supply2) / 100}%); passed=${overDone.info.status.passed}`, overDone.info.status.passed === false && exitB.paid > 0n && exitC.paid > 0n, overDone.receipt.hash);
writeFileSync(`${root}/vote-boundaries-resume.json`,JSON.stringify({chainId:84532,baal:mirror.dao.baal,rows},null,2)+'\n');
assert(rows.every(r=>r.ok),'all native retention boundaries pass');
console.log('NATIVE VOTE BOUNDARIES PASS');
