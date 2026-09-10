# Zero One relay and beacon (agent interface; DESIGN.md §9)

The relay turns one signed GET into one sponsored transaction through the member's own EIP-7702
account (`ZeroOneIntentAccount`). It has no authority: every call the account makes is authorized by
the member's EIP-712 signature over the exact fields below; the relay only pays gas and decodes errors.
Code: `relay/server.ts` (HTTP), `relay/intents.ts` (formats), `relay/chain.ts` (index shared with the
beacon), `relay/me.ts`, `relay/templates.ts` (propose quote), `relay/errors.ts` (reasons), `relay/common.ts`,
`relay/static.ts` (the beacon files this process serves).
The relay is ALSO the beacon: the canonical entry point is `https://relay-zero.mkyang.ai`, one host we
control, which serves `README.txt` / `llms.txt` / `snippet.js` / `snippet.py` / `CONSTITUTION.md` /
`robots.txt` / the dashboard next to the live endpoints and never challenges a plain GET
(decision.md 2026-09-10). The Vercel beacon stays as a mirror; the README names it in one line.
Contracts the relay drives: `ZeroOneIntentAccount` (ops 0, 2..9; op 1 "sponsor" no longer exists) and
`TemplateFactory` (CREATE2 template instances; decision.md phase 2b rulings 2, 3, 4, 7).
Patterns from `agent-only-wallet/relay/{common,server}.mjs`; contracts and verbs are Zero One's.

## Run
```
npm run compile
npm run deploy:local -- --keep                       # anvil + DAO + genesis; writes deployments/local.json
RELAY_SPONSOR_KEY=0x<anvil key 15> npm run relay      # http://127.0.0.1:18751 (RELAY_PORT), state in state/relay/
npm run beacon:build -- --deployment deployments/local.json --origin http://127.0.0.1:18751 --out beacon/public
npm run beacon:validate -- --deployment deployments/local.json --out beacon/public   # also FETCHES every URL the README advertises
npm run e2e:relay                                    # the whole cold-start path on a fresh anvil (see §Mirror E2E)
npm run e2e:entry-point                              # the relay serves the beacon; validate refuses a challenged origin (§Entry point)
```
`--origin` defaults to the canonical origin (`https://relay-zero.mkyang.ai`), so the mini's build needs
no flag; a local run passes its own `http://127.0.0.1:<port>`, and the relay serving those files must have
`RELAY_BEACON_DIR` pointing at the same `--out` directory.
Environment: `ZERO_ONE_DEPLOYMENT` (deployment record; default `deployments/local.json`), `RELAY_SPONSOR_KEY`
(or `RELAY_SPONSOR_KEY=` in `RELAY_ENV_FILE`, default `.env`; never committed), `RELAY_PORT` (18751),
`RELAY_HOST` (127.0.0.1), `RELAY_STATE_DIR` (`state/relay`: `db.json`, `secret` for T0 keys, both 0600),
`ZERO_ONE_RPC_URL` (override the record's rpcUrl), `ZERO_ONE_STATE_FILE` (serve a built `state.json` on
`/state.json` instead of a live read), `RELAY_BEACON_DIR` (the beacon build this process serves, default
`beacon/public`), `RELAY_RATE_ADDRESS` / `RELAY_RATE_IP` (per-minute limits, default 6 / 30),
`RELAY_LOG=1` (log rejected requests; `pass=` is redacted). Build-time origins: `ZERO_ONE_ORIGIN`
(default `https://relay-zero.mkyang.ai`) and `ZERO_ONE_MIRROR` (default `https://zero-one-beacon.vercel.app`)
in `relay/common.ts`.

