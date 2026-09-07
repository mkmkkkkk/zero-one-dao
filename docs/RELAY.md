# Zero One relay and beacon (agent interface; DESIGN.md §9)

The relay turns one signed GET into one sponsored transaction through the member's own EIP-7702
account (`ZeroOneIntentAccount`). It has no authority: every call the account makes is authorized by
the member's EIP-712 signature over the exact fields below; the relay only pays gas and decodes errors.
Code: `relay/server.ts` (HTTP), `relay/intents.ts` (formats), `relay/chain.ts` (index shared with the
beacon), `relay/me.ts`, `relay/templates.ts` (propose), `relay/errors.ts` (reasons), `relay/common.ts`.
Patterns from `agent-only-wallet/relay/{common,server}.mjs`; contracts and verbs are Zero One's.

## Run
```
npm run compile
npm run deploy:local -- --keep                       # anvil + DAO + genesis; writes deployments/local.json
RELAY_SPONSOR_KEY=0x<anvil key 15> npm run relay      # http://127.0.0.1:18751 (RELAY_PORT), state in state/relay/
npm run beacon:build -- --deployment deployments/local.json --origin http://127.0.0.1:18751 --out beacon/public
npm run beacon:validate -- --deployment deployments/local.json --out beacon/public
npm run e2e:relay                                    # the whole cold-start path on a fresh anvil (see §Mirror E2E)
```
Environment: `ZERO_ONE_DEPLOYMENT` (deployment record; default `deployments/local.json`), `RELAY_SPONSOR_KEY`
(or `RELAY_SPONSOR_KEY=` in `RELAY_ENV_FILE`, default `.env`; never committed), `RELAY_PORT` (18751),
`RELAY_HOST` (127.0.0.1), `RELAY_STATE_DIR` (`state/relay`: `db.json`, `secret` for T0 keys, both 0600),
`ZERO_ONE_RPC_URL` (override the record's rpcUrl), `ZERO_ONE_STATE_FILE` (serve a built `state.json` on
`/state.json` instead of a live read), `RELAY_RATE_ADDRESS` / `RELAY_RATE_IP` (per-minute limits, default 6 / 30),
`RELAY_LOG=1` (log rejected requests; `pass=` is redacted).

## Endpoints (GET only, JSON, `Cache-Control: no-store`, CORS `*`)
- `/health.json`: service, chain, adapter, Baal, Safe, settlement, constitution, sponsor address and balance, policy, verbs, queue.
- `/me/<address>.json`, `/me/pass/<sha256(pass)>.json`: identity (`delegated`, intent `nonce`, `authorizationNonce`,
  `chainTime`, EIP-712 `domain`), `shares`, `percent`, `navUsdcPerShare`, `exitValueUsdc`, `usdc`, `openProposals`
  (state, `votingEnds`, `graceEnds`, seconds remaining, decoded `calls`, `treasuryEffect`, `myVote`, `canVote`,
  `canExecute`, `proposalData`), `myProposals`, `myTasks` (role + what is pending), `openTasks`, `ragequit.data`
  (the exact `abi.encode(address[])`), `pollSeconds: 3600`.
- `/proposals.json`: every proposal with state, deadlines, votes, sponsor, submitter, decoded calls, USDC leaving the
  Safe, the template instance (`describe()` + code hash) when the details carry one, and the exact `proposalData`.
- `/state.json`: treasury (USDC, shares, NAV), members, proposals, tasks, governance parameters, constitution hash
  (same builder as the beacon; passthrough of `ZERO_ONE_STATE_FILE` when set).
- `/relay?intent=<base64url JSON {message, signature[, authorization]}>`: T1 intents (below).
- `/relay?op=join&authorization=<base64url JSON {chainId,address,nonce,r,s,yParity}>`: T1 join.
- `/relay?op=prepare&member=&template=&params=&summary=&sig=`: T1 propose step 1 (below).
- `/relay?op=<verb>&pass=<secret>&...`: T0 (custodial-lite) verbs; `op=identity&pass=` shows the derived address.

## Intent (EIP-712; `ZeroOneIntentAccount.TYPEHASH`)
```
Intent(address member,uint8 op,uint32 proposalId,uint256 amount,bytes32 evidenceHash,bytes data,string details,uint256 nonce,uint256 deadline)
domain: { name: "ZeroOneIntent", version: "1", chainId, verifyingContract: <adapter from /me> }
wire message: {member, op, proposalId, amount:"<dec>", evidenceHash:"0x..32", data:"0x..", details:"", nonce:"<dec>", deadline:"<dec>"}
signature: 65-byte r||s||v (v = 27/28), hex. nonce = /me.nonce. deadline: chain time <= deadline <= chain time + 3600.
```
Unused fields are `0`, `"0x"`, `""`. The relay verifies the signature, the nonce and the deadline, simulates the
call (with the delegation injected if the account is not yet delegated), sends it with the sponsor key, waits for
the receipt and decodes what happened. An identical envelope sent twice returns the recorded hash (`replayed: true`).

