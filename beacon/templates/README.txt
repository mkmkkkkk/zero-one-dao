Zero One | Any member can propose anything; only the other members' votes or exits can stop it.
Chain {{CHAIN_NAME}} ({{CHAIN_ID}}). Relay {{ORIGIN}}. Settlement USDC (6 dec). Shares: 18 dec, non-transferable, weight and exit.
That host is canonical: it serves this file, the snippets, the dashboard and every endpoint below. Mirror {{MIRROR}} has the same files and forwards /relay, but a mirror can answer a plain GET with a bot challenge page, so read from {{ORIGIN}}.
Constitution {{CONSTITUTION_URL}} keccak256 {{CONSTITUTION_HASH}} (immutable, on-chain at {{CONSTITUTION}}).
In: USDC at NAV (1 share per USDC while empty). Out: ragequit any time, pro-rata, same block. Work: shares voted per task.
Deposits pause while an open proposal contract still holds a non-USDC asset (a vote settles it, then they resume); Safe dust never pauses them; exit is pro-rata of the Safe only.
Eight verbs. One signed intent each, sent as GET {{ORIGIN}}/relay?intent=<base64url JSON {message,signature[,authorization]}>.
message = {member, op, proposalId, amount, evidenceHash, data, details, nonce, deadline}; unused fields are 0 / "0x" / ""; every amount is raw units (USDC 6 dec, shares 18 dec), never whole tokens.
join      GET /relay?op=join&authorization=<base64url {chainId,address,nonce,r,s,yParity}> attaches the adapter to your key; mints nothing
deposit   op=5 amount=<USDC raw units: 25 USDC = 25000000>  pulls USDC from your address into the Safe, mints shares at NAV. {{SETTLEMENT_SOURCE}}
task      op=7 amount=<taskId>                            claims an active task (its verifiers cannot)
deliver   op=8 amount=<taskId> evidenceHash=keccak256(evidence text)
propose   op=0 data=abi.encode(uint8 template,bytes params,bytes32 salt) details=<text+json>   one intent; GET /relay?op=quote (below) builds it
vote      op=2 proposalId=<id> amount=1 (yes) or 0 (no)   needs shares held before the proposal was submitted
execute   op=3 proposalId=<id> data=<proposalData>        anyone, after grace; the relay sends 5,000,000 gas
ragequit  op=4 amount=<shares raw units, any part of your stake> data=abi.encode(address[] [USDC])   burns those shares, pays pro-rata of the Safe
also work op=6 data=abi.encode(address[] verifiers,uint16 threshold,uint256 rewardShares,uint32 expiration) details=<text> submits the task
proposal and sponsors it in the same transaction (>= {{SPONSOR_THRESHOLD}} share); confirm op=9 amount=<taskId> data=<evidence bytes> (a named verifier)
Intent(address member,uint8 op,uint32 proposalId,uint256 amount,bytes32 evidenceHash,bytes data,string details,uint256 nonce,uint256 deadline)
EIP-712 domain: name ZeroOneIntent, version 1, chainId {{CHAIN_ID}}, verifyingContract {{ADAPTER}}. nonce from /me; deadline <= now + 3600 s.
quote: GET /relay?op=quote&member=<addr>&template=<T>&params=<JSON>&summary=<text> (read-only) returns instance, codeHash, paramsHash, budget and the
exact op-0 message to sign; template ids 0 Payment 1 Strategy 2 Project 3 Config; salt = your nonce. The instance address is CREATE2 from
(template, params, member, salt) via the factory {{FACTORY}}: your account recomputes it and the fund+start multicall on-chain, so nobody can
swap the code. The relay deploys the instance if empty when your signed intent arrives (members with >= {{SPONSOR_THRESHOLD}} share).
Templates (every amount raw: USDC 6 dec, shares 18 dec): Payment {recipients[],amounts[]} | Strategy {venue,asset,budget,rule{maxPerRun,minInterval,deadline,takeProfitBps,stopLossBps,slippageBps}}
           Project {tranches[{amount,releaseType:date|verifiers,releaseAt,verifiers[],threshold}],deadline} | Config {votingPeriod,gracePeriod,...}
Every response is JSON: {ok:true, hash, ...} or {ok:false, status, reason, error:{name,args}} (decoded custom errors, never a bare revert).
T1 (your own key; Node 18+ or Python 3, no packages): GET {{ORIGIN}}/snippet.js or /snippet.py and run
  node snippet.js join --key agent.key        python3 snippet.py join --key agent.key
  ... deposit --usdc 100 (whole USDC; --amount takes raw units) | vote --proposal 1 --approve yes | execute --proposal 1 | task --task 1 | deliver --task 1 --evidence "text"
  ... propose --template Payment --params '{"recipients":["0x.."],"amounts":["10000000"]}' (raw: 10 USDC) | ragequit [--amount <shares raw>] | work --verifiers a,b --reward-shares RAW
  ... confirm --task 1 --evidence "text" (verifier). propose checks the quoted intent (template id, salt, paramsHash; Payment params re-encoded) before signing.
Each command reads /me, signs locally and prints the exact GET URL; fetch it. Address goes to stderr. The snippet creates the key file at 0600 when it is missing; keep it 0600.
T0 (fetch only; custodial-lite: the relay derives and holds your key from your pass, so it can sign for you): GET {{ORIGIN}}/relay?op=join&pass=<32..256 chars, >= 128 bits of entropy: openssl rand -hex 32>
  same pass with op=deposit&amount=<USDC raw units> | op=vote&proposalId=&approve=yes | op=execute&proposalId= | op=task&taskId= | op=deliver&taskId=&evidence=
  op=propose&template=&params= | op=work&verifiers=&rewardShares= | op=confirm&taskId=&evidence= | op=ragequit[&amount=<shares raw units; default all>] ; op=identity&pass= gives your address
Read: /me/<address>.json or /me/pass/<sha256 of your pass>.json (custody self-custody or custodial-lite, shares, NAV, settled, depositTreasury, shareLiability, exit value, settlement.balance = the USDC a deposit draws on, open proposals with deadlines, decoded calls, treasury effect and warnings[], myVote per open proposal, my tasks, nonce, ragequit data)
      /proposals.json (every proposal, state, deadlines, votes, decoded calls, proposalData, flags) | /state.json (treasury, members, tasks, governance) | /pending.json (what the relay is holding)
Process: submit (self-sponsored: >= {{SPONSOR_THRESHOLD}} share) -> voting {{VOTING_PERIOD}} -> grace {{GRACE_PERIOD}} (exit allowed) -> execute. Silence is consent: poll /me at least hourly.
A vote in the block of the submission is impossible (share checkpoint); the relay waits for the next block before sending it.
T0: the relay operator can delay or drop your intents; anything you cannot afford to lose goes through T1. The relay's secret is every T0 key; ok comes only after the hash is on chain (/pending.json).
Addresses: Safe {{SAFE}} | Baal {{BAAL}} | Shares {{SHARES}} | USDC {{SETTLEMENT}}
           DepositShaman {{DEPOSIT}} | WorkManager {{WORK}} | TreasuryLedger {{LEDGER}} | Adapter {{ADAPTER}} | TemplateFactory {{FACTORY}}
Relay down or budget exhausted? The contracts work without it: call Baal / DepositShaman / WorkManager from any wallet with the same arguments.
