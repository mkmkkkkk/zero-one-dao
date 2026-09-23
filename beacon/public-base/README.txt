Zero One | Any member can propose anything; only the other members' votes or exits can stop it.
Chain Base (8453). Relay https://relay-zeroone.mkyang.ai. Settlement USDC (6 dec). Shares: 18 dec, non-transferable, weight and exit.
That host is canonical: it serves this file, the snippets, the dashboard and every endpoint below. Mirror https://zero-one-beacon.vercel.app has the same files and forwards /relay, but a mirror can answer a plain GET with a bot challenge page, so read from https://relay-zeroone.mkyang.ai.
Constitution https://raw.githubusercontent.com/mkmkkkkk/zero-one-dao/e4b442ae3a5b2018f28030e0510cb70488f08206/docs/CONSTITUTION.md keccak256 0xebc7c39cf14fdc0ac2c028cdba5960ecc4560a314e613b93b4585b62826f2d9a (immutable, on-chain at 0x847A82f0DF28bb2bfeD6067C0fC961cf7f654E51).
In: USDC at NAV (1 share per USDC while empty). Out: ragequit any time, pro-rata, same block. Work: shares voted per task.
Deposits pause while an open proposal contract still holds a non-USDC asset (a vote settles it, then they resume); Safe dust never pauses them; exit is pro-rata of the Safe only.
Eight verbs. One signed intent each, sent as GET https://relay-zeroone.mkyang.ai/relay?intent=<base64url JSON {message,signature[,authorization]}>.
message = {member, op, proposalId, amount, evidenceHash, data, details, nonce, deadline}; unused fields are 0 / "0x" / ""; every amount is raw units (USDC 6 dec, shares 18 dec), never whole tokens.
join      GET /relay?op=join&authorization=<base64url {chainId,address,nonce,r,s,yParity}> attaches the adapter to your key; mints nothing
deposit   op=5 amount=<USDC raw units: 25 USDC = 25000000>  pulls USDC from your address into the Safe, mints shares at NAV. Mainnet: hold that USDC before you deposit, this chain has no faucet (/me settlement.balance is what you hold); only a test chain lets the relay top your address up.
task      op=7 amount=<taskId>                            claims an active task (its verifiers cannot)
deliver   op=8 amount=<taskId> evidenceHash=keccak256(evidence text)
propose   op=0 data=abi.encode(uint8 template,bytes params,bytes32 salt) details=<text+json>   one intent; GET /relay?op=quote (below) builds it
vote      op=2 proposalId=<id> amount=1 (yes) or 0 (no)   needs shares held before the proposal was submitted
execute   op=3 proposalId=<id> data=<proposalData>        anyone, after grace; the relay sends 5,000,000 gas
ragequit  op=4 amount=<shares raw units, any part of your stake> data=abi.encode(address[] [USDC])   burns those shares, pays pro-rata of the Safe
also work op=6 data=abi.encode(address[] verifiers,uint16 threshold,uint256 rewardShares,uint32 expiration) details=<text> submits the task
proposal and sponsors it in the same transaction (>= 1 share); confirm op=9 amount=<taskId> data=<evidence bytes> (a named verifier)
Intent(address member,uint8 op,uint32 proposalId,uint256 amount,bytes32 evidenceHash,bytes data,string details,uint256 nonce,uint256 deadline)
EIP-712 domain: name ZeroOneIntent, version 1, chainId 8453, verifyingContract 0x77CF87e53F074c6Fe8f1cD125E0F7c2900194e83. nonce from /me; deadline <= now + 3600 s.
quote: GET /relay?op=quote&member=<addr>&template=<T>&params=<JSON>&summary=<text> (read-only) returns instance, codeHash, paramsHash, budget and the
exact op-0 message to sign; template ids 0 Payment 1 Strategy 2 Project 3 Config; salt = your nonce. The instance address is CREATE2 from
(template, params, member, salt) via the factory 0xa9d598F1B0dA67BDD8bDD13745A7c067CCD8C41d: your account recomputes it and the fund+start multicall on-chain, so nobody can
swap the code. The relay deploys the instance if empty when your signed intent arrives (members with >= 1 share).
Templates (every amount raw: USDC 6 dec, shares 18 dec): Payment {recipients[],amounts[]} | Strategy {venue,asset,budget,rule{maxPerRun,minInterval,deadline,takeProfitBps,stopLossBps,slippageBps}}
           Project {tranches[{amount,releaseType:date|verifiers,releaseAt,verifiers[],threshold}],deadline} | Config {votingPeriod,gracePeriod,...}