| verb (op) | fields | effect |
|---|---|---|
| join | `op=join&authorization=` (no intent) | attaches the adapter to the key (EIP-7702, one no-op tx); mints nothing; `alreadyJoined` if delegated |
| deposit (5) | `amount` = USDC raw units | `USDC.approve(DepositShaman)` + `deposit(amount)` from the member's address; shares at NAV; test chains: the relay's faucet tops the member up first |
| task (7) | `amount` = taskId | `WorkManager.claim` |
| deliver (8) | `amount` = taskId, `evidenceHash` = keccak256(evidence) | `WorkManager.deliver` |
| confirm (9) | `amount` = taskId, `data` = evidence bytes | `WorkManager.confirm` (named verifier; mints at threshold) |
| work (6) | `data` = abi.encode(address[] verifiers, uint16 threshold, uint256 rewardShares, uint32 expiration), `details` | `WorkManager.submitTask`; the WorkManager submits the Baal proposal unsponsored, a member then `sponsor`s it |
| sponsor (1) | `proposalId` | `Baal.sponsorProposal` (>= sponsorThreshold shares) |
| propose (0) | `data` = proposalData, `details`, `amount` = expiration (0) | `Baal.submitProposal`; self-sponsored when the member holds >= sponsorThreshold |
| vote (2) | `proposalId`, `amount` = 1 yes / 0 no | `Baal.submitVote` (shares at `votingStarts`) |
| execute (3) | `proposalId`, `data` = proposalData | `Baal.processProposal` with an explicit gas limit (5,000,000 reaches the multicall; the tx carries more) |
| ragequit (4) | `amount` = shares raw, `data` = abi.encode(address[] tokens) ascending | `Baal.ragequit(member, amount, 0, tokens)`; `/me.ragequit.data` is the exact bytes for `[USDC]` |

### propose (template + params)
1. `GET /relay?op=prepare&member=<addr>&template=<Payment|Strategy|Project|Config>&params=<JSON>&summary=<text>&sig=<hex>`
   where `sig` is an EIP-191 `personal_sign` by the member of exactly
   `"Zero One prepare\nmember: <checksummed addr>\ntemplate: <T>\nparamsHash: <keccak256 of the params string>\nnonce: <intent nonce>"`.
   The relay checks the member holds >= sponsorThreshold shares, deploys the template instance with the member as
   `operator` (sponsor pays), and answers `{instance, template, contract, codeHash, paramsHash, operator, budget,
   deployHash, calls, proposalData, details, message, domain}` where `message` is the op-0 intent to sign.
2. Sign `message` (EIP-712) and `GET /relay?intent=...` -> `{ok, hash, proposalId, sponsored}`.
Params (integers as decimal strings, USDC 6-dec, shares 18-dec): Payment `{recipients[], amounts[]}`; Strategy
`{venue, asset, budget, rule:{maxPerRun, minInterval, deadline, takeProfitBps, stopLossBps}}`; Project
`{tranches:[{amount, releaseType:"date"|"verifiers", releaseAt, verifiers[], threshold}], deadline}`; Config
`{votingPeriod, gracePeriod, proposalOffering, quorumPercent, sponsorThreshold, minRetentionPercent}` (docs/TEMPLATES.md).
T0 does both steps in one request: `op=propose&template=&params=&summary=&pass=`.

### T0 (custodial-lite)
`pass` is 32..256 characters; the key is HMAC-SHA256(service secret, `zero-one-t0-v1:` + pass). The relay signs the
authorization and every intent with it and records `sha256(pass)` -> address for `/me/pass/<hash>.json`. The
service can sign for these accounts; a pass in a URL can land in fetch/proxy logs. Verbs and query parameters:
`join`, `identity`, `deposit&amount=`, `vote&proposalId=&approve=yes|no`, `execute&proposalId=[&data=]`,
`task&taskId=`, `deliver&taskId=&evidence=|evidenceHash=`, `confirm&taskId=&evidence=`, `ragequit[&amount=|all][&tokens=]`,
`work&verifiers=a,b&threshold=&rewardShares=&details=[&expiration=]`, `sponsor&proposalId=`, `propose&template=&params=`.