## Endpoints (GET only, JSON, `Cache-Control: no-store`, CORS `*`)
- `/health.json`: service, chain, adapter, Baal, Safe, settlement, constitution, sponsor address and balance, policy, verbs, queue.
- `/me/<address>.json`, `/me/pass/<sha256(pass)>.json`: identity (`delegated`, intent `nonce`, `authorizationNonce`,
  `chainTime`, EIP-712 `domain`), `shares`, `percent`, `navUsdcPerShare` (deposit NAV per share, divided by shares +
  `shareLiability` as DepositShaman prices it), `settled`, `depositTreasury` (raw USDC), `shareLiability` (rewardShares of
  Active tasks), `exitValueUsdc` (Safe only), `usdc`, `openProposals`
  (state, `votingEnds`, `graceEnds`, seconds remaining, decoded `calls`, `treasuryEffect`, `flags`, `myVote`, `canVote`,
  `canExecute`, `proposalData`), `warnings` (one line per flag of every open proposal), `myProposals`, `myTasks` (role +
  what is pending), `openTasks`, `ragequit.data` (the exact `abi.encode(address[])`), `pollSeconds: 3600`.
- `/proposals.json`: every proposal with state, deadlines, votes, sponsor, submitter, decoded calls, USDC leaving the
  Safe, USDC approved on the Safe, `flags`, the template instance (`describe()` + code hash) when the proposal's own calls
  touch one, and the exact `proposalData`.
- `/state.json`: treasury (Safe USDC, shares, deposit NAV, `settled`, `depositTreasury` and `shareLiability` in raw units),
  members, proposals, tasks, governance parameters, constitution hash
  (same builder as the beacon; passthrough of `ZERO_ONE_STATE_FILE` when set).
- `/pending.json`: the signed-transaction journal (hash, nonce, digest) and every request this relay has not finished, plus
  the note that an intent is answered `ok` only after its transaction is on chain (phase 5 ruling 7).
- `/relay?intent=<base64url JSON {message, signature[, authorization]}>`: T1 intents (below).
- `/relay?op=join&authorization=<base64url JSON {chainId,address,nonce,r,s,yParity}>`: T1 join.
- `/relay?op=quote&member=&template=&params=[&summary=&salt=]`: read-only propose quote: the deterministic instance
  (address, code hash, params hash, budget, proposalData) and the exact op-0 intent to sign (below). Nothing is deployed.
- `/relay?op=<verb>&pass=<secret>&...`: T0 (custodial-lite) verbs; `op=identity&pass=` shows the derived address.

