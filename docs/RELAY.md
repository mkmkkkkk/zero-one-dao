# Zero One relay and beacon (agent interface; DESIGN.md §9)

The relay turns one signed GET into one sponsored transaction through the member's own EIP-7702
account (`ZeroOneIntentAccount`). It has no authority: every call the account makes is authorized by
the member's EIP-712 signature over the exact fields below; the relay only pays gas and decodes errors.
Code: `relay/server.ts` (HTTP), `relay/intents.ts` (formats), `relay/chain.ts` (index shared with the
beacon), `relay/me.ts`, `relay/templates.ts` (propose quote), `relay/errors.ts` (reasons), `relay/common.ts`.
Contracts the relay drives: `ZeroOneIntentAccount` (ops 0, 2..9; op 1 "sponsor" no longer exists) and
`TemplateFactory` (CREATE2 template instances; decision.md phase 2b rulings 2, 3, 4, 7).
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
- `/relay?op=quote&member=&template=&params=[&summary=&salt=]`: read-only propose quote: the deterministic instance
  (address, code hash, params hash, budget, proposalData) and the exact op-0 intent to sign (below). Nothing is deployed.
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
| work (6) | `data` = abi.encode(address[] verifiers, uint16 threshold, uint256 rewardShares, uint32 expiration), `details` | `WorkManager.submitTask` then `Baal.sponsorProposal` of the new proposal in the same transaction (ruling 4; needs >= sponsorThreshold shares, else `!sponsor`) |
| propose (0) | `data` = abi.encode(uint8 template, bytes params, bytes32 salt), `details` = summary + JSON, `amount` = expiration (0) | account: `TemplateFactory.deploy` (no-op when the instance exists) -> `factory.proposalData` -> `Baal.submitProposal`; the relay requires >= sponsorThreshold shares (self-sponsored; there is no sponsor verb) |
| vote (2) | `proposalId`, `amount` = 1 yes / 0 no | `Baal.submitVote` (shares at `votingStarts`); if the latest block is not past `votingStarts` the relay waits for the next block first (ruling 7; response carries `waitedBlocks`) |
| execute (3) | `proposalId`, `data` = proposalData | `Baal.processProposal` with an explicit gas limit (5,000,000 reaches the multicall; the tx carries more) |
| ragequit (4) | `amount` = shares raw, `data` = abi.encode(address[] tokens) ascending | `Baal.ragequit(member, amount, 0, tokens)`; `/me.ragequit.data` is the exact bytes for `[USDC]` |

### propose (template + params): one signed intent (ruling 2)
1. `GET /relay?op=quote&member=<addr>&template=<Payment|Strategy|Project|Config>&params=<JSON>&summary=<text>[&salt=<bytes32>]`
   (read-only, no signature). The relay eth_calls `TemplateFactory.quote` and answers `{instance, exists, template,
   templateId, contract, codeHash, paramsHash, paramsBytes, salt, operator, budget, deadline, calls, proposalData,
   details, canPropose, message, domain}`. `salt` defaults to the member's intent nonce as bytes32. `instance` =
   CREATE2 address from (template, params, member, salt); `codeHash` = keccak256 of the runtime code that will be there.
2. Check `message` (op 0, `data` = abi.encode(templateId, paramsBytes, salt); the snippets verify the template id, the
   salt, that keccak256(paramsBytes) == paramsHash, that details carry paramsHash and codeHash, and re-encode Payment
   params locally), sign it (EIP-712) and `GET /relay?intent=...`. The relay requires the member to hold >=
   sponsorThreshold shares, deploys the instance through the factory if the address is still empty (sponsor pays,
   rate-limited; ruling 3), then sends the intent. On-chain the account re-derives the instance address and the
   fund+start multicall from the signed data, so the relay cannot substitute code or targets. Response adds
   `{instance, template, codeHash, deployHash?, deployedBy: "relay sponsor" | "already on chain", proposalId, sponsored}`.