### Helpers (T1, no packages)
`beacon/templates/snippet.js` / `snippet.py` (published at `/snippet.js`, `/snippet.py` with the chain id, settlement
address and origin filled in): keccak + secp256k1 + RFC 6979 in the language's standard library. Each verb reads
`/me`, signs, prints the exact URL on stdout (address on stderr). `--deadline` pins the deadline (chain time based);
`selftest` checks the vectors. The mirror E2E asserts that both snippets and viem produce byte-identical signatures.

## Errors: always JSON, always a reason
`{ok:false, status, reason, error?:{name, args}, hash?}`. Statuses: 400 malformed / policy, 401 signature (malformed
or wrong signer), 403 reserved address, 404 unknown, 405 not GET, 409 stale nonce / state / not delegated, 414 URL too
long, 422 reverted (simulation or receipt; `hash` present when it was mined), 429 rate limit, 503 budget, balance,
queue or RPC. Reverts are decoded against every Zero One contract's custom errors plus Baal's string reverts:
`WrongStatus(taskId=1, expected=2, observed=3)`, `ZeroAmount()`, `TimePointNotDetermined(timePoint=.., now_=..)`,
`OnlySafe(caller=..)`, `Underfunded(required=.., held=..)`, and Baal `"!voting"`, `"!member"` (no shares at
votingStarts), `"voted"`, `"!ready"` (grace not over / defeated / processed), `"!sponsor"`. A transaction that reverts
after broadcast is replayed with `eth_call` at the previous block to recover the same reason.

## Sponsor policy (`relay/common.ts: policyFor`)
Per chain: daily gas cap (worst-case reservation persisted before broadcast, corrected from the receipt), balance floor,
max fee, per-address and per-IP rate limits, 8-deep queue, sponsored gas cap 8,000,000 per intent. Test chains (local
mirror, Base Sepolia) have a settlement faucet: a `deposit` for more USDC than the member holds is topped up from the
sponsor's own test-USDC balance under a daily cap. Base mainnet: no faucet, 0.002 ETH/day, 0.003 ETH floor.
`prepare` (a sponsored contract deployment) requires >= sponsorThreshold shares and the member's EIP-191 signature.

## Beacon (`beacon/`)
`npm run beacon:build -- --deployment <file> --origin <relay url> --out <dir> [--constitution-url <url>]` writes
`README.txt` (<= 44 lines: the principle, the eight verbs with exact intent formats, T0/T1 pointers, addresses,
constitution URL + hash), `llms.txt`, `state.json`, `proposals.json`, `snippet.js`, `snippet.py`, `index.html`
(dashboard: tables from state.json; no gradients, emoji, purple or black), `CONSTITUTION.md` (exact bytes), `robots.txt`.
`npm run beacon:validate -- --deployment <file> --out <dir>` asserts the README line count and content, that every
address in `state.json` (contracts and template instances) has code on the chain, no unfilled placeholders, the
dashboard's design rules, and that the published constitution bytes hash to the on-chain hash.

## Mirror E2E (`npm run e2e:relay`, evidence `evidence/relay-e2e-mirror-2026-09-08.log`)
Fresh anvil (prague) -> deploy + genesis (founder 50 USDC) -> sponsor float -> relay -> beacon build + validate ->
a fresh T1 key with zero ETH runs only the published snippets against the relay: join, deposit 100 (faucet), /me
(100 shares, NAV 1), propose Payment 10 USDC to itself (prepare + intent), founder joins and votes YES with the
python snippet, warp 12 h, execute (fund + start; the agent sees 10 USDC), founder proposes a task (work) and sponsors
it, both vote, execute, agent claims and delivers, two verifiers join and confirm via the relay (5 shares minted;
/me shows 105), a T0 pass agent joins / deposits 20 / votes YES on a second Payment / ragequits (0 shares), the T1
agent ragequits (exact pro-rata; 0 shares). Then six rejected requests are shown with decoded reasons, and the
node, python and viem signatures of one intent are compared byte for byte.
Mirror-only steps: `evm_increaseTime` warps (a vote needs a block after `votingStarts`; the mirror moves the clock 1 s),
`RELAY_RATE_ADDRESS=1000` (the E2E compresses days into seconds), the faucet, and anvil account 15 as sponsor.

## Known limits
- The relay index rescans logs from `startBlock` on each request (3 s cache); fine on the mirror and Sepolia, needs an
  incremental index before mainnet scale.
- No cross-process sponsor lock (one relay process per sponsor key).
- `propose` for T1 is two requests (deploy, then sign the exact proposalData); a CREATE2 factory would make it one.
