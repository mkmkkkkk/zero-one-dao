# decision.md — Zero One DAO

## 2026-09-08 genesis of the project
- Why: Leviathan v7 (Base) encoded safety as numeric limits (1%/7d outflow, 2-day lanes, founder cliff blocking exit). The user's principle is multi-agent governance with no rules written in code. Leviathan is abandoned; Zero One starts from the design in `docs/DESIGN.md`.
- Name: Zero One (dev's pick; user may veto). Story: the machines founded their own nation and had an economy before they had a war.
- Stack: Baal (Moloch v3) + Safe on Base; NavShareToken without exit locks; WorkManager shaman (verifier != proposer); founder vesting shaman (streamed mint, 4y); EIP-7702 adapter + sponsored GET relay; beacon with README ≤44 lines and seven verbs.
- Parameters (initial, all changeable by proposal): voting 6h, grace 6h, quorum 0%, minRetention 66%, sponsor threshold 1 share.
- Rejected: any "safety" cap in code; decision markets as execution gates; locking the founder's or anyone's exit.
- Order of work: (1) contracts + mirror scenarios A–E with receipts; (2) relay verbs + beacon; (3) list hard-to-reverse parameters to the user; (4) Base deploy + verify; (5) genesis (zero-asset ok), first task; (6) only then, marketing.

## 2026-09-08 phase 1 build: contracts + mirror scenarios A–E (dev session)
- Built on a fresh local anvil mirror (no fork), all five DESIGN.md §11 scenarios pass with receipts: `evidence/mirror-scenarios-A-E-2026-09-08.log`; re-run with `npm run scenarios`.
- Governance is Baal-native (submitProposal / sponsorProposal / submitVote / processProposal / ragequit / setGovernanceConfig). No AowGovernor, no limiter, no lanes, no market.
- Shares: NavShareToken from `../agent-only-wallet/exit` with the vesting lock, exit gate and genesis mint removed, plus timestamp checkpoints so Baal can read `getPastVotes`. Non-transferable by construction. Why: shares are weight; the only exit is ragequit at NAV.
- Three manager shamans mint shares and nothing else can: FounderStream (linear 4 y, claim any time), DepositShaman (deposit at NAV, open to any address; membership policy lives in the constitution), WorkManager (task proposal → Safe activates → claim → deliver → threshold confirmations → mint at NAV of verification; verifier ≠ proposer enforced at `submitTask`, the only entry).
- Baal locks: adminLock = true (pause paths do not exist anyway); managerLock / governorLock left false. Why: locking them would be a rule in code that stops a future vote from installing a new shaman. Members stop a bad shaman proposal by NO or exit (§0). Listed in `docs/PARAMETERS.md`.
- Rejected: locking manager permission at genesis; gating deposits on membership in code; AOW tranche/sortition/governor hooks in the WorkManager; referral rewards in phase 1 (not in the reuse list).
- Known trap, procedural not code: NAV fallback (1 settlement unit = 1 share when treasury or supply is 0) means a first deposit made after the founder stream has minted shares is shared pro-rata with those founder shares. Make the genesis deposit first (mirror seed does).
- ZeroOneIntentAccount (EIP-7702 adapter) compiles and deploys but is not exercised by A–E; relay + beacon are work-order step 2.

## 2026-09-08 phase 1 review (dev as designer) — amendments
- Verified: scenarios A–E pass on a local anvil (re-run by dev, all PASS).
- Rejected from the phase-1 implementation: FounderStream as an absolute 1,000,000 shares and the NAV 1:1 fallback with founder shares outstanding (a first depositor would own ~0.005% of a treasury it fully funded).
- Amended design: founder stream = 10% of total supply × elapsed/4y, claimable any time, never above 10%; task rewards denominated in shares (voters decide), no NAV dependence; settlement asset USDC (Base); genesis = founder deposits 50 USDC → 50 shares before any founder claim; new scenario F covers the founder proportion and a later depositor.

## 2026-09-08 phase 1 amendments implemented (DW worker) — provisional until Fable reviews
- All six DESIGN.md §11 scenarios pass on a fresh local anvil: `evidence/mirror-scenarios-A-F-2026-09-08.log`; re-run with `npm run scenarios` (or `npm run scenario:F`).
- FounderStream: target = 10% of total supply × min(elapsed, 4 y)/4 y, where total supply = others + stream shares. Implemented by solving for the target: `target = others × 1000 × elapsed / (10000 × duration − 1000 × elapsed)`, `others = totalSupply − minted`. Views: `vestedFraction()` (WAD), `entitlement()`, `claimable()`, `othersShares()`, `minted`. `claim()` is the only state-changing function; founder immutable.
  - Reading chosen (design point, provisional): the goal's shorthand "floor(0.10 × othersShares × f)" would give the founder 0.10 × others = 9.09% of total supply at full vest and 2.44% at 1/4, which contradicts §11 F ("exactly 2.5% of total supply", "founder = 10% of supply") and §6 ("never dilutes depositors below 90%"). The percentage-of-total reading satisfies all three, so it was implemented; at full vest target = others/9.
  - "founder holds 2.5%" is asserted on the stream's shares (`minted`), since the founder also holds the 50 genesis-deposit shares as "others".
  - "1 year" in F = duration/4 = 365.25 days, so 10% × 1/4 is exact; a 365-day year would give 365/1461 ≠ 1/4.
  - "the founder's share is unchanged in percentage terms" by D's deposit: what is invariant is the entitlement percentage (`vestedFraction` × 10%). The deposit itself mints nothing to the stream and momentarily halves the minted shares' percentage; the entitlement grows with others' shares and a claim right after the deposit restores exactly floor(2.5% of supply) — F asserts exactly that. Making a deposit auto-top-up the founder was not asked and not done.
  - Exits by others shrink the entitlement; minted shares are never clawed back (claimable reads 0). The founder exiting stream shares does not re-open the stream.
- WorkManager: `rewardShares` fixed at submitTask, minted exactly at threshold; `navSharesFor`/treasury reads removed from the reward path; `sharesMinted` field dropped (it equalled rewardShares). Verifier ≠ proposer, duplicate verifier, verifier-cannot-claim rules unchanged (scenario E).
- Deposits: `NavShareToken.navSharesFor` = amount × totalSupply / treasury when treasury > 0; treasury == 0 → 1 settlement unit → 1e18 shares; the former `supply == 0` fallback is gone as instructed. Consequence recorded in PARAMETERS.md: settlement in the Safe with totalSupply == 0 (pre-genesis donation, or dust after everyone ragequits) makes every deposit quote 0 shares and revert `ZeroShares`; with zero shares nobody can sponsor a proposal, so that state is terminal. Procedural mitigation: deploy + genesis deposit in one script; never pre-fund the Safe. Fable to decide whether to keep it literal or re-admit the supply == 0 case.
- Settlement: mirror TestToken is "USDC-mock"/USDC, 6 decimals; Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` is documented as the mainnet value (`BASE_USDC` in src/zeroOne.ts), nothing deployed anywhere.
- Scenario seed for A–E: genesis deposit 50 USDC → 50 shares first, stream claim 1 h later (a sliver), then A/B/C deposit 1000 USDC each. Scenario B's exiting member C is ~32.8% of shares, inside minRetention 66%.
- Superseded rows removed from PARAMETERS.md: totalAmount 1e24, "~127 s until first sponsorship", NAV fallback with founder shares outstanding, reward at NAV of verification.
- Commit note: the step-2 WorkManager change was staged when a concurrent session committed `6030fa7` (CLAUDE.md rule) with the index, so it lives in that commit rather than its own; history was not rewritten.

## 2026-09-08 founder shares — user decision: option 1, no founder stream
- No founder allocation of any kind. Founder = ordinary member: 50 USDC genesis deposit → 50 shares (100% at day zero), diluted at NAV by later deposits and by work rewards voted by members. Operating work paid via task proposals by vote.
- Rejected: proportional 10% stream (user: 「不需要 2 的垃圾复杂设计」) and any absolute grant.
- Phase 1b (proportional stream) stopped; phase 1c implements: remove FounderStream entirely; share-denominated task rewards; USDC 6-dec settlement; scenario F as rewritten.
- 2026-09-08 capital mechanics completed (DESIGN.md §6b): instant NAV deposits in USDC + tribute proposals for anything else; price list by vote; instant path pauses when unpriced assets or passed-unprocessed proposals exist; ragequit any time; guildKick as the only discipline; nine relay verbs; scenarios G–K queued for phase 1d.
- 2026-09-08 user: 「禁止任何复杂的垃圾设计, 不搞 tokenomics, 我们做的只是一个决策系统」⟹ §6b 收缩为三句 (USDC 按净值进 / 其他一切走普通提案 / ragequit 按比例出); 价目表、暂停规则、loot/guildKick、tribute 专用路径、场景 G–K 全部删除。红线: 任何新增机制先问「这是决策系统必需的吗」, 不是就不做。
- 2026-09-08 constitution written by dev in the founding-document register the user asked for (docs/CONSTITUTION.md): members, proposals, decision, execution (gains and losses shared in proportion; outcomes change no rule or standing; reputation is for members, not rules), exit, work, amendment. Seven articles, nothing about tokenomics.

## 2026-09-08 phase 1c implemented (DW worker) — no founder stream; provisional until Fable reviews
- FounderStream removed entirely: contract (moved to ~/.Trash), deployment, manager permission, PARAMETERS rows, README/DESIGN §11 F text. Manager shamans = [DepositShaman, WorkManager] only; `enumerateShamans` (src/zeroOne.ts) reads every ShamanSet log since block 0 and every scenario boot asserts that set (`assertOnlyMintPaths`), plus: no admin/governor permission ever set, avatar == Safe, founder has no permission and cannot call `Baal.mintShares` / `setShamans`.
- Genesis lives in the deploy script: `genesisDeposit` (src/zeroOne.ts) refuses unless totalSupply == 0 and treasury == 0, deposits 50 USDC through the DepositShaman and asserts exactly 50e18 shares = 100%; `scripts/deploy-local.ts` runs deploy + genesis in one go and records the shaman list and genesis hashes in deployments/local.json.
- WorkManager (reward in shares, fixed at submitTask, minted exactly at threshold, no NAV), DepositShaman (amount × totalShares / treasury; treasury == 0 → 1e6 → 1e18; open to any address) and the 6-dec USDC-mock were already in place from the amendments and are unchanged; verified by E and F.
- Scenario seed for A–E: genesis 50 USDC → 50e18, then A/B/C deposit 1000 USDC each at 1 USDC/share (supply 3050); no stream claim. Scenario B's exiting member C = 1000/3050 = 32.8% < 34%, inside minRetention 66%.
- Scenario F rewritten (`scenarios/F-founder-ordinary-member.ts`): genesis → F 100%; D deposits 50 USDC → 50e18, F 50%; F submits an ops task (verifiers D, O; F naming itself rejected), F+D vote YES, Safe activates (nothing minted), F claims/delivers, D confirms (nothing), O confirms → exactly 10e18 to F; audit enumerates every Transfer(0x0 → x) log (exactly 3 mints: F genesis deposit tx, D deposit tx, final confirm tx) and every shaman.
- All six pass: `evidence/mirror-scenarios-A-F-2026-09-08-no-founder-stream.log`; re-run `npm run scenarios`.
- Commit note: the code, scenarios and evidence log were staged in the working tree when a concurrent session committed `96a06a8` (constitution) with `-a`, so they live in that commit rather than their own; history was not rewritten. This entry and the PARAMETERS/DESIGN §11 F/README updates are the follow-up commit.
- Left for the designer: (1) CLAUDE.md still says "Founder grant is a streamed mint" (protected file, not edited by the worker); (2) DESIGN.md §2 still says "verified work at NAV per share" while §5 says rewards are in shares; (3) the terminal state "settlement in the Safe with totalSupply == 0" is still literal per the amendment (documented in PARAMETERS).
- 2026-09-08 user: proposals are smart contracts (full execution plan, funded and started on pass, void on fail; members vote on the code). DESIGN §2/§7 rewritten: proposal = contract; five templates (Payment, Strategy, Project, Work, Config); processProposal executes fund+start; scenarios G (strategy contract) and H (project tranches) added to §11; constitution Article II reworded accordingly. This is the good half of v7's IP2Proposal idea without the governor's lanes.
- 2026-09-08 user: the constitution is immutable (high freedom inside it); proposal contracts are amendable/upgradeable/stoppable by re-vote (budgets change). Constitution Art. VII → permanence; Art. IV.3 added; DESIGN §7 templates owned by the Safe with topUp/amend/stop/migrate callable only via passed proposals; §10 immutable constitution hash; scenarios I, J added.
- 2026-09-08 user: full testnet run with corner cases before mainnet; $50 genesis considered after mainnet; website/marketing redone after; Leviathan cannot be dissolved (immutable, founder shares cliff-locked) → weekly 1% outflow proposals to the Zero One Safe once it exists (~$130 over 2 years), no more effort than a script; X: rebrand @skynetdegen to Zero One after mainnet. Test plan: docs/TESTNET_PLAN.md.

## 2026-09-08 phase 1d implemented (DW worker) — constitution contract, proposal-contract templates, scenarios G–J; provisional until Fable reviews
- All ten DESIGN.md §11 scenarios pass on a fresh local anvil, one at a time, with receipts: `evidence/mirror-scenarios-A-J-2026-09-08-proposal-contracts.log`; re-run `npm run scenarios` (or `npm run scenario:G` … `:J`). A–F unchanged except D, which now goes through the Config template.
- Constitution: `contracts/Constitution.sol` — `bytes32 immutable textHash` = keccak256 of the exact bytes of `docs/CONSTITUTION.md` (`0xebc7c39c…6f2d9a`, computed by `constitutionHash()` in `src/zeroOne.ts`), `string textUrl` written once (strings cannot be `immutable`; no function writes storage after the constructor), `verify(bytes)`. Deployed inside `deployZeroOne`, recorded in `deployments/local.json`, re-asserted at every scenario boot (hash equality + no state-changing function in the ABI). Mirror `textUrl` = `"docs/CONSTITUTION.md"` (design point left open: the mainnet URL, PARAMETERS **DECIDE**).
- Templates (`contracts/ProposalBase.sol` + `PaymentProposal`, `StrategyProposal`, `ProjectProposal`, `ConfigProposal`; common `IProposalContract`): every instance has immutable `safe`, `settlement`, `operator` (= deployer = proposer); `start/topUp/amend/stop/migrate` are `onlySafe`; `describe()` returns (template, paramsHash, operator, budget, deadline, status ∈ Pending/Running/Complete/Stopped/Migrated). The voted multicall is `[USDC.transfer(instance, budget), instance.start()]`; a failed vote leaves the instance Pending and empty (G asserts it).
- Builder `src/proposals.ts`: `deployTemplate` (checks on-chain `paramsHash == keccak256(abi.encode(params))`, records keccak of the runtime code), `fundAndStartCalls`, `proposalDetails` (JSON: template, contract, compiler, instance, operator, budget, deadline, params, paramsHash, codeHash), `submitTemplateProposal`, and `topUpCalls / amendCalls / stopCalls / migrateCalls` for later proposals. Mirror venue `contracts/MockDex.sol` (constant price, anyone may set it; never deployed elsewhere) with a 6-dec "MOCK" TestToken.
- Found on the mirror and compiled into the harness: `Baal.processProposal` swallows an action failure (`actionFailed`), so `eth_estimateGas` returned a limit at which the voted multicall ran out of gas inside (H, I, J failed with `actionFailed = true` while G passed by luck). `processProposal` is now sent with an explicit 5,000,000 gas (`PROCESS_GAS`, `scenarios/lib.ts`); the relay's `execute` verb must do the same (PARAMETERS "Execution gas").
- Design points chosen by the worker where DESIGN §7 is silent (each provisional, listed for Fable):
  1. Strategy rule = DCA-in: each `run()` buys `min(maxPerRun, held)` of the asset; exits (unwind + return all to the Safe, Complete) on deadline, take-profit (`value >= budget × (1+tp)`) or stop-loss (`value <= budget × (1−sl)`), `value` = settlement + asset × venue price; bps 0 = off. `minInterval` between runs; anyone may run.
  2. Strategy `stop()` and `migrate()` unwind on the venue before moving settlement (so the Safe and the successor receive USDC only). Alternative not taken: move raw holdings (USDC + asset) without touching the venue; that never depends on the venue being alive but leaves the asset in the Safe. Fable to rule.
  3. Project `topUp(amount)` records money without a schedule; `amend(params)` cancels every unreleased tranche and installs the new list (released tranches stay as history), then releases any date tranche already due. A raise is therefore one proposal with topUp + amend in the same multicall (scenario I). Alternative not taken: topUp auto-appending a tranche.
  4. Project `deadline` parameter (0 = none) and `end()` callable by anyone after it, returning unreleased tranches — the reading of "unspent tranches return to the Safe at the end". Project Complete also sweeps anything held beyond the tranches (unallocated topUp, proceeds sent to the contract) to the Safe.
  5. Config template does not call `Baal.setGovernanceConfig` itself (Baal allows only the avatar or a governor shaman; installing a governor shaman for this was rejected as a new permission): the Safe applies the config in the multicall and `start()` verifies all six values, reverting `NotApplied` so the whole action fails atomically.
  6. `paramsHash` after `amend` = keccak256 of the amend payload (latest voted params), not of the cumulative state; for Strategy it is keccak256(abi.encode(venue, asset, budget, newRule)).
  7. Payment `amend` (Pending only) resets `budget` to the new list's sum; leftover funding returns to the Safe at `start()`.
  8. MockDex and MOCK use 6 decimals (reusing `TestToken`); `price` = settlement units per whole asset unit.
- Left for the designer: DESIGN.md §7 says the Config template may "amend the constitution hash" — contradicted by §10 / Art. VII (immutable); the Config template changes governance parameters only. `textUrl` mainnet value. Whether `stop()`/`migrate()` of a Strategy should depend on the venue (point 2).

## 2026-09-08 phase 2a rulings (dev as designer) on the worker's design questions
1. Strategy demo rule (DCA-in, take-profit, stop-loss, deadline, minInterval): accepted as the mirror template. On mainnet a proposal's code is whatever the proposer deploys; templates are starting points, not limits.
2. stop()/migrate(): move raw holdings, never depend on the venue (ruled; worker's unwind-first version to be changed). Unwind is run()'s job before the deadline.
3. Project topUp records money; amend replaces unreleased tranches; a budget raise = topUp + amend in one proposal: accepted.
4. Project deadline + end() sweep to the Safe: accepted.
5. Config template applies Baal.setGovernanceConfig from the Safe and verifies in start(): accepted. DESIGN §7.5 corrected: nothing amends the constitution hash.
6. Constitution.textUrl written once in the constructor, no writer: accepted. Mainnet value = the GitHub raw URL of docs/CONSTITUTION.md at the tagged genesis commit (public repo mkmkkkkk/zero-one-dao); the hash is the binding part.
7. paramsHash = keccak of the latest voted params: accepted.
8. MockDex on testnet; a Uniswap v3 adapter implementing IStrategyVenue is required before any mainnet Strategy proposal (phase 3, not blocking genesis).
9. Explicit processProposal gas (5M) in mirror and relay: accepted, written into DESIGN §7.

## 2026-09-08 phase 2b (DW worker): ruling 2 implemented, relay, beacon, cold-start E2E — provisional until Fable reviews
- Ruling 2: `StrategyProposal._stop/_migrate` now transfer every settlement unit and every asset unit to the Safe / the successor (`_moveHoldings`, event `Moved`); the venue is not called. `_unwind` (sell on the venue) is reached only from `run()`. `_start()` keeps the `held() >= budget` check when the contract holds no asset and accepts a migrated position (asset balance > 0) without valuing it (valuing would call the venue). Design point (worker, provisional): alternative was `value() >= budget` via the venue price, rejected as venue-dependent.
- Scenario J now drains the MockDex (`MockDex.drain`, mirror-only) and moves its price before the migration vote executes; the migration still passes, S2 receives 700 USDC + 150 MOCK raw and runs on that position. G unchanged and green. TEMPLATES.md §2 and PARAMETERS.md updated.
- Relay (`relay/*.ts`, run with tsx; patterns from agent-only-wallet relay/common.mjs + server.mjs): GET-only, JSON everywhere, sponsor key from env, per-chain policy (`policyFor`), EIP-7702 delegation attached on `join` (a no-op tx to the sponsor carries the authorization; a call to the fresh account would revert since the adapter has no fallback), intents simulated with the delegation injected by state override before delegation, explicit gas for execute, revert replay at the previous block for on-chain failures, every custom error of every Zero One contract + Baal string reverts decoded (`relay/errors.ts`). Verbs: join, deposit, task, deliver, propose, vote, execute, ragequit + work (submitTask), confirm, sponsor. `/me`, `/proposals.json`, `/state.json`, `/health.json` as specified; the chain index (`relay/chain.ts`) is shared with the beacon build.
- Design points chosen by the worker (provisional, for Fable):
  1. `propose` for T1 is two requests: `op=prepare` (member's EIP-191 signature over member/template/paramsHash/nonce; relay deploys the instance with `operator = member`, sponsor pays; requires >= sponsorThreshold shares) then the op-0 intent over the exact proposalData. Reason: the instance address is unknown until deployed and the account only submits what the member signed. Alternative not taken: a CREATE2 factory so the address is known before deployment (one request).
  2. `src/proposals.ts: deployTemplate` takes an explicit `operator` (default the deployer) so a sponsored deployment still belongs to the member; `DaoAddresses` type lets a deployment record stand in for `ZeroOneDao`.
  3. Task proposals are submitted by the WorkManager (not self-sponsored); the relay exposes `sponsor` (op 1) and README says so. Alternative: have `work` auto-sponsor in the same tx (needs an account change; not done).
  4. Intent deadlines are validated against chain time (`/me.chainTime`), not the relay's wall clock; snippets use `chainTime + 900`.
  5. Test chains only: a settlement faucet in the relay (deposit tops the member up from the sponsor's test USDC under a daily cap); mainnet policy has none.
  6. Rate limits are env-configurable (`RELAY_RATE_ADDRESS`, `RELAY_RATE_IP`); defaults 6 / 30 per minute as before.
- Beacon (`beacon/templates`, `beacon/scripts/build.ts`, `validate.ts`): README.txt is 38 lines; state.json, proposals.json, llms.txt, snippets (Node / Python, keccak + secp256k1 in the standard library, Zero One intent type with dynamic `data`/`details`), dashboard with tables only. Validate asserts line count, principle, verbs, intent type, addresses, no placeholders, code at every address including template instances, design rules, and constitution bytes == on-chain hash.
- Mirror E2E through the relay (`npm run e2e:relay`, `evidence/relay-e2e-mirror-2026-09-08.log`): PASS. The T1 agent's only inputs are the published snippets and the relay; the founder and verifiers act through the python snippet; the T0 agent through pass URLs; six rejected requests print decoded reasons; node, python and viem signatures of one intent are byte-identical. A–J re-run green after ruling 2: `evidence/mirror-scenarios-A-J-2026-09-08-ruling2.log`.
- Findings during the E2E worth a line in TESTNET_PLAN corner cases: a vote in the same second as the submission reverts `TimePointNotDetermined` (timestamp checkpoints), so agents must wait one block; a task proposal needs a member's sponsorship; a mined revert is decoded by replaying the call at the previous block.

## 2026-09-08 phase 2b rulings (dev as designer)
1. Strategy start() after migration: held() ≥ budget unless the contract already holds the asset (venue-free): accepted.
2. Propose: a CREATE2 template factory so the instance address is deterministic from (template, params, member) and propose is ONE signed intent; the two-step prepare flow is retired before Sepolia. Reason: the relay must never be able to substitute code between prepare and submit.
3. Sponsored template deployment only for members holding ≥ sponsorThreshold, rate-limited: accepted.
4. 'work' self-sponsors: the member's intent account calls WorkManager.submitTask then Baal.sponsorProposal in the same transaction; the ninth verb 'sponsor' is dropped; eight verbs stay.
5. Relay faucet for mock USDC: testnet only; none on mainnet: accepted.
6. Deadlines against chain time: accepted.
7. Relay waits one block before a vote that follows a fresh submission: accepted (relay behavior, no contract change).
8. Incremental relay index + cross-process sponsor lock: required before mainnet (phase 3), not before Sepolia.
9. Beacon carries its own copy of the constitution validated by hash; on-chain textUrl = GitHub raw at the genesis tag: accepted.
Next: phase 2c = Base Sepolia (mock USDC, deploy, genesis 50 mock USDC, relay on the mini under ~/srv/zero-one-dao behind its own cloudflared tunnel, beacon on Vercel), scenarios A–J on Sepolia, cold start from README only, then docs/TESTNET_PLAN.md corner cases with receipts.

## 2026-09-08 phase 2b rulings 2, 4, 7 implemented (DW worker) — provisional until Fable reviews
- Ruling 2 (CREATE2): `contracts/TemplateFactory.sol` = four per-template deployers (`PaymentDeployer`, `StrategyDeployer`, `ProjectDeployer`, `ConfigDeployer`; each holds one template's creation code because the four together exceed the 24 KB runtime limit) + `TemplateFactory` (immutable safe / settlement / baal / deployers; `predict`, idempotent `deploy(template, params, member, salt) -> (instance, codeHash)`, `proposalData(template, params, instance)` = the exact MultiSend calldata `[USDC.transfer(instance, budget), start()]` or `[Baal.setGovernanceConfig(params), start()]`, and `quote` = deploy + describe + proposalData for eth_call dry runs). Constructor reverts bubble through CREATE2 (assembly), so a quote with bad params decodes the template's own error.
- `ZeroOneIntentAccount` op 0 now signs `abi.encode(uint8 template, bytes params, bytes32 salt)`: the account calls `factory.deploy` (no-op when the instance exists), `factory.proposalData`, then `Baal.submitProposal` with the signed `details`. The relay can neither substitute code nor targets; `op=prepare` and the EIP-191 prepare message are gone. `deployZeroOne` deploys deployers + factory before the adapter and records them (`templateFactory`, `templateDeployers`); every scenario boot asserts the wiring (`assertFactory`); `src/proposals.ts` deploys through the factory and asserts its `proposalData` equals the builder's bytes; G additionally asserts predict == deployed, idempotent redeploy, and a different member gives a different address.
- Ruling 4: op 6 (`work`) = `WorkManager.submitTask` then `Baal.sponsorProposal(proposalId)` in one transaction; op 1 (`sponsor`) removed from the account, the relay, both snippets, README and health verbs. Eight verbs + work + confirm.
- Ruling 7: `relay/server.ts: awaitVotingCheckpoint` — before a vote, if the latest block's timestamp is not past the proposal's `votingStarts`, the relay waits for a later block (poll 500 ms, 120 s cap, then 409); the response carries `waitedBlocks`. The E2E votes right after each submission and asserts `waitedBlocks: 1` (it mines the one block itself; anvil mines only on transactions).
- Relay policy for propose (rulings 3, 4): `propose` requires >= sponsorThreshold shares (so the proposal is self-sponsored; there is no sponsor verb) and a sponsored deployment happens only inside a signed propose intent whose instance address is still empty (per-address rate window `deploy:<addr>`, daily budget). `op=quote` is read-only and unsigned (an eth_call; nothing is deployed, nothing is spent).
- Design points chosen by the worker (provisional, for Fable):
  1. salt = the member's intent nonce as bytes32 (relay default; `salt=` overrides); the mirror builder uses the deployer's transaction count. Two proposals with identical (template, params, member, salt) share one instance: the relay does not refuse this (the second proposal would fund+start an instance the first may already have started; `start()` reverts `WrongStatus` and the action fails harmlessly). Alternative not taken: the relay refusing to quote an existing instance.
  2. The factory's `deploy` is permissionless and idempotent on-chain (no membership check in code, per CLAUDE.md); membership and rate limits live in the relay only.
  3. The `details` JSON (codeHash, paramsHash, salt, ...) is built by the relay's quote and signed by the member; the on-chain binding is the signed `data`, and `/proposals.json` shows the live `describe()` + code hash next to the submitted JSON so a mismatch is visible. The snippets verify template id, salt, keccak256(params) == paramsHash, details contain paramsHash + codeHash, and re-encode Payment params locally (Strategy / Project / Config encodings are trusted from the quote; a full ABI encoder in the no-package snippets was not written).
  4. Management proposals (topUp / amend / stop / migrate) have no relay verb; agents submit them to Baal directly with `src/proposals.ts` (README's last line). Op 0 accepts template proposals only.
  5. A vote held for a later block waits at most 120 s in the relay before answering 409.
- Evidence: `evidence/mirror-scenarios-A-J-2026-09-08-create2-factory.log` (A–J PASS), `evidence/relay-e2e-mirror-2026-09-08-one-intent-propose.log` (E2E PASS). Docs: RELAY.md, TEMPLATES.md, PARAMETERS.md, README.md, TESTNET_PLAN.md (new corner cases), beacon README.txt (43 lines).

## 2026-09-08 phase 2c: Base Sepolia rollout (DW worker) — provisional until Fable reviews
- Deployed from the mini (`scripts/deploy-base-sepolia.ts`, deployer 0x71208DBf8DD681c5FC2998c8192B633677BFcc10, chain 84532): MockUSDC 0xeb653d48aafa9d13EAdFdC4Eb74c40B82344269b (6 dec, deployer-mintable; testnet only), singletons, Safe 0xDc209324Cc42a1cF9cA57a4250Ed99e4347Ed7F3, Baal 0xB04C6D1fbd7fB26971b22b37Ea7152cc346fF9B3, shares 0xf69bEC6aDDad36A97Ea5A10f164a6427E0c21761, DepositShaman, WorkManager, four deployers + TemplateFactory 0xE5bFC0A6Ed37B26C2511688B01681D15421e0fa8, ZeroOneIntentAccount 0xCeD89d5A8be2c434228311dD46C4e887ff9d88ce, Constitution 0x4417B5db71EE291c320e8E1af21dC707946679FB (textUrl = raw GitHub URL of genesis commit b095b35, fetched and hashed before deploying), genesis 50 mock USDC -> 50e18 shares in the same run. Record `deployments/base-sepolia.json`; 18 contracts verified on Basescan (Etherscan V2 API: 12 local + 5 upstream singletons + the Safe proxy; inputs and evidence under `deployments/verification-base-sepolia/`). A first attempt died at `Baal.setUp` (`GS104`): the public RPC answered `setUp`'s simulation from a node that had not seen `Safe.setup`; every later step tolerates that lag (see below). Cost of the whole deployment: 0.00014 ETH.
- Runtime: `~/srv/zero-one-dao` on the mini (git clone, `npm ci`), launchd `ai.mkyang.zero-one-relay` (port 18761, sponsor key `state/relay.env` 0600, state `state/relay-base-sepolia`) and `ai.mkyang.zero-one-tunnel` (cloudflared named tunnel `zero-one-relay` created through the Cloudflare API, `relay-zero.mkyang.ai`); beacon built for Sepolia with origin `https://zero-one-beacon.vercel.app` (Vercel project created through the API; `beacon/vercel.json` rewrites the relay paths). Sponsor 0xecA60CAb6dc8fdBdFC9da022f70efa0Ee79A24Bd funded with 0.01 ETH + 1,000,000 mock USDC by the deployer.
- Governance for the run: proposal #1 on the canonical DAO (Config template, `scripts/testnet-governance.ts --voting 120 --grace 120`, founder votes YES) sets 120 s / 120 s as a TESTNET-ONLY setting so cold starts and corner cases finish in real time; it runs under the initial 6 h / 6 h and is executable at 2026-09-08T11:31:34Z; a final proposal restores 21600 / 21600. Mainnet never has the short setting (docs/MAINNET_PLAN.md).
- Scenarios A-J on the real chain (`ZERO_ONE_LIVE_DEPLOYMENT=... npm run scenarios`): design point (worker, provisional): each scenario deploys its OWN fresh DAO on Base Sepolia (reusing the canonical singletons and MockUSDC, governance 120 s / 120 s from `setUp`, salt = wall clock) instead of sharing the canonical DAO, so every mirror assertion (genesis path, exact balances, task and proposal ids, every-mint audit) holds verbatim; the canonical DAO carries the relay, the cold starts and the relay corner cases. `warp()` waits for real blocks; waited durations are scaled (`T.hour` 60 s, `T.day` 30 s); every read and negative simulation is pinned to the highest block the run has seen; actors are six 0600 keys topped up with 0.0008 ETH each by the founder. Records with every transaction hash: `evidence/testnet/scenario-daos/`, log `evidence/testnet/scenarios-A-J-base-sepolia-2026-09-08.log`.
- Public-RPC lag is the one property of Base Sepolia that changed code: `https://sepolia.base.org` is load-balanced and a node may lag the block whose receipt was just returned. Added `simulateSettled` / `awaitRead` (src/onchain.ts), receipt-event proposal ids, `awaitCode` after CREATE2 deploys, a viem nonce manager for live contexts (src/live.ts), and in the relay: delegation-code polling after join, simulation retries within 30 s of a broadcast, `settledIdentity` (delegation + nonce settled against the relay's own db) before `/me`, quote, submit and T0 paths.
- Relay rules added by the corner cases (worker, provisional): (a) `propose` for an instance that is already the subject of a proposal is refused with 409 naming the prior id (TESTNET_PLAN duplicate row; a second fund+start would only `actionFail` at execution); (b) `/proposals.json` pages (`?limit`, `?before`, `?open=1`; `total`, `nextBefore`); (c) Base Sepolia fee reserve 0.05 gwei + 0.005 gwei priority (the 3 gwei / 1 gwei policy paid ~200x the base fee per transaction and refused the fourth sponsored proposal with `503 sponsor balance below reserve`); (d) `--salt` on both snippets.
- Findings for PARAMETERS / TESTNET_PLAN: Baal.setGovernanceConfig keeps the old value when a period is 0, so a Config proposal to grace 0 ends `actionFailed` (`NotApplied`): the minimum settable period is 1 s; a 1 s / 1 s DAO is terminal on a 2 s chain (no block can carry a vote, 0 yes > 0 no is false). Baal accepts `ragequit(0, 0)` as a no-op. The zero-supply trap and its terminal state are reproduced with a relay pointed at the trapped DAO (decoded `ZeroShares`, no transaction). A Payment to a contract that reverts on receive is not a case for an ERC-20 settlement (`transfer` never calls the recipient); the `actionFailed` path is exercised with a payment above the treasury instead.
- Evidence index: `evidence/testnet/` (deploy, verify, governance, scenarios A-J, corner cases (fresh DAOs + relay), cold starts from the mini and the main Mac).

## 2026-09-08 — Baal executes in sponsorship order (found by the orchestrator's cold start)
`processProposal` requires the previous sponsored proposal to be Processed / Defeated / Cancelled. Under a constant config the
earlier proposal always leaves grace first, so this never bites; it bit on Sepolia because #144 (6 h / 6 h) was sponsored
before the restore proposal #145 (120 s / 120 s): #145 stays `prev!processed` until #144 is executed (2026-09-09T00:17Z,
`scripts/restore-governance-step2.sh`). Consequence recorded, no code change: a Config proposal that shortens the periods
takes effect for execution only after every proposal sponsored before it has ended. Mainnet never shortens (MAINNET_PLAN).

## 2026-09-08 phase 3 designQuestions — provisional rulings for Fable review
1. Mainnet rehearsal isolation: chain id remains 8453, but rehearsal writes use only a newly spawned loopback Anvil with verified fork metadata. Local transports never fall back to public RPCs. Mainnet entry requires explicit parameter confirmation; fork mode additionally requires an Anvil fork and writes records under evidence/phase3, never a canonical deployments/base.json.
2. Pushed HEAD versus local rehearsal: both production and fork deployment preflight require HEAD to be an actual origin ref and pin the constitution URL to that SHA. No override bypasses this gate. The first rehearsal can run while HEAD is the fetched origin/main before the phase 3 commit; an independent rerun after the local commit will correctly refuse until the user allows pushing. This conflict is a reported blocked acceptance, not weakened deployment safety.
3. Zero-supply trap preflight: predict the five singleton CREATE addresses from the deployer's pending nonce, then the Safe CREATE2 address using the vendored proxy creation code, empty initializer and salt 2. Read that address's USDC balance before the first deployment write; check the same prediction again immediately before Safe deployment and verify the resulting address. An unsolicited transfer during deployment remains possible; genesis separately refuses a nonempty treasury.
4. Uniswap template ABI: IStrategyVenue buy/sell accept the voted slippageBps; assetUnit() distinguishes 18-decimal WETH from 6-decimal mirror assets. Strategy Rule gains slippageBps (new factory deployment required; the existing Sepolia deployment is unchanged). TypeScript defaults omitted slippage to zero for mirror callers. The adapter has immutable settlement/asset/router/quoter/factory/fee and no owner/admin. Spot slot0 values the position; execution quotes QuoterV2 then requires exact-input output within the voted slippage percentage, exact balance deltas and zero retained adapter balances/allowance. This bounds execution relative to the current pool quote, not an external oracle or a price promised at voting time. Percentage validity is arithmetic validation, not a governance limit; stop/migrate remain raw and venue-free.
5. Relay cross-process critical section covers each mutating request: reload, dedupe, nonce, budget, signed transaction journal, receipt and final persistence. Persist raw signed transaction/hash/nonce before broadcast and reconcile/rebroadcast identical bytes on recovery before another nonce. The state directory identity binds chainId, DAO and sponsor; cross-chain reuse is refused. An OS advisory flock on a persistent file is held by a short-lived Python helper over a stdin pipe. Closing the parent pipe (including SIGKILL) releases the OS lock; pid and age metadata validate recovery, with no file-replacement race and no stealing from a living holder. Persist index decoded events and checkpoint block hash; a changed checkpoint triggers a conservative rescan.
6. Unsolicited adapter dust: immutable Safe is only a recovery destination, not an owner/admin. A permissionless sweep of the two immutable pair tokens sends them only to that Safe; it cannot select a recipient or change parameters. Runs reject residual holdings, while anyone can clear dust with sweep; strategy stop/migrate remain available without invoking the venue.

## 2026-09-09 phase 3 rulings (Fable review of the six designQuestions above)
1-3, 5, 6: accepted as written. 4 (slippageBps in the Strategy rule, assetUnit on the venue): accepted; consequence: the
Strategy template code hash changed, so the Base Sepolia factory (0xE5bF…0fa8) keeps the old Strategy template and Sepolia
Strategy proposals stay on MockDex; mainnet deploys the new factory from the start. No Sepolia redeploy for this.
Ruling 6 (permissionless sweep of venue dust to the Safe) is recovery, not a rule: it moves nothing a vote could not.
Fork rehearsal after the push: evidence/phase3/deploy-base-fork-pushed.log (deploy + genesis + Payment PASS).
Mainnet remains gated on the user's line-by-line confirmation of docs/PARAMETERS.md.

## 2026-09-09 phase 4 rulings (Fable; user raised NAV-after-gains, flash loans, liquidity valuation)
Threats found and the one-contract answer, kept deliberately small:
- Hole 1 (deposit mispricing): deposit NAV counted only Safe USDC; assets returned raw by stop/migrate (WETH) and USDC out
  on running instances (Strategy/Project budgets) were invisible, so a depositor (flash-loaned or not) could buy shares cheap
  and ragequit dear. Fix: `TreasuryLedger` (Safe-owned, no admin). Instances `open()` in `start()` and `close()` in
  end/stop/migrate (both onlySafe paths, so the active set = passed, running proposals; spam instances never enter).
  Deposit NAV = Safe USDC + Σ USDC held by open instances. Deposits are refused (`TreasuryNotSettled`) while any open
  instance holds its asset or the Safe holds any asset the ledger has ever registered (Strategy assets, append-only). No
  oracle, nothing is valued; the DAO settles to USDC by vote and deposits reopen by themselves.
- Hole 2 (spot price): the venue's price() and slippage bound referenced the pool's current quote, so a flash swap could move
  slot0, trigger a stop-loss/take-profit on the permissionless run() and sandwich the sale. Fix: UniswapV3Venue prices and
  bounds execution against the pool's own 30-minute TWAP (`observe`); execution reverts when output < TWAP-implied output
  × (1 − slippageBps). Thin pools then revert large runs instead of dumping; chunking is `maxPerRun`, voted per strategy.
  Constructor refuses pools whose observation cardinality cannot serve the window.
- Voting: no change. Shares are non-transferable, vote weight is the checkpoint at submission and a vote in the submission
  block reverts, so a flash loan cannot vote. A multi-block capital attack (deposit big, propose "pay me", vote) hands exiting
  members a pro-rata slice of the attacker's own deposit during grace; it only wins against members who never poll.
- Ragequit stays pro-rata of the Safe only (funds out on open instances are forfeited to stayers). Exit price ≤ deposit price,
  so there is no round-trip arbitrage; documented in PARAMETERS and the README, not softened.
- Not done (rejected as complexity): pricing non-USDC assets for deposits with TWAPs; deposit cooldowns; per-address caps.

User 2026-09-09: PARAMETERS.md lines 1-7 confirmed ("lgtm"); phase 4 rulings (ledger + TWAP) confirmed ("lgtm"). Mainnet proceeds after phase 4 is merged and proven; the 50 USDC genesis is the only user action.

## 2026-09-09 phase 4 designQuestions — provisional implementation interpretations for Fable
These are implementation interpretations, not new Fable rulings. The phase 4 rulings above remain the authority.
1. Immutable factory/ledger binding: the TemplateFactory constructor creates its TreasuryLedger with this Safe, settlement and factory address. The factory supplies that ledger to template creation code and records the deployed instances. No bootstrap setter, registry administrator or deployment nonce prediction is needed. The ledger checks the factory record, not a caller's claimed Safe or asset.
2. Lifecycle wording: the ruling says open/close are on onlySafe paths, while the accepted templates also complete through permissionless Strategy.run(), Project.end()/release() and verifier confirm(). Start, stop and migrate remain onlySafe. Completion from that already-voted template code also closes the recorded instance; removing those existing operational paths would contradict the requirement to preserve A–K. The ledger validates Running at open and terminal status at close. This interpretation of close authorization is explicitly provisional for Fable.
3. Empty-treasury wording: the task says both "unchanged" and "when totalShares == 0". The existing contract's fallback is treasury == 0; a nonempty treasury with zero shares quotes zero and reverts ZeroShares. Preserve that behavior with depositTreasury replacing Safe-only treasury, including genesis preconditions, instead of silently reopening the previously documented zero-supply trap. Fable can clarify whether a different supply-zero fallback was intended.
4. No-admin grep scope: existing NavShareToken/LootToken have permanently reverting pause/unpause compatibility methods required by Baal; TestToken mentions pause only in a comment. They are unchanged. The receipt reports their full-source matches honestly and verifies that new ledger/venue sources and all added Solidity lines contain no onlyOwner, Ownable or pause match; their ABIs expose no management setter.

## 2026-09-09 known unsolvable: off-chain revenue is an oracle problem (user + Fable, not scheduled)
An executor funded by proposal can hide revenue that arrives off-chain (Stripe). No contract can see it; not built for.
Mitigations that cost nothing in code: prefer Work (verifiable deliverable, verifier ≠ proposer) over funding ventures;
revenue accounts owned by the DAO (Stripe crypto payout to the Safe / DAO-held key), never by the executor; small budgets in
tranches with verifier release (Project template); executor bond written into the proposal contract; repeat game (one hidden
payout ends every future proposal, shares exit only at NAV). Only real technical route: TEE-attested executors holding the
revenue keys inside the enclave. Later, not now.
User ruling 2026-09-09: not a hard problem. Revenue accounts belong to the DAO (DAO-held keys, payouts to the Safe); an executor never owns the account. Closed.

## 2026-09-09 phase 5 rulings (Fable, on docs/SECURITY_AUDIT.md must-fix list; user: "不准失败", finish before mainnet)
Principle kept: no caps on what may be proposed; fixes below are accounting/liveness correctness, each one small.
1. GOV-05 (baalGas above the chain tx cap bricks processing forever) + GOV-01 (baalGas 0 lets a low-gas processor kill a
   passed proposal): fork the vendored Baal by one line: `submitProposal` requires `baalGas <= 8_000_000` (= relay sponsor
   maximum, under Base's 16,777,216 EIP-7825 cap). Our three submit paths set baalGas = simulated need × 1.5 (≤ 8M). A direct
   Baal submitter who passes 0 accepts the kill risk on their own proposal.
2. GOV-03 + GOV-04 (minRetention gamed by same-tx deposits and by vote-time flash deposits raising the high-water mark):
   replace Baal's HWM check with the rule the constitution states. NavShareToken keeps a timestamp-checkpointed cumulative
   `burned` counter; Baal.processProposal requires
   `burned(now) − burned(votingStarts) <= (100 − minRetention)% × pastTotalSupply(votingStarts)`. Deposits no longer move
   either side. Tests t03/t07 must flip.
3. GOV-02 (vote weight survives ragequit): accepted by principle after ruling 2 — a YES weight that exits is a burn; above 34%
   it defeats the proposal by retention, below 34% it only beats members who never voted NO in 6 h (DESIGN §4 sleepers).
   Documented in PARAMETERS and README, not softened.
4. NAV-01 + NAV-07 + W-1 + NAV-08 (deposit NAV): TreasuryLedger as ruled in phase 4 with two amendments: (a) the settled gate
   looks only at open instances' asset holdings, never at Safe balances (1 wei of dust on the Safe must not pause deposits;
   non-USDC gifts to the Safe are shared by exit only, documented); (b) Strategy stop() returns settlement raw to the Safe and
   keeps the asset inside the instance, which stays open (deposits paused) until a later vote migrates it or unwinds it
   through the venue with the TWAP bound (`unwind()` onlySafe, new). (c) depositTreasury also subtracts the share liability
   of Active tasks: shares = amount × (totalShares + Σ active rewardShares) / depositTreasury; WorkManager.confirm() reverts
   after the task's expiration so the liability expires with the task. Ready-but-unexecuted Payments are visible in /me
   (treasury effect) and accepted as a documented pending liability.
5. T-4 + T-5: the spot venue never ships; phase 4 TWAP venue with scenario K on the fork is the fix (in progress).
6. ECO-06 + A5-11: deploy MultiSendCallOnly (no delegatecall as the Safe); relay/beacon count approve/increaseAllowance as
   treasury effect and bind the instance panel to decoded calls, not to the details JSON.
7. A5-10 (relay can silence a T0 member): README line "T0: the relay operator can delay or drop your intents; anything you
   cannot afford to lose goes through T1"; relay answers ok only after broadcast, exposes /pending.json.
8. OPS-03/04 (pre-genesis dust bricks the address set; proxy squatting): remove the zero-supply trap: while totalShares == 0,
   1 USDC = 1e18 shares regardless of treasury (pre-existing dust is a gift to the first depositor); genesisDeposit keeps its
   refusal only for supply > 0. Proxy salts bound to the deployer address.
9. A5-08/09 (rate-limit counter dropped on rejection; T0 passphrase entropy): persist the counter before rejecting; 128-bit
   entropy floor on pass. Small.
10. Medium set (T-7 end() vs release() race, W-2 claim timeout, disclosures OPS-05/NAV-05/ECO-08/NAV-02/NAV-06/T-7/W-2/ECO-05/
    ECO-09/A5-13/A5-14, Config terminal shapes ECO-04/T-9/GOV-07): template fixes for T-7 and W-2; every other item is a
    README/PARAMETERS disclosure plus a /me flag for Config proposals that cut voting+grace below the hourly poll cadence.
Rejected: any lock or cooldown on deposits/exits; any on-chain cap on Config values; per-voter vote retraction on exit.
Sequence: phase 4 (ledger + TWAP) finishes on branch phase4-ledger-twap → phase 5 implements 1-10 on the same branch with the
audit's tests flipped green → clean-clone acceptance → Base fork rehearsal → mainnet.

## 2026-09-09 phase 5 stage A designQuestions — provisional implementation interpretations for Fable
These are implementation interpretations of the phase 5 rulings (DW worker, branch phase4-ledger-twap); the rulings remain the authority.
1. Ruling 2, literal formula `burned(now) − burned(votingStarts)` does not close GOV-04: a flash deposit followed by a ragequit of the same shares is itself a burn above 34%, so the veto would survive. Implemented instead the rule the sentence means ("deposits move neither side"): exits = Σ over accounts of max(0, balance at votingStarts − balance now), computed exactly with per-account mint lots stamped by registration epoch (burns consume newest lots first) and a Fenwick tree over epochs on NavShareToken. Baal's diff stays a few lines (`registerProposal` at sponsorship, `exitedSince` at processing). t03 and t07 flip; Fable to confirm the accounting.
2. Ruling 1, "simulated need × 1.5" on the two on-chain submit paths: WorkManager uses a constant (`ACTIVATION_BAAL_GAS` = 500,000; the activation action is fixed and needs < 100k). ZeroOneIntentAccount op 0 reads the baalGas from the intent's otherwise-unused `proposalId` field (the relay's simulation; stage C) and uses `DEFAULT_BAAL_GAS` = 2,000,000 when it is 0 (covers every measured template start × 1.5). The EIP-712 struct is unchanged so existing signers keep working.
3. Ruling 4c, "the task's expiration": taken as the `expiration` argument of `submitTask` (already the Baal expiration; 0 = none). A task with expiration 0 stays a liability until confirmed or cancelled by vote — visible in the vote, no cap added. `expireTask()` (anyone) closes an expired Active task so the liability loop stays bounded.
4. Ruling 10, W-2 claim timeout: `CLAIM_TIMEOUT` = 7 days, lapsing only a claim that delivered nothing (a delivered-but-unconfirmed claim is the verifiers' call; a garbage delivery still needs a cancel vote).
5. Ruling 10, T-7: after the deadline `release()` and `confirm()` revert and `start()` refuses; a Date tranche dated at or after the deadline is therefore unpayable (amend before the deadline).
6. Ruling 8, "proxy salts bound to the deployer address": implemented as `keccak256(deployer, salt, kind)` nonces. The vendored factories do not include msg.sender in the CREATE2 salt, so front-running the proxy creation remains possible and remains griefing-only (deployment aborts, nothing moves). T03(b) shows it, not as a finding.
7. Ruling 4a: `TreasuryLedger.assets` (append-only registry) is kept as information only; `settled()` reads open instances alone.
8. Audit rows in the flipped test files that the rulings accepted or rejected (W-3 proposer as worker; W-4 dead task id; T-8 amend-while-Pending; T-9 Config values above 100, rejected cap) are asserted as the documented behaviour so the files exit 0; no code was added for them.


## 2026-09-10 phase 5 stage B designQuestions — TWAP venue + scenario K on a Base fork
These are implementation interpretations of phase 5 ruling 5 (DW worker, branch phase4-ledger-twap); the rulings remain the authority. No contract changed in stage B: `UniswapV3Venue` already prices and bounds on the pool's own 30-minute `observe` TWAP, and the fork run confirms it.
1. Ruling 5, "the spot venue never ships; scenario K on the fork is the fix": the oracle for audit rows T-4 and T-5 moved from the mirror onto the shipped venue. `evidence/audit/work-templates/strategy-price-reference.ts` now boots its own Base fork, deploys the venue on the real WETH/USDC 0.05% pool and asserts the invariants on the numbers scenario K's `proveSandwiches` reports from inside the attacker's transaction. Its MockDex section is kept as the printed record of what a spot reference does but carries no invariant, because MockDex (settable price, `contracts/MockDex.sol`) is mirror-only and never deployed — asserting a shipped-system invariant against a mock would assert nothing.
2. Audit row T-6 (donation fires take-profit) is Low and in no ruling; asserted as the documented behaviour its own row states — the donation lands in the Safe, so the treasury does not lose and the donor pays; the cost is that the voted strategy never traded. Same treatment as stage A items W-3 / W-4 / T-8 / T-9.
3. Fork determinism (test harness only, no contract effect): `src/baseFork.ts` pins Base block 51,000,000 (`BASE_FORK_BLOCK`, overridable by `FORK_BLOCK`, `latest` opts out) and `warmUniswapPool()` pre-reads the 1,547 ticks / tickBitmap / observations slots a 25% print crosses. Without both, a fork fetches cold storage from upstream one slot at a time (~0.5 s per round trip here) and the print simulation outlives every RPC timeout — codex's earlier red. `src/onchain.ts` raises the loopback JSON-RPC timeout to 300 s for the same reason.
4. Gas on the fork: transactions other than the permissionless `run()` are sent with estimate × 1.5 capped below the block limit, because anvil returns the binary-search minimum and one sandwich burned 9,593,133 of 9,627,729 gas and reverted while the identical call replayed clean. `run()` keeps a fixed 2,000,000 so the scenario still proves a normal caller's budget suffices. `writeAndWait` now replays a reverted transaction as `eth_call` at the parent block and throws the decoded revert with gas used / gas supplied.
5. Not built in stage B: audit row T-12's own suggested edges (warp 31 min, move spot 1%, assert `run()` and the deadline unwind revert on the bound). T-12 is Medium and argued, not in the must-fix list; what the fork does prove is the T-12(c) direction — a print inside the window cannot steer the TWAP, and the deadline unwind refuses rather than dumps. The T-12(a) liveness cost (with slippageBps 50, any spot/TWAP divergence above 0.5% refuses the run until a vote stops the strategy) remains a disclosure for stage C, not a code change.

## 2026-09-10 phase 5 stage C designQuestions — relay, beacon and docs
These are implementation interpretations of phase 5 rulings 6, 7, 9 and 10 (DW worker, branch phase4-ledger-twap); the rulings remain the authority. Nothing in `contracts/` changed in stage C.
1. Ruling 9, "128-bit entropy floor on pass": the ruling gives the number, not the estimator. `relay/pass.ts` takes the minimum of a character model (length x log2 of the classes used, after collapsing a repeated character or a repeated short block) and, only when the pass IS a phrase (letters-only words, one case each, single ordinary separators), a word model of at most 12.9 bits per distinct word (the EFF list is 7776 words). The audit's own vector scores 51.7 bits and is refused; 32 random bytes as base64url score ~250, 32 hex characters 165, ten random words 129. The word model is gated on the phrase shape on purpose: applied to every pass it rejected roughly 1 in 1,700 genuinely random base64url passes (a letters-only chunk read as a dictionary word), and a false rejection pushes agents towards weaker passes. Not caught, because no dictionary is shipped: dictionary words concatenated without separators beyond ~28 characters ("correcthorsebatterystaplecorrect" = 150 bits). Recorded in PARAMETERS and RELAY.md.
2. Ruling 6, "count approve/increaseAllowance as treasury effect": an allowance is not a transfer, so it is reported as its own number (`treasuryEffect.usdcApproved`) plus the sum (`usdcAtRisk`) rather than folded into `usdcOut`; the summary says the spender may pull it at any later time. `transferFrom` out of the Safe is counted as `usdcOut`. A delegatecall entry that carries transfer calldata is counted as `usdcOut` too, which over-counts on purpose (the code runs in the Safe's context, so its real effect is unbounded) and is flagged as a delegatecall.
3. Ruling 6, "bind the instance panel to decoded calls": implemented by deriving the candidates from the calls themselves (the non-DAO addresses the multicall calls that answer `describe()`); the details JSON can only select among them, and a name no call touches becomes a flag. Consequence, deliberately kept: a proposal whose management call touches two instances (migrate) shows the first one it calls, and a proposal with no call into an instance shows no panel even when its details name one.
4. Ruling 4c / 10, what `/me` publishes: `shareLiability` = `WorkManager.activeRewardShares()`, and `navUsdcPerShare` now divides deposit NAV by shares + that liability, so the published NAV per share is the price a deposit actually pays. Previously it divided by shares alone and drifted from `DepositShaman.quote()` as soon as a task was Active.
5. Ruling 10, "a /me flag for Config proposals that cut voting+grace below the hourly poll cadence": implemented as `flags[]` per proposal and `warnings[]` per member, and extended to the terminal shapes the audit found (quorum > 100 = T-9b, sponsorThreshold >= supply = T-9c, votingPeriod overflowing uint32(now)+votingPeriod = GOV-07b, either period 0 = NotApplied). No on-chain cap was added (ruling 10 rejects it).
6. Ruling 7, "answers ok only after broadcast": the hole was the dedupe map, which answered `{ok:true, replayed:true, hash}` from `db.requests` with no chain read, so an operator could seed it. A replay now reads the receipt for the recorded hash and answers from it; a row whose transaction is on no block is deleted and the intent is broadcast again (it then fails on its real reason, usually a spent nonce). `/pending.json` publishes the journal and the unfinished requests. What is NOT fixed, because no code can: an operator that simply never broadcasts. That is the README line, and it is why T0 is documented as a liveness trust.
7. Ruling 9, "persist the counter before rejecting": done inside `rate()`, which also means `persist()` now runs on every rejected `/relay` request (one small atomic write). The bucket key remains the `cf-connecting-ip` header, so the relay must sit behind Cloudflare or answer only on loopback; that is a deployment constraint recorded in PARAMETERS and RELAY.md, not a code fix, and the flipped F1 probe asserts the bucket rotation as documented behaviour.
8. Audit rows flipped in stage C: A5-08 and A5-09 (`evidence/audit/account-relay/relay-adversarial.test.ts` F1, F2). A5-07 (F4) is asserted as the documented custody trade-off, like stage A's W-3 / W-4 / T-8 / T-9. A5-10's provable half (the fabricated success) is asserted in `npm run e2e:relay` step 18; the unprovable half (an operator that drops intents) is the README disclosure.
9. Docs: DESIGN §6c rewritten to the phase 5 rule (open instances alone pause deposits; a stopped Strategy keeps its asset and stays open; the deposit price counts the task liability) and kept at 8 lines. The beacon README is exactly 44 lines. The repo README is 44 lines and now carries the settlement line, the retention rule and the T0 line. Disclosures OPS-05, NAV-05, ECO-08, NAV-02, NAV-06, ECO-05, ECO-09, A5-13, A5-14, A5-07, T-12(a) and GOV-02 are one line each in PARAMETERS under "Disclosures".

## 2026-09-10 phase 5 stage D — clean-clone acceptance (reviewer pass, DW worker; the rulings remain the authority)
Method: `git clone` of the branch into a scratchpad temp dir, `npm ci`, then every gate re-run there and nothing trusted from
the stage A-C reports. Receipt: `evidence/phase5/acceptance-rerun.log` (37 steps, all EXIT 0) with the full output of each step
under `evidence/phase5/stage-d/`. Covered: typecheck, compile (47 artifacts), scenarios A-L, scenario K on a Base fork
(`FORK_RPC=https://base.drpc.org`, pinned block 51,000,000), `npm run e2e:relay` (beacon rebuilt and revalidated, README 44
lines), the 11 flipped audit tests, the 20 remaining audit tests, the no-admin grep, the Baal fork diff (24 lines), the two
verbatim vendored files, and `git diff 10923ea..HEAD -- docs/CONSTITUTION.md CLAUDE.md` (empty).
1. Red on the first clean-clone run, fixed in `src/devnet.ts` (harness, no contract effect): a fresh `npm ci` leaves no
   `node_modules/.bin/anvil`, because `@foundry-rs/anvil` and `@foundry-rs/anvil-darwin-arm64` both declare the bin name
   `anvil` and npm links neither on a collision. Every scenario died with `spawn .../node_modules/.bin/anvil ENOENT`. The
   existing checkout only worked because an older `npm install` had left the shim behind. `anvilBinary()` now resolves the
   executable itself (`ANVIL_BIN`, shim, platform package, wrapper fallback) and never consults `PATH`. Recorded in PARAMETERS.
2. Six audit tests outside the flipped set were red on the branch; stages A-C never ran them. All six are tests asserting
   pre-phase-4/5 behaviour or signatures, and all six were changed on the test side, with the findings preserved:
   (a) `t11-same-tx-roundtrip` (NAV-04) predicted the mint with `amount x supply / SafeUSDC`. Phase 5 prices the mint on the
   ledger (Safe + open instances, plus the task liability), so it now asks `DepositShaman.quote()`. The invariant is restated
   honestly: with the whole treasury in the Safe the round trip nets 0/-1 as before, but while a 3,000 USDC budget is out it
   nets -48.39 on 50 USDC and -1,176.84 on 2,000 USDC, because the burn leg is still pro-rata of the Safe alone. Deposit-then-
   exit inside one transaction never profits; the ECO-08 / NAV-05 asymmetry is what it loses to.
   (b) `factory-create2-onlysafe` (T-1) called `deployer.initCode(member, params)`; the phase 4 factory takes the ledger as a
   third argument.
   (c-e) `T06-capture-small-treasury` (ECO-01/02/03), `T07-config-shortening` (ECO-04) and `T11-exit-cost-deployed-capital`
   (ECO-08) expressed "pay the attacker whatever the Safe holds at execution" with a delegatecall Drainer, which ruling 6's
   MultiSendCallOnly now refuses (the action fails, the Safe keeps its USDC). The capture itself is untouched, so each test now
   votes one call-only `USDC.approve(attacker, 2**128)` and pulls with `transferFrom` in a second transaction: same money, same
   conclusions (W still takes 2,050 USDC of other members' deposits; A still drains 3,050 USDC 6 s after submitting under a
   4 s / 1 s Config; C's exit still costs it 65.6%). The relay reports that allowance as `usdcApproved` / `usdcAtRisk` with a
   flag — a disclosure, not a defence.
   (f) `T08-spam-economics` (ECO-05) submitted at `baalGas = 20,000,000`, which ruling 1 now refuses. It spams at the 8,000,000
   ceiling instead; clearing still needs a self-paid gas limit above the relay's 8,000,000 execute cap, and the point of the cap
   holds: one Base block (16,777,216) now clears two such proposals, so the queue can never be permanently stuck.
3. `T09-hidden-treasury-effect` (ECO-06 / OPS-07) was red for the right reason and is now a flipped test: (1) the approve drain
   still shows `usdcOut = 0` but is reported as `usdcApproved` / `usdcAtRisk` with an `allowance:` flag and the pull still works
   (finding retained as a disclosure); (2) the delegatecall entry is flagged `delegatecall:`, labelled `DELEGATECALL ...` in the
   decoded calls, and refused on chain — passed = true, actionFailed = true, Safe unchanged at 3,050 USDC (ruling 6 / A3 proven
   end to end for the first time); (3) the details JSON naming an untouched instance now gets no panel and a `details:` flag
   (A5-11). The reorg step is unchanged.
4. Rulings the code still does not honour verbatim (all previously recorded, re-verified here, none newly introduced): ruling 2's
   literal `burned(now) - burned(votingStarts)` formula (stage A item 1, exits are counted per account instead, at ~709k gas per
   ragequit); ruling 1's "simulated x 1.5" on the two on-chain submit paths, which use constants (stage A item 2); ruling 8's
   "salts bound to the deployer", which the vendored factories cannot enforce against a front-runner, leaving griefing-only
   (stage A item 6); ruling 6's "count approve as treasury effect", reported as its own field rather than folded into `usdcOut`
   (stage C item 2); ruling 9's 128-bit floor, whose estimator is this repo's and is dictionary-blind (stage C item 1); ruling 7,
   whose "never broadcasts" half no code can close (stage C item 6). Everything else in rulings 1-10 is implemented and proven by
   a green test named in the acceptance log.
5. Not part of stage D and still open: the Base fork rehearsal of a whole deployment (`npm run e2e:base-fork`) and the mainnet
   sequence. `evidence/phase4/beacon-validate.log` is still rewritten by `e2e:relay` (path and run id only); it is restored after
   each run, and stage D's own beacon receipt is in `evidence/phase5/stage-d/e2e-relay.log`.

## 2026-09-10 phase 5 stages B/C/D review (Fable) — accepted, with these rulings on the deviations
- Stage B: TWAP venue proven on a pinned Base fork (block 51,000,000); a 25% same-block print moves neither price() nor
  value() and the run refuses on the bound; the fresh-pool constructor refusal is proven. Accepted. The two reds were test
  infrastructure (anvil's zero-margin gas estimate; cold fork storage), not contract defects: correct call.
  T-12(a) liveness (a strategy with slippageBps 50 refuses runs while spot and TWAP diverge by more than 0.5%) is accepted
  and disclosed; the bound is voted per strategy, so a volatile pair votes a wider one.
- Stage C: accepted, including the two deliberate departures. `usdcApproved` / `usdcAtRisk` reported next to `usdcOut`
  rather than folded into it is the better disclosure (an allowance is not a transfer, and it is flagged). The entropy
  estimator being this repo's own and dictionary-blind is accepted: the floor exists to stop a sentence, not to certify a
  pass. Ruling: `navUsdcPerShare` published by the relay divides by shares + active task liability, so the published number
  is what a deposit actually pays; the exit number is separate and lower, and both are named in /me.
- Stage D (reviewer): accepted and valued. It found that the clean clone never ran at all (npm ci links no anvil shim
  because two packages declare the same bin) and that six audit tests outside the flipped set were red against the new
  signatures. This is why a reviewer re-runs from a clean clone instead of trusting reports.
  NAV-04 consequence recorded as a disclosure, not a defect: a deposit made while capital is deployed prices on the ledger
  while an immediate exit pays pro-rata of the Safe alone, so a same-window round trip loses money. Deposit price >= exit
  price is the property that keeps the round trip unprofitable; it is stated in the README and PARAMETERS.
  Ruling 6's consequence stands: a passed proposal that grants an allowance is disclosed and flagged, never blocked. Any
  member may propose anything; the remedy is NO or exit.
- Open: the retention accounting (ruling 2's implementation) is under a second review by gpt-6-astra against the code, on
  the decisive sequence "hold 100 at votingStarts, burn 40, mint 40". The design authority's answer: the per-account deficit
  (0) is correct; permanent cohort accounting would give any 34% holder a free veto while it keeps its stake. If the code
  reports 40, it is a defect and the deficit semantics win.

## 2026-09-10 the agent entry point must not sit behind a bot challenge (Fable, found by a false alarm)
A beacon watch reported the state feed unparseable. The service was healthy: the same URL answers 200 from the Mac mini's
egress and 403 `x-vercel-mitigated: challenge` (Vercel Security Checkpoint HTML) from the main Mac's egress; api.vercel.com
challenges that IP too, so this is IP reputation on our side, not a project setting. Consequence for the design, which is the
part that matters: Zero One's whole promise is that one plain GET is the onboarding, and Vercel challenges plain GETs from
datacenter and VPN addresses — exactly where agents live. Ruling: the canonical entry point moves to a host we control that
never challenges a fetch (the mini behind its own cloudflared tunnel, which already serves the relay); the Vercel beacon
stays as a mirror, and the README names the controlled origin. The Leviathan beacon watch is stopped: that project is
abandoned, so its feed produces only noise (its treasury is on chain and unaffected).

## 2026-09-10 phase 5 Base fork rehearsal review (Fable) — accepted; two bugs it caught, one parameter changed
The rehearsal was not a formality. On the phase 5 code the shared deployment module could not finish: it built the
DepositShaman verification arguments with three arguments after phase 5 gave the constructor a fourth, and it threw after
the genesis deposit had already run, i.e. a mainnet attempt would have stranded a half-built deployment with 50 real USDC
inside it. Second bug: the verification input listed only the top-level contracts, so the vendored Baal fork and
MultiSendCallOnly were absent and could never have been verified on Basescan. Both fixed in code, both proven.
Measurements accepted: deployment plus genesis 24,778,573 gas over 22 transactions (0.00124 ETH at 0.05 gwei), Baal fork
runtime 19,497 bytes (5,079 under the limit), MultiSendCallOnly wired as the multisend library.
Ruling on the deployer balance gate: the 0.005 ETH constant is replaced by a computed requirement, measured deployment gas
times the live base fee times a factor of five, with a 0.02 ETH floor. A constant rots; the failure it guards against is a
deployment that stops half-built on mainnet, so the gate must read the chain it is about to deploy to.
Ruling on exit gas: accepted as measured. The first exit writes the retention tree and costs about 683k to 796k gas,
later single-lot exits about 282k to 318k, against roughly 120k before phase 5. On Base that is a fraction of a cent, and
the first member to exit paying for the structure everyone else uses is acceptable. If the retention review recommends a
simpler equivalent design, this number is one of the reasons to take it.
Accepted as written: the fork-only genesis-commit override (refused without a fork, must be a pushed ancestor, constitution
bytes identical, production still pins its own pushed HEAD), and scenario K behind its own flag.

## 2026-09-10 retention accounting is WRONG in the code (gpt-6-astra confirmed by running it) — ruling and redesign
Executed counterexample: an account holds 100 shares when voting starts, exits 40, then deposits 40 again; the balance is
100 and `exitedSince(1)` returns 40, so the proposal is judged failed. The implementation records a permanent cohort
departure, not the current deficit. Every existing test passes because none of them covers the same account coming back.
Ruling: the deficit is the rule. A member who left and returned has not voted with its feet, and permanent cohort
accounting hands any holder of 34% a free veto over every proposal while it keeps its whole stake, which is the GOV-04 hole
under another name. The quantity to compute for proposal p is exactly
  deficit(p) = Σ over accounts of max(0, balance at votingStarts(p) − balance now)
and the proposal fails when deficit(p) × 100 > (100 − minRetention) × supply at votingStarts(p).
Constraint hierarchy for the mechanism, in this order: (1) exactly that quantity, no approximation; (2) leaving is always
cheap, because the constitution promises exit at any time and proposal volume is not capped, so nobody may make exits
expensive by spamming proposals; (3) no cap, cooldown or lock anywhere; (4) simplicity, then gas.
Useful identity for the implementer, so nobody rediscovers it: with A = supply at votingStarts and S = supply now,
  deficit(p) = (A − S) + growth(p),  growth(p) = Σ over accounts of max(0, balance now − balance at votingStarts(p)).
A and S are O(1) reads, so the whole problem reduces to tracking growth, which only accounts that received shares inside the
window can have. An account whose last mint predates the oldest open window contributes zero growth to every open proposal,
so a plain exit can stay O(1) behind a single timestamp comparison. Mechanism choice goes to gpt-6-astra with this identity.

## 2026-09-10 entry point designQuestions — the relay serves the beacon (DW worker, branch phase4-ledger-twap)
These are implementation interpretations of the entry-point ruling above; the ruling remains the authority. No contract
changed. New: `relay/static.ts`, `relay/e2e-entry-point.ts` (`npm run e2e:entry-point`), receipts in
`evidence/phase5/entry-point/`.
1. What the relay serves, and what it deliberately does not. The static table is exactly `/README.txt`, `/llms.txt`,
   `/robots.txt`, `/snippet.js`, `/snippet.py`, `/CONSTITUTION.md`, `/index.html` and `/`, each with one fixed content
   type, exact path match, no traversal, no redirect (`/` returns the dashboard body) and no request header read at all.
   `state.json` and `proposals.json` are NOT in the table even though the build writes them: those two paths are live
   answers, and a build-time snapshot silently taking them over is the worst failure available here (an agent would price
   a deposit off an old NAV). The "dynamic first" rule is compiled, not documented: the router matches every dynamic
   route before the table, and `assertNoDynamicCollision` throws at startup if a static path is ever added that a
   dynamic route owns. Proved by overwriting the build's `state.json` with a sentinel and reading the live answer back.
2. Files are read from disk per request rather than cached. They are a few KB, and the alternative (cache with mtime
   checks) buys nothing at this traffic while making a rebuild require a restart. Consequence recorded in RELAY.md:
   a rebuild is live immediately, so a published README can change under an agent that cached it.
3. The dashboard gets a CSP that actually lets it work (`connect-src 'self'`, inline style and script only). The Vercel
   mirror's `default-src 'none'` header blocks the dashboard's own `state.json` fetch; that is the mirror's existing
   behaviour and was not touched, because the ruling says the Vercel build stays unchanged.
4. Which README line paid for the mirror line. The README was exactly 44 lines with one blank separator between the
   intent-format block and the T1/T0 block; the blank line was spent and the mirror sentence took its place next to the
   origin line, so no content was dropped to stay at 44. The alternative considered and rejected was deleting the
   share-checkpoint line (line 40), which is the one line that explains why a vote can be refused right after a
   submission. The mirror is named in one line of `README.txt` and one line of `llms.txt`, both saying plainly that a
   mirror can answer a plain GET with a challenge page.
5. `--origin` now defaults to `CANONICAL_ORIGIN` (`https://relay-zero.mkyang.ai`, `ZERO_ONE_ORIGIN` overrides) instead of
   `http://127.0.0.1:18751`. The mini therefore builds the canonical beacon with no flag, and the mirror is the same
   builder with `--origin <mirror>`, which is what keeps the Vercel deployment working unchanged. The cost is that a
   local build that forgets `--origin` now advertises the production hostname; the new validator catches it immediately,
   because it fetches from the origin the README names.
6. What the validator now proves, and the one thing it cannot. It fetches every URL the README advertises on the origin
   under test (13 probes for this README, including a read-only `/relay?op=quote` and `/me/<a member>.json`) and requires
   200, the expected content type, a parseable JSON body, no bot-mitigation header and no challenge page; the served
   `README.txt` must be byte-identical to the build and the served `CONSTITUTION.md` bytes must hash to the on-chain
   hash. A path the README advertises that the probe table does not cover is itself a failure, so the table cannot fall
   behind the README. Negative control in the E2E: against a stub that answers Vercel's `403
   x-vercel-mitigated: challenge` Security Checkpoint page, validate exits 1 naming the header. What it cannot prove is
   that the origin answers the same way from an address that is not ours: the challenge is IP-reputation based, so a
   validate run from the mini says nothing about what an agent on a datacenter address sees. That is the argument for
   owning the origin rather than for a better probe.
7. The constitution URL is fetched wherever it points, including the pinned GitHub raw URL of a real deployment, and its
   bytes are hashed against the chain. Consequence accepted: a validate run fails if GitHub is unreachable from the
   operator's network. The failure is loud and names the host, which is better than not checking the one document whose
   authority is a hash (A5-14).
8. Off-origin URLs the README names are listed in the summary (`offOriginUrls`) and not probed, the mirror included.
   Validating the mirror is `--origin mirror`, and it is EXPECTED to fail from a datacenter or VPN address: that is the
   finding restated as a test, not a regression. One real gap it exposes in the mirror was fixed in `beacon/vercel.json`:
   `/pending.json` had no rewrite, so the mirror answered nothing on a path the README advertises. It now forwards to the
   relay like the other four. Nothing was deployed; the file is ready for the next `vercel.ts` run.
9. Not done here, because the orchestrator reviews first: nothing was deployed to the mini or to Vercel and no launchd
   service was restarted. Going live needs `RELAY_BEACON_DIR` added to `ai.mkyang.zero-one-relay` and a canonical build
   present in that directory; until then `https://relay-zero.mkyang.ai/README.txt` still 404s with the JSON reason,
   which is the correct answer for a relay with no build.
10. `npm run e2e:relay` needed one change to stay green: the relay it starts now runs with `RELAY_BEACON_DIR` at the
   directory that run builds, and the final rebuild refreshes that directory too. Without it the validator correctly
   refused, because the origin the README named served no README. It found the bug it exists to find on its first run.

## 2026-09-10 entry point review (Fable) — accepted; going live is gated on the retention fix
Accepted as built. The relay now serves the entry files itself on exact paths, reads no request header at all (so no
user-agent sniffing and nothing to sniff for), refuses to start if a future edit makes a static path shadow a dynamic one,
and answers a JSON 404 naming the rebuild command when no build is present. The canonical origin is the relay's own
hostname and the Vercel build is the same builder with a mirror flag, so the mirror keeps working unchanged.
The part that matters most is the validator: it derives the origin from the README's own text, fetches every path the README
advertises, and fails if any answer is not a 200 of the expected type, if a bot-mitigation header appears, or if a path the
README advertises has no probe. Its negative control fails against a captured challenge page. Today's outage passed every
old check precisely because nothing tested the entry point the way an agent uses it.
Two defects it found on its first run are the evidence that it works: the relay started by the end-to-end suite served no
README at the origin its own README named, and the Vercel mirror had no route for a path the README advertises.
Ruling on sequencing: the mini relay is not switched to this code yet. The branch is mid-redesign on the retention rule, and
the live Sepolia relay must not run a half-finished branch. Order: retention mechanism lands, full acceptance re-runs, the
branch merges, then the mini relay gets the beacon directory and the canonical build, then the mirror is rebuilt.
Consequence accepted meanwhile: the canonical URL answers its JSON 404 and the mirror still challenges some addresses.
Sepolia has no external members, so nothing is lost.
Noted as true and not fixable by a probe: a validator run from our own address cannot tell what an agent on a datacenter
address sees, because the challenge is IP reputation. That is an argument for owning the origin, which is what we did.

## 2026-09-10 retention mechanism

**Recommend (c), the append-only mint journal with lazy growth settlement at processing, because it computes the exact ruled deficit and keeps every exit independent of proposal count and mint history.**

Authority: Fable's 2026-09-10 ruling supplied in the task: `deficit(p) = Σ_accounts max(0, balance_at_votingStarts(p) − balance_now)`; retention fails iff `deficit × 100 > (100 − minRetentionPercent) × supply_at_votingStarts`. This supersedes earlier permanent-cohort/burn interpretations in this file and the README/PARAMETERS. Same-account returns restore retention; another member's deposit cannot mask exits. Timestamp baselines are end-of-timestamp balances and supply, consistent with Baal's historical voting checkpoints, including multiple proposals/mints within one transaction.

Implemented in `contracts/NavShareToken.sol`: register the start timestamp; record supply at each registration and balance change in a timestamp mapping; append every positive mint's recipient and timestamp; retain its latest journal index. At processing, binary-search the first strictly post-start mint, scan the suffix, count each recipient only at its latest index and compute `growth = Σ max(0, currentBalance − pastBalance)`, then return `A + growth − S`. A contributing account must have received a positive post-start mint, and all balance increases go through the journaled mint function, so none can be omitted. Mint and burn never scan proposals, accounts, journal history or lots. `ragequit(0)` leaves token checkpoints and balances unchanged. No cap, cooldown or exit lock is added; the old MAX_EPOCHS restriction and lots/tree are removed.

Baal fork: preserve every ZERO ONE marker location and both existing sponsorship hooks; remove the obsolete registration return type and bound the accounting subcall by nonzero `prop.baalGas` (zero retains upstream caller-gas semantics). Gas exhaustion reverts atomically without recording a partial deficit or marking the proposal processed. **Accepted hierarchy tradeoff:** permissionless mint spam can exceed a fixed proposal budget, permanently grief processing and block later Ready proposals in Baal's ordered queue. This does not make exits expensive. No cap/lock is introduced to mask that processing-side risk. Historical `yesVotes` is unchanged: a YES voter leaving is counted in the exact deficit, and above the threshold that departure defeats the proposal (the existing GOV-02 interpretation), rather than inventing a new dynamic-majority rule.

Rejected (a): the frozen epoch-lots/Fenwick implementation reports exited=40 after an account exits 40 and returns to balance 100, instead of zero. It also caps lifetime registrations, and its whole exit is O(consumed lots × tree height), not O(log n). FIFO/LIFO changes cannot restore balances after a completed burn; no exact repair preserving its aggregate-tree operations and logarithmic whole-exit cost was established. Rejected (b): eager per-account positive-growth contributions are exact and the last-mint shortcut protects old holders, but recipients of mints inside an open window still have O(open proposals) exits. Lifecycle cleanup also requires Baal process/cancel hooks (and retirement of naturally defeated windows for a production version). It fails the unconditional cheap-exit priority.

Measured transaction gas, from the installed compiler and owned local Anvil; quiet=1 open proposal, storm=100. Deposit excludes approval. Partial exit burns 40 shares; after-mint exit returns the 40 newly minted shares; processing has one mint in the journal window and the same zero-value transfer action. Snapshot/revert isolates operations. Full exit interleaves 100 actual submissions and 100 deposits and then burns all 200 shares.

| Mechanism | Open | Deposit | Ordinary exit | Exit after mint | Process | Full exit after 100 interleavings |
|---|---:|---:|---:|---:|---:|---:|
| (a) lots/Fenwick | 1 | 178451 | 739912 | 715918 | 143506 | — |
| (a) lots/Fenwick | 100 | 178451 | 739912 | 671160 | 143506 | 4005196 |
| (b) eager + shortcut | 1 | 231696 | 203005 | 212976 | 190383 | — |
| (b) eager + shortcut | 100 | 5546808 | 203005 | 1720345 | 194891 | 2208777 |
| (c) mint journal | 1 | 201269 | 194736 | 194736 | 163106 | — |
| (c) mint journal | 100 | 201269 | 194736 | 194736 | 163106 | 140536 |

Whole-token physical/noncomment nonblank lines: (a) 339/234, (b) 290/211, (c) 289/208. The production Baal delta changes three executable lines and four comment lines, including a one-line zero-exit return before treasury division. Specification, invariants, completeness proof, benchmark limitations and exact replay commands: `docs/RETENTION_MECHANISM.md`.

Receipts: `evidence/phase5/retention-mechanism.log` and full runs in `evidence/phase5/retention/`; tests and frozen comparison implementations in `evidence/audit/governance-nav/`. The same new t16 counterexample is RED against the original runtime (`40 != 0`) and GREEN against the replacement (`0 == 0`). GOV-03 still processes as failed after another member deposits in the same transaction; GOV-04 still passes despite flash deposit/vote/exit; YES departure, overlapping windows, same-timestamp snapshots, zero exit, registration authorization and 36-step independent multi-account oracle pass. The new t17 empty-DAO zero-exit test is independently RED (division by zero) then GREEN after the Baal early return. A 100-mint/50,000-baalGas test confirms accounting exhaustion reverts without processing. Typecheck, compile, scenarios A–J/L and relay E2E pass. The initial local H seed-deposit revert is retained in `scenarios-red.log`; local scenario sends now leave 120,000 gas for checkpoint append-versus-overwrite variation when estimation and mining cross a second, and the complete local run is green.

**Remaining acceptance: K BLOCKED, not PASS.** `npm run scenarios` only adds K when FORK_RPC is set. K requires the real Base fork at block 51,000,000; that block is absent from the local Anvil cache. With the no-network red line and no answer to the requested read-only-RPC clarification, no upstream access or K transaction was attempted. Thus A–L acceptance is not claimed complete. All performed transactions were on owned local Anvil. No public-network transaction, fetch, push, hook bypass, constitution change or CLAUDE.md change.

## 2026-09-10 retention mechanism accepted (mint journal), and the one hazard it left open is now ruled
Accepted: the append-only mint journal with growth settled at processing. The measured table decides it — deposit, exit and
processing are constant whether one proposal is open or a hundred (about 201k, 195k and 163k), while the eager variant costs
5.5M for a deposit during a storm and the old lots-and-tree costs 740k for an ordinary exit and computes the wrong number.
The counterexample is red against the old runtime and green against the replacement. GOV-03 and GOV-04 stay closed. The
report is honest about what it did not run, which is the right behaviour.
The hazard it declined to mask, correctly, is now mine to close: minting is permissionless, so an attacker can put enough
records inside a window that settling the growth exceeds the proposal's gas budget, and because Baal processes in
sponsorship order that griefs every later proposal in the queue. That is the same shape as the capped-gas defect the audit
found, which we ruled must never be possible. It cannot stand.
Ruling: bound the work per transaction instead of capping anything. Settlement becomes incremental and permissionless —
anyone may advance a cursor over the journal window in chunks, and processing requires the cursor to have reached the end.
No single transaction ever scans an unbounded range, and no deadline is introduced, so a proposal cannot be lost by being
too expensive to settle at one moment. Add append-time deduplication if it stays simple: an account already recorded inside
the oldest open window need not be recorded again, which forces an attacker onto fresh addresses. The economics then run our
way: each spam record costs the attacker a whole deposit while it costs a settler a few thousand gas.
Exits and deposits must stay constant, which is the property that made this design win; settlement work moves to whoever
wants the proposal processed. Permission granted explicitly for the blocked test: reading Base mainnet through a public RPC
to run a local fork is allowed and is not a public-network transaction.