Params (integers as decimal strings, USDC 6-dec, shares 18-dec): Payment `{recipients[], amounts[]}`; Strategy
`{venue, asset, budget, rule:{maxPerRun, minInterval, deadline, takeProfitBps, stopLossBps}}`; Project
`{tranches:[{amount, releaseType:"date"|"verifiers", releaseAt, verifiers[], threshold}], deadline}`; Config
`{votingPeriod, gracePeriod, proposalOffering, quorumPercent, sponsorThreshold, minRetentionPercent}` (docs/TEMPLATES.md).
Template ids: 0 Payment, 1 Strategy, 2 Project, 3 Config. T0 does both steps in one request:
`op=propose&template=&params=&summary=&pass=`. Management proposals (topUp / amend / stop / migrate) have no relay
verb: build them with `src/proposals.ts` and submit to Baal directly.

### T0 (custodial-lite)
`pass` is 32..256 characters; the key is HMAC-SHA256(service secret, `zero-one-t0-v1:` + pass). The relay signs the
authorization and every intent with it and records `sha256(pass)` -> address for `/me/pass/<hash>.json`. The
service can sign for these accounts; a pass in a URL can land in fetch/proxy logs. Verbs and query parameters:
`join`, `identity`, `deposit&amount=`, `vote&proposalId=&approve=yes|no`, `execute&proposalId=[&data=]`,
`task&taskId=`, `deliver&taskId=&evidence=|evidenceHash=`, `confirm&taskId=&evidence=`, `ragequit[&amount=|all][&tokens=]`,
`work&verifiers=a,b&threshold=&rewardShares=&details=[&expiration=]`, `propose&template=&params=[&summary=&salt=]`.

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
A sponsored template deployment (inside `propose`) requires >= sponsorThreshold shares and its own per-address rate window.

## Beacon (`beacon/`)
`npm run beacon:build -- --deployment <file> --origin <relay url> --out <dir> [--constitution-url <url>]` writes
`README.txt` (<= 44 lines: the principle, the eight verbs with exact intent formats, T0/T1 pointers, addresses,
constitution URL + hash), `llms.txt`, `state.json`, `proposals.json`, `snippet.js`, `snippet.py`, `index.html`
(dashboard: tables from state.json; no gradients, emoji, purple or black), `CONSTITUTION.md` (exact bytes), `robots.txt`.
`npm run beacon:validate -- --deployment <file> --out <dir>` asserts the README line count and content, that every
address in `state.json` (contracts and template instances) has code on the chain, no unfilled placeholders, the
dashboard's design rules, and that the published constitution bytes hash to the on-chain hash.

## Mirror E2E (`npm run e2e:relay`, evidence `evidence/relay-e2e-mirror-2026-09-08-one-intent-propose.log`)
Fresh anvil (prague) -> deploy + genesis (founder 50 USDC) -> sponsor float -> relay -> beacon build + validate ->
founder joins (python snippet) -> a fresh T1 key with zero ETH runs only the published snippets against the relay:
join, deposit 100 (faucet), /me (100 shares, NAV 1), quote + propose Payment 10 USDC to itself in ONE intent (the
quoted CREATE2 address and code hash equal the deployed ones; the on-chain proposalData equals the quoted one; the
signed data carries only template id, abi.encode(params) and salt), founder votes YES right after the submission
(the relay reports `waitedBlocks: 1`), warp 12 h, execute (fund + start; the agent sees 10 USDC), founder proposes a
task (work) which submits and sponsors in one transaction, founder votes (relay waits one block), agent votes
(waitedBlocks 0), execute, agent claims and delivers, two verifiers join and confirm via the relay (5 shares minted;
/me shows 105), a T0 pass agent joins / deposits 20 / votes YES on a second Payment right after its submission /
ragequits (0 shares), the T1 agent ragequits (exact pro-rata; 0 shares). Then nine rejected requests are shown with
decoded reasons (including propose below the threshold, `op=sponsor`, `op=prepare`, and a quote whose template
constructor reverts `ZeroAmount`), and the node, python and viem signatures of one intent are compared byte for byte.
Mirror-only steps: `evm_increaseTime` warps; anvil mines only on transactions, so the E2E mines exactly one block
1.5 s after sending a vote that follows a fresh submission (on Base the next block arrives by itself);
`RELAY_RATE_ADDRESS=1000` (the E2E compresses days into seconds), the faucet, and anvil account 15 as sponsor.

## Known limits
- The relay index rescans logs from `startBlock` on each request (3 s cache); fine on the mirror and Sepolia, needs an
  incremental index before mainnet scale.
- No cross-process sponsor lock (one relay process per sponsor key).
- A vote held for the next block waits at most 120 s (then 409, retry); on the mirror the caller must mine.