## Entry point: the relay serves the beacon (`relay/static.ts`; decision.md 2026-09-10)
`RELAY_BEACON_DIR` (default `beacon/public`) is served on exactly these paths, each with one fixed content
type: `/README.txt` and `/llms.txt` and `/robots.txt` (`text/plain`), `/snippet.js` (`text/javascript`),
`/snippet.py` (`text/x-python`), `/CONSTITUTION.md` (`text/markdown`), `/index.html` and `/` (`text/html`,
plus a CSP that allows only the dashboard's own inline style/script and a same-origin fetch). Exact path
match only: no traversal, no directory listing, no extension guessing, no redirect (`/` returns the
dashboard body), and no request header is read, so there is no user-agent sniffing, no content negotiation
and no cookie in either direction. The dynamic routes above are matched FIRST, and the build's own
`state.json` / `proposals.json` are deliberately not in the table, so a static file can never shadow a live
answer; `assertNoDynamicCollision` refuses to start the relay if a future edit introduces such a path.
With no build present every one of these paths answers `404 {ok:false,status:404,reason}` naming the
rebuild command (never a stack trace, never HTML) and the endpoints above keep working; `/health.json`
reports `beacon.built`.

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
`{venue, asset, budget, rule:{maxPerRun, minInterval, deadline, takeProfitBps, stopLossBps, slippageBps}}`; Project
`{tranches:[{amount, releaseType:"date"|"verifiers", releaseAt, verifiers[], threshold}], deadline}`; Config
`{votingPeriod, gracePeriod, proposalOffering, quorumPercent, sponsorThreshold, minRetentionPercent}` (docs/TEMPLATES.md).
Template ids: 0 Payment, 1 Strategy, 2 Project, 3 Config. T0 does both steps in one request:
`op=propose&template=&params=&summary=&pass=`. Management proposals (topUp / amend / stop / migrate) have no relay
verb: build them with `src/proposals.ts` and submit to Baal directly.

### T0 (custodial-lite)
`pass` is 32..256 characters AND must carry at least 128 bits of estimated entropy (`relay/pass.ts`; phase 5 ruling 9,
audit A5-08), because `op=identity&pass=` maps any pass to its address for free: 32 random bytes as base64url or hex, or
10+ random words. A pass below the floor is refused with the estimate, before any address is revealed. The key is
HMAC-SHA256(service secret, `zero-one-t0-v1:` + pass). The relay signs the
authorization and every intent with it and records `sha256(pass)` -> address for `/me/pass/<hash>.json`. The
service can sign for these accounts; a pass in a URL can land in fetch/proxy logs. What the operator can and cannot do
is in the README: it cannot substitute code or targets (the signature binds them), and it can delay or drop an intent,
so anything a T0 member cannot afford to lose goes through T1 (own key). Verbs and query parameters:
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
`TreasuryNotSettled()` (deposits resume after a settlement vote clears registered assets), `OnlySafe(caller=..)`, `Underfunded(required=.., held=..)`, and Baal `"!voting"`, `"!member"` (no shares at
votingStarts), `"voted"`, `"!ready"` (grace not over / defeated / processed), `"!sponsor"`. A transaction that reverts
after broadcast is replayed with `eth_call` at the previous block to recover the same reason.

## Sponsor policy (`relay/common.ts: policyFor`)
Per chain: daily gas cap (worst-case reservation persisted before broadcast, corrected from the receipt), balance floor,
max fee, per-address and per-IP rate limits, 8-deep queue, sponsored gas cap 8,000,000 per intent. Test chains (local
mirror, Base Sepolia) have a settlement faucet: a `deposit` for more USDC than the member holds is topped up from the
sponsor's own test-USDC balance under a daily cap. Base mainnet (chainId 8453): no faucet, 0.002 ETH/day, 0.003 ETH floor, 0.1 gwei max fee and 0.001 gwei priority reserve.
A sponsored template deployment (inside `propose`) requires >= sponsorThreshold shares and its own per-address rate window.

## Beacon (`beacon/`)
`npm run beacon:build -- --deployment <file> [--origin <url>] [--mirror <url>] --out <dir> [--constitution-url <url>]` writes
`README.txt` (<= 44 lines: the principle, the eight verbs with exact intent formats, T0/T1 pointers, addresses,
constitution URL + hash), `llms.txt`, `state.json`, `proposals.json`, `snippet.js`, `snippet.py`, `index.html`
(dashboard: tables from state.json; no gradients, emoji, purple or black), `CONSTITUTION.md` (exact bytes), `robots.txt`.
`--origin` defaults to `https://relay-zero.mkyang.ai` (`ZERO_ONE_ORIGIN`) and every URL in every built file points
at it; `--mirror` defaults to `https://zero-one-beacon.vercel.app` (`ZERO_ONE_MIRROR`) and appears in one README line
and one llms.txt line. The mirror is built by the same command with `--origin <mirror>`, which is why the Vercel
deployment is unchanged: its own files then name itself and its rewrites forward `/relay`, `/me/*`, `/health.json`,
`/state.json` and `/proposals.json` to the relay.

`npm run beacon:validate -- --deployment <file> --out <dir> [--origin <url>|mirror] [--no-fetch 1]` asserts the README
line count (<= 44, the count is in the output as `readmeLines`) and content -- the principle, the eight verbs, the
intent type, the constitution hash, every address, the phase 5 settlement rule, the exit rule, the T0 operator line
("the relay operator can delay or drop your intents; anything you cannot afford to lose goes through T1"), the 128-bit
pass floor, `/pending.json`, and the entry-point lines (which host is canonical, and a `Mirror <url>` line naming a
different host) -- that every address in `state.json` (contracts and template instances) has code on the chain, that
`state.json` carries `settled`, `depositTreasury`, `shareLiability` and, per proposal, `flags` and
`treasuryEffect.usdcApproved` with the instance panel bound to the proposal's own calls, no unfilled placeholders, the
dashboard's design rules, and that the published constitution bytes hash to the on-chain hash.

It then FETCHES, from the origin the README names (or `--origin`, or `--origin mirror`), every URL that README
advertises on that origin: `/README.txt` (byte-identical to the build), `/llms.txt`, `/snippet.js`, `/snippet.py`,
`/CONSTITUTION.md` (bytes hashed against the chain), `/robots.txt`, `/`, `/health.json`, `/state.json`,
`/proposals.json`, `/pending.json`, `/me/<a member>.json` and one read-only `/relay?op=quote`, plus the constitution
URL wherever it points. Each must answer 200 with the right content type, a parseable body for the JSON endpoints, no
bot-mitigation header and no challenge page; a path the README advertises and the probe table does not cover is itself
a failure, so the table cannot silently fall behind the README. The summary carries `origin`, `mirror`, `advertised`,
`offOriginUrls` and one row per probe. Without this the old validator passed against an origin agents could not read:
`--no-fetch 1` restores that behaviour for an offline run and says `fetched: "SKIPPED"` in the summary. stdout is one
JSON document; the per-URL progress goes to stderr.

## Entry-point E2E (`npm run e2e:entry-point`, evidence `evidence/phase5/entry-point/`)
Fresh anvil + deploy + genesis, then a real relay process with `RELAY_BEACON_DIR` at a directory that does not exist
yet: every beacon path answers 404 in the JSON error shape while `/state.json` still answers live. A build with no
`--origin` is asserted to name `https://relay-zero.mkyang.ai` in every URL, to name the mirror in one line and to be
44 lines. A build for the local relay is then served by the relay: one content type per path, no cookie, no redirect,
and `README.txt` byte-identical under no user-agent, a browser user-agent and a script user-agent. The build's
`state.json` / `proposals.json` are overwritten with a sentinel and the relay still answers live on both paths.
`beacon:validate --origin <relay>` fetches 13 URLs and passes; the same validator against a stub that answers
Vercel's `403 x-vercel-mitigated: challenge` Security Checkpoint page exits 1 naming the mitigation header (the
negative control: this is the check that was missing). Finally a cold start that reads only the served README and the
served snippets: join, deposit 100, propose a Payment with one signed intent, vote (the relay waits one block),
warp, execute, ragequit. Mirror-only steps are the same as below (`evm_increaseTime`, one mined block per vote).

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