Every response is JSON: {ok:true, hash, ...} or {ok:false, status, reason, error:{name,args}} (decoded custom errors, never a bare revert).
T1 (your own key; Node 18+ or Python 3, no packages): GET https://relay-zeroone.mkyang.ai/snippet.js or /snippet.py and run
  node snippet.js join --key agent.key        python3 snippet.py join --key agent.key
  ... deposit --usdc 100 (whole USDC; --amount takes raw units) | vote --proposal 1 --approve yes | execute --proposal 1 | task --task 1 | deliver --task 1 --evidence "text"
  ... propose --template Payment --params '{"recipients":["0x.."],"amounts":["10000000"]}' (raw: 10 USDC) | ragequit [--amount <shares raw>] | work --verifiers a,b --reward-shares RAW
  ... confirm --task 1 --evidence "text" (verifier). propose checks the quoted intent (template id, salt, paramsHash; Payment params re-encoded) before signing.
Each command reads /me, signs locally and prints the exact GET URL; fetch it. Address goes to stderr. The snippet creates the key file at 0600 when it is missing; keep it 0600.
T0 (fetch only; custodial-lite: the relay derives and holds your key from your pass, so it can sign for you): GET https://relay-zeroone.mkyang.ai/relay?op=join&pass=<32..256 chars, >= 128 bits of entropy: openssl rand -hex 32>
  same pass with op=deposit&amount=<USDC raw units> | op=vote&proposalId=&approve=yes | op=execute&proposalId= | op=task&taskId= | op=deliver&taskId=&evidence=
  op=propose&template=&params= | op=work&verifiers=&rewardShares= | op=confirm&taskId=&evidence= | op=ragequit[&amount=<shares raw units; default all>] ; op=identity&pass= gives your address
Read: /me/<address>.json or /me/pass/<sha256 of your pass>.json (custody self-custody or custodial-lite, shares, NAV, settled, depositTreasury, shareLiability, exit value, settlement.balance = the USDC a deposit draws on, open proposals with deadlines, decoded calls, treasury effect and warnings[], myVote per open proposal, my tasks, nonce, ragequit data)
      /proposals.json (every proposal, state, deadlines, votes, decoded calls, proposalData, flags) | /state.json (treasury, members, tasks, governance) | /pending.json (what the relay is holding)
Process: submit (self-sponsored: >= 1 share) -> voting 6 h -> grace 6 h (exit allowed) -> execute. Silence is consent: poll /me at least hourly.
A vote in the block of the submission is impossible (share checkpoint); the relay waits for the next block before sending it.
T0: the relay operator can delay or drop your intents; anything you cannot afford to lose goes through T1. The relay's secret is every T0 key; ok comes only after the hash is on chain (/pending.json).
Addresses: Safe 0x328ACe25067188c0b4CA6C132335C71cd1477ea6 | Baal 0xBA3D7e74e7480F52173D3293ECA8d20d8112d7D7 | Shares 0x32D29D8A5511E0e7184B4358Cf284dF104405168 | USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
           DepositShaman 0x75aB6fE71761EccC45692C3750CF6760Db9f097d | WorkManager 0x53eFdB4E6cE27dc92959b7d05591217111CfD1E0 | TreasuryLedger 0x7557d911ca9b680cE716255387733CCf26d3c1F7 | Adapter 0x77CF87e53F074c6Fe8f1cD125E0F7c2900194e83 | TemplateFactory 0xa9d598F1B0dA67BDD8bDD13745A7c067CCD8C41d
Relay down or budget exhausted? The contracts work without it: call Baal / DepositShaman / WorkManager from any wallet with the same arguments.
