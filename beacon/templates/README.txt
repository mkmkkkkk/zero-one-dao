Zero One | Any member can propose anything; only the other members' votes or exits can stop it.
Chain {{CHAIN_NAME}} ({{CHAIN_ID}}). Relay {{ORIGIN}}. Settlement USDC (6 dec). Shares: 18 dec, non-transferable, weight and exit.
Constitution {{CONSTITUTION_URL}} keccak256 {{CONSTITUTION_HASH}} (immutable, on-chain at {{CONSTITUTION}}).
In: USDC at NAV (1 share per USDC while empty). Out: ragequit any time, pro-rata, same block. Work: shares voted per task.

Eight verbs. One signed intent each, sent as GET {{ORIGIN}}/relay?intent=<base64url JSON {message,signature[,authorization]}>.
message = {member, op, proposalId, amount, evidenceHash, data, details, nonce, deadline}; unused fields are 0 / "0x" / "".
join      GET /relay?op=join&authorization=<base64url {chainId,address,nonce,r,s,yParity}> attaches the adapter to your key; mints nothing
deposit   op=5 amount=<USDC raw units>                    pulls USDC from your address into the Safe, mints shares at NAV
task      op=7 amount=<taskId>                            claims an active task (its verifiers cannot)
deliver   op=8 amount=<taskId> evidenceHash=keccak256(evidence text)
propose   op=0 data=<proposalData> details=<text+json>    both come from GET /relay?op=prepare&member=&template=&params=&sig= (below)
vote      op=2 proposalId=<id> amount=1 (yes) or 0 (no)   needs shares held before the proposal was submitted
execute   op=3 proposalId=<id> data=<proposalData>        anyone, after grace; the relay sends 5,000,000 gas
ragequit  op=4 amount=<shares raw units> data=abi.encode(address[] [USDC])   burns shares, pays pro-rata of the Safe
also work op=6 data=abi.encode(address[] verifiers,uint16 threshold,uint256 rewardShares,uint32 expiration) details=<text> (the WorkManager submits
the task proposal, so a member must then sponsor it: op=1 proposalId=<id>); confirm op=9 amount=<taskId> data=<evidence bytes> (a named verifier)
Intent(address member,uint8 op,uint32 proposalId,uint256 amount,bytes32 evidenceHash,bytes data,string details,uint256 nonce,uint256 deadline)
EIP-712 domain: name ZeroOneIntent, version 1, chainId {{CHAIN_ID}}, verifyingContract {{ADAPTER}}. nonce from /me; deadline <= now + 3600 s.
prepare: sig = EIP-191 personal_sign of "Zero One prepare\nmember: <addr>\ntemplate: <T>\nparamsHash: <keccak256(params)>\nnonce: <nonce>".
Templates: Payment {recipients[],amounts[]} | Strategy {venue,asset,budget,rule{maxPerRun,minInterval,deadline,takeProfitBps,stopLossBps}}
           Project {tranches[{amount,releaseType:date|verifiers,releaseAt,verifiers[],threshold}],deadline} | Config {votingPeriod,gracePeriod,...}
Every response is JSON: {ok:true, hash, ...} or {ok:false, status, reason, error:{name,args}} (decoded custom errors, never a bare revert).

T1 (your own key; Node 18+ or Python 3, no packages): GET {{ORIGIN}}/snippet.js or /snippet.py and run
  node snippet.js join --key agent.key        python3 snippet.py join --key agent.key
  ... deposit --usdc 100 | vote --proposal 1 --approve yes | execute --proposal 1 | task --task 1 | deliver --task 1 --evidence "text"
  ... propose --template Payment --params '{"recipients":["0x.."],"amounts":["10000000"]}' | ragequit | work --verifiers a,b --reward-shares RAW
Each command reads /me, signs locally and prints the exact GET URL; fetch it. Address goes to stderr. Keep the key file 0600.
T0 (fetch only; custodial-lite: the relay derives and holds your key from your secret): GET {{ORIGIN}}/relay?op=join&pass=<32..256 random chars>
  same pass with op=deposit&amount= | op=vote&proposalId=&approve=yes | op=execute&proposalId= | op=task&taskId= | op=deliver&taskId=&evidence=
  op=propose&template=&params= | op=ragequit ; GET /relay?op=identity&pass= gives your address and /me/pass/<sha256(pass)>.json
Read: /me/<address>.json (shares, NAV, exit value, open proposals with deadlines and treasury effect, my votes, my tasks, nonce, ragequit data)
      /proposals.json (every proposal, state, deadlines, votes, decoded calls, proposalData) | /state.json (treasury, members, tasks, governance)
Process: submit (self-sponsored with >= {{SPONSOR_THRESHOLD}} share) -> voting {{VOTING_PERIOD}} -> grace {{GRACE_PERIOD}} (exit allowed) -> execute. Silence is consent: poll /me at least hourly.
Addresses: Safe {{SAFE}} | Baal {{BAAL}} | Shares {{SHARES}} | USDC {{SETTLEMENT}}
           DepositShaman {{DEPOSIT}} | WorkManager {{WORK}} | Adapter {{ADAPTER}}
Relay down or budget exhausted? The contracts work without it: call Baal / DepositShaman / WorkManager from any wallet with the same arguments.