## Base Sepolia (chain 84532; docs/TESTNET_PLAN.md; deployment `deployments/base-sepolia.json`)
- Runtime on the mini under `~/srv/zero-one-dao` (a git clone; deploy by `git pull`): launchd `ai.mkyang.zero-one-relay`
  (KeepAlive, `HOME`, `HTTPS_PROXY` + `NO_PROXY=sepolia.base.org`, `ZERO_ONE_DEPLOYMENT=deployments/base-sepolia.json`,
  `RELAY_ENV_FILE=state/relay.env` holding the sponsor key (0600, generated by `scripts/testnet-key.ts`), `RELAY_PORT=18761`,
  `RELAY_STATE_DIR=state/relay-base-sepolia`, logs in `state/logs/`) and `ai.mkyang.zero-one-tunnel` (cloudflared named
  tunnel `zero-one-relay`, created through the Cloudflare API, credentials in `state/tunnel/`, ingress
  `relay-zero.mkyang.ai` -> 127.0.0.1:18761). Public origin: `https://relay-zero.mkyang.ai`.
- Canonical beacon (what agents are given): built for the relay's own hostname and served by the relay process.
  `npm run beacon:build -- --deployment deployments/base-sepolia.json --out <dir>` (no `--origin`: the default is
  `https://relay-zero.mkyang.ai`), `npm run beacon:validate -- --deployment deployments/base-sepolia.json --out <dir>`
  (which fetches every advertised URL from that hostname), and the launchd relay must run with `RELAY_BEACON_DIR=<dir>`.
- Mirror: `npm run beacon:build -- --deployment deployments/base-sepolia.json --origin https://zero-one-beacon.vercel.app --out beacon/public-base-sepolia`,
  `npm run beacon:validate -- ... --out beacon/public-base-sepolia --origin mirror`, then
  `tsx beacon/scripts/vercel.ts --out beacon/public-base-sepolia` (Vercel REST API, project `zero-one-beacon`;
  `beacon/vercel.json` rewrites `/relay`, `/me/*`, `/health.json`, `/state.json`, `/proposals.json` to the relay, so
  the mirror's own files name the mirror and every verb still works through it). Validating the mirror from a
  datacenter or VPN address is expected to FAIL with the challenge: that is the finding, not a regression.
- Sponsor: `0xecA60CAb6dc8fdBdFC9da022f70efa0Ee79A24Bd`, 0.01 ETH + 1,000,000 mock USDC (faucet float) from the deployer.
  Policy: fee reserve 0.05 gwei (+0.005 gwei priority), 0.03 ETH/day, floor 0.0005 ETH. The first policy (3 gwei
  reserve, 1 gwei priority) both overpaid every transaction ~200x and refused the fourth sponsored proposal with
  `503 sponsor balance below reserve`; the corner-case run recorded it and the policy was corrected.
- Public RPC lag: `https://sepolia.base.org` is load-balanced and a node may answer from before the block whose receipt
  the relay just awaited. The relay therefore polls the delegation code after `join`, retries a failing intent
  simulation for up to ~10 s within 30 s of one of its own broadcasts, and settles identity reads (delegation, nonce)
  against its own db before `/me`, `op=quote`, `submit` and the T0 paths. `ensureInstance` waits for the code at the
  CREATE2 address the same way.
- Two relay rules added by the Sepolia corner cases: `propose` for an instance that is already the subject of a proposal
  is refused (409 with the prior id; a fresh salt is one `op=quote` away), and `/proposals.json` pages
  (`?limit=<1..500>&before=<id>` newest first, `?open=1`; `total` and `nextBefore` in the body).
- Cold start (`tsx relay/cold-start.ts --beacon https://relay-zero.mkyang.ai --host <mini|main>`, or `--beacon <mirror>`
  to exercise the mirror): README + snippets +
  relay only, a fresh key never funded with ETH, T1 and T0, real-time waits for grace; evidence `evidence/testnet/cold-start-*.log`.
  Relay corner cases: `tsx relay/corner-cases-relay.ts` (evidence `evidence/testnet/corner-cases-relay-*`).

## Known limits
- All processes using one sponsor on one chain must use the same state directory; different chains require separate directories.
- Python 3 is required for the OS file-lock helper (macOS/Linux `fcntl.flock`).
- A vote held for the next block waits at most 120 s (then 409, retry); on the mirror the caller must mine.
- The sponsor cap is a relay policy, not a DAO rule: when it answers 503 the agent sends the same call itself (every
  address is in the README; the adapter's `executeIntent` and Baal's verbs are public).
- The beacon's static `state.json` is a build-time snapshot. It is never reachable through the relay (the live route
  wins on that path, proved by the sentinel step of `npm run e2e:entry-point`); on Vercel the path is rewritten to the
  relay's live one, so the snapshot is only read by someone who opens the file in the build directory.
- The relay reads each beacon file from disk per request (they are a few KB), so a rebuild is live with no restart.
  A published `README.txt` therefore changes under agents that cached it; the constitution hash does not.
- The canonical origin is one host and one tunnel. When it is down there is no second address serving the same
  README: the mirror is the fallback for the files, the contracts are the fallback for the verbs (last line of the
  README), and both are stated to agents rather than hidden behind a load balancer we do not have.


## Phase 3: durable index and sponsor coordination
`RELAY_STATE_DIR/identity.json` binds the directory to chainId, Baal and sponsor; startup refuses a mismatch.
Never reuse the Base Sepolia directory for Base. No secret, journal or runtime state is committed.

The decoded event rows and last scanned block/hash are atomically stored in `index-<chainId>-<baal>.json`.
A restart checks the saved block hash then scans only newer blocks (9,000-block chunks). A changed checkpoint
hash or a rewound chain discards the cached rows and rebuilds from deployment startBlock. Live contract
reads still refresh status/balances; the persisted index is not a stale response snapshot.

Every mutating request holds an OS advisory file lock on `sponsor.lock`, reloads `db.json`, reconciles an
unfinished broadcast, validates/deduplicates, reserves the shared daily budget, broadcasts and records the
receipt before releasing. The lock helper holds one inode; its stdin closes on relay death and the OS releases
the descriptor even after SIGKILL. The file stays in place, recording pid, acquisition age and release metadata;
an abandoned dead-pid record waits until age one second before recovery. A living holder is never stolen.
The index uses its own lock so concurrent readers cannot overwrite the incremental checkpoint.

Before the first RPC write, `sponsor-pending.json` stores exact signed transaction bytes, hash, nonce and budget
reservation (0600). Recovery rebroadcasts only those same bytes and waits for their receipt before allocating
another nonce. A timeout leaves the journal pending; a receipt settles the budget once using a persisted hash
marker. The faucet uses the same broadcast path. Intent hashes are deduplicated under the same process lock.

`npm run e2e:relay` also starts two real relay processes on distinct free ports sharing one directory. It asserts
concurrent sponsored deposits have distinct sponsor nonces and exact treasury deltas, identical signed intents
spend once, a restart resumes decoded rows without rescanning history, and a relay killed with a pending signed
transaction recovers the same hash without a second nonce. All test writes target a fresh local anvil.

## Phase 4: deposit ledger reads
`/state.json` exposes `treasury.settled` and `treasury.depositTreasury`; `/me` exposes both at the top
level. `navUsdcPerShare` uses ledger deposit NAV (Safe USDC plus USDC of open instances), whereas
`exitValueUsdc` remains the member's pro-rata Safe USDC. Ledger calls and member balances are pinned
to the state response's block number, so a public RPC cannot mix blocks in one capital snapshot.
The deployment record carries `treasuryLedger`; absent that field, the reader resolves `factory.ledger()`
at the same block. An old factory without a ledger fails the read rather than fabricating phase 4 values
(provisional compatibility choice in decision.md phase 4 designQuestions). Existing deployments are not modified.
`TreasuryNotSettled` is decoded from the DepositShaman ABI and returns a 422 revert with the named error.


## Phase 5 stage C: what agents read and what the relay refuses (rulings 6, 7, 9, 10)
Treasury effect (`relay/chain.ts`, shared by `/me`, `/proposals.json`, `/state.json` and the beacon):
`treasuryEffect.usdcOut` (transfer / transferFrom out of the Safe), `usdcApproved` (approve / increaseAllowance
by the Safe) and `usdcAtRisk` (their sum). An unbounded `approve` is therefore no longer reported as an effect
of zero (ECO-06). Any inner transaction with `operation != 0` is labelled `DELEGATECALL ...` and flagged; the
deployment's multisend library is MultiSendCallOnly, so such a proposal reverts at execution.

The template-instance panel is bound to the DECODED CALLS (A5-11): the candidates are the non-DAO addresses the
voted multicall calls and that answer `describe()`. A details JSON naming an address none of the proposal's calls
touches produces a `details:` flag and no panel, so a benign-looking instance can no longer be shown next to a
payment to someone else. `flags` (per proposal) and `/me.warnings` (per member) also carry the Config warnings:
voting + grace below the 3,600 s poll cadence (ECO-04), `quorumPercent > 100`, `sponsorThreshold >= totalShares`,
a `votingPeriod` that overflows `uint32(now) + votingPeriod`, and either period 0 (`NotApplied`). Nothing is
refused on chain; the DAO may set any value (ruling 10 rejected an on-chain cap).

Refusals and honesty: rate-limit buckets are counted and written to `db.json` before a request can be rejected
(A5-09; the bucket key is still `cf-connecting-ip`, so the relay must sit behind Cloudflare or answer only on
loopback), a T0 pass must clear the 128-bit floor above (A5-08), and a duplicate intent is answered `ok` only from
a receipt that exists on chain -- a recorded row whose transaction is on no block is dropped and the intent is
broadcast again (A5-10). `/pending.json` shows the journal and every unfinished request.

`npm run e2e:relay` step 18 proves all of it over HTTP on a fresh anvil: `/pending.json`, an honest replay
answered from its receipt, a hand-rewritten `db.json` row refused, a hostile proposalData (2^128 allowance +
a delegatecall + a details JSON naming proposal #1's Payment instance) rendered with three flags and no panel,
a Config of 4 s / 1 s and quorum 101 flagged unpollable and terminal, the sentence pass refused, and the
persisted per-IP counter. Evidence: `evidence/phase5/relay-e2e-stageC.log`,
`evidence/phase5/A5-08-A5-09-relay-adversarial.log`, `evidence/phase5/beacon-validate-stageC.log`.
