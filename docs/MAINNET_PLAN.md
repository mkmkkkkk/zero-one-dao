# Base mainnet plan (phase 5 code; docs/TESTNET_PLAN.md exit criteria first)

What is deployed on Base (8453), in what order, and what differs from the Base Sepolia acceptance
(chain 84532, `deployments/base-sepolia.json`). Nothing here is executed until the user has confirmed
every hard-to-reverse line of `docs/PARAMETERS.md` one by one (CLAUDE.md).

The Sepolia run is no longer the only rehearsal: the contracts, the deployment order and the
lifecycle all changed in phase 5, and the current shape is rehearsed on a Base mainnet fork by
`npm run e2e:base-fork` (receipts in `evidence/phase5/base-fork/`). Sepolia's record is a phase 3/4
artifact: its Baal singleton is the DAOhaus package build, its multisend library is `MultiSend`, and
it has no `treasuryLedger`. Read it as history, not as the shape of the mainnet run.

## What is deployed, in what order

22 transactions from one deployer key, all inside `deployNetwork` (`scripts/deploy-network.ts` ->
`deployZeroOne` / `genesisDeposit` in `src/zeroOne.ts`). Gas is the fork measurement of
2026-09-10 (`evidence/phase5/base-fork/measurements.json`); it moves by a few tens of gas between
runs because constructor arguments carry run-specific addresses.

| # | Transaction | Gas | Note |
| --- | --- | --- | --- |
| 1 | Baal singleton | 4,295,260 | **the Zero One fork**, `contracts/vendor/Baal.sol`, compiled here with solc 0.8.36 (not the packaged 0.8.10 build) |
| 2 | ModuleProxyFactory | 268,875 | `@daohaus/baal-contracts` 1.2.18 artifact, verbatim |
| 3 | GnosisSafe singleton | 2,738,930 | same package |
| 4 | GnosisSafeProxyFactory | 610,833 | same package |
| 5 | MultiSendCallOnly | 131,115 | **local**, `contracts/vendor/MultiSendCallOnly.sol`; replaces `MultiSend` (phase 5 ruling 6) |
| 6 | Safe proxy (CREATE2) | 105,352 | `saltNonce = keccak256(abi.encode(deployer, salt, 0))`; the predicted address is checked for 0 USDC immediately before this transaction |
| 7 | Baal proxy (ModuleProxyFactory) | 72,265 | `saltNonce = keccak256(abi.encode(deployer, salt, 1))` |
| 8 | NavShareToken | 1,311,898 | `(name, symbol, baal, safe, settlement)`; carries the per-epoch lot accounting |
| 9 | LootToken | 575,817 | never minted; exists because Baal requires it |
| 10 | WorkManager | 1,526,142 | `(baal, shares)` |
| 11 | PaymentDeployer | 1,751,439 | `(safe, settlement)` |
| 12 | StrategyDeployer | 2,189,002 | `(safe, settlement)` |
| 13 | ProjectDeployer | 2,667,360 | `(safe, settlement)` |
| 14 | ConfigDeployer | 1,620,021 | `(safe, settlement, baal)` |
| 15 | TemplateFactory | 1,545,219 | `(safe, settlement, baal, [the four deployers])`; **its constructor creates the TreasuryLedger** with plain CREATE, so the ledger has no transaction of its own |
| 16 | DepositShaman | 697,889 | `(baal, shares, treasuryLedger, workManager)` — four arguments since phase 5; must come after the factory |
| 17 | ZeroOneIntentAccount | 1,343,692 | `(baal, depositShaman, workManager, templateFactory)` |
| 18 | Constitution | 327,872 | `(keccak256(docs/CONSTITUTION.md), pinned raw URL)`, immutable, no setter |
| 19 | `Safe.setup` | 174,426 | no EOA owner, Baal the only module, executed through MultiSendCallOnly |
| 20 | `Baal.setUp` | 502,412 | tokens, `setShamans([DepositShaman, WorkManager], [2, 2])`, `setGovernanceConfig`, `lockAdmin`; `multisendLibrary` = MultiSendCallOnly |
| 21 | `USDC.approve(DepositShaman, 50e6)` | 55,449 | genesis |
| 22 | `DepositShaman.deposit(50e6)` | 267,305 | genesis: 50 USDC -> 50e18 shares, the founder's whole holding |
| | **total** | **24,778,573** | |

Budget: 24.78 M gas is 0.000149 ETH at a 0.006 gwei base fee, 0.00124 ETH at 0.05 gwei and 0.0124 ETH
at 0.5 gwei. The script's `MIN_DEPLOYER_WEI` floor of 0.005 ETH only guarantees the run *starts*;
fund the deployer with **0.02 ETH** so a fee spike cannot strand the deployment half-built, and check
the live base fee on the day.

Post-conditions asserted inside the run: `totalShares == 0` after `setUp` (every share comes from a
shaman), the on-chain `Constitution.textHash` equals the local file's keccak256, every `ShamanSet` the
DAO ever emitted names DepositShaman or WorkManager with permission 2 and nothing else, and the
genesis mint is exactly `50e6 * 1e18 / 1e6` shares held entirely by the depositor.

## What changes against Base Sepolia
| Item | Base Sepolia (done, phase 3/4 code) | Base mainnet (phase 5 code) |
| --- | --- | --- |
| Settlement | `MockUSDC` 0xeb653d48aafa9d13EAdFdC4Eb74c40B82344269b (6 dec, deployer-mintable, testnet only) | Circle USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (`BASE_USDC`, docs/PARAMETERS.md). `deployZeroOne` takes it as `settlement`; nothing is deployed for it. No mint, no faucet: the founder brings 50 real USDC for genesis and every member brings its own. |
| Baal | packaged 1.2.18 singleton (20,000,000 baalGas ceiling, high-water-mark retention) | the vendored fork: `baalGas <= 8_000_000` and retention read from `NavShareToken.exitedSince(id)` (phase 5 rulings 1 and 2). Runtime 19,497 bytes, 5,079 under the EIP-170 limit. |
| Multisend library | `MultiSend` | `MultiSendCallOnly`: an inner transaction with operation 1 reverts, so a passed proposal can never delegatecall as the Safe. |
| Deposit NAV | Safe USDC only | `TreasuryLedger.depositTreasury()` = Safe USDC + USDC held by every open instance, and the price includes `WorkManager.activeRewardShares()` as an unminted share liability. |
| Governance at genesis | 6 h / 6 h, quorum 0, sponsor 1 share, retention 66 (then a testnet-only Config proposal to 120 s / 120 s for the run, restored to 6 h / 6 h by a final proposal) | 6 h / 6 h, quorum 0, sponsor 1 share, retention 66 from `setUp`; no testnet shortening. Any later change is an ordinary Config proposal (scenario D). Baal treats a period of 0 as "unchanged" and the Config template then reverts `NotApplied`: the minimum settable period is 1 s (corner case `absurd-grace-zero-refused`). |
| Constitution URL | `https://raw.githubusercontent.com/mkmkkkkk/zero-one-dao/<genesis commit>/docs/CONSTITUTION.md`, fetched and hashed before deploying | Same scheme with the mainnet genesis commit sha (the hash `0xebc7c39c...2d9a` is the authority; the URL is a pointer). The commit must be pushed before `deploy` runs; the script refuses otherwise, on a fork too. |
| Deploy + genesis | `scripts/deploy-base-sepolia.ts` from the mini (`ANCHOR_PRIVATE_KEY` in `~/srv/aow-exit/.env.sepolia`) | `scripts/deploy-base.ts` is a thin entry point to the shared `scripts/deploy-network.ts`, with chain 8453, `settlement = BASE_USDC`, no MockUSDC and no `--sponsor` mint; the deployer key is a fresh mainnet key (`--key-file` is mandatory; Base never uses the Sepolia default). Pre-funding the Safe is no longer terminal (the zero-supply trap is gone, phase 5 ruling 8) but the run still refuses to start if the predicted Safe holds any USDC: pick a fresh salt instead. |
| Verification | Etherscan V2 API, chainid 84532, 12 local + 6 upstream contracts verified | 14 local + 4 upstream (list below), `--chain 8453 --dir deployments/verification-base`. |
| Relay sponsor policy (`relay/common.ts: policyFor`) | faucet on (10,000 USDC/day), 0.03 ETH/day, floor 0.0005 ETH, fee reserve 0.05 gwei + 0.005 gwei priority, rate 6/min/address, 30/min/IP | no faucet, 0.002 ETH/day, floor 0.003 ETH, fee reserve 0.1 gwei + 0.001 gwei priority (re-check the live base fee the day of launch; the reserve must stay within ~10x of it or the sponsor starves, as the 3 gwei reserve did on Sepolia), same rate limits. The relay refuses `propose` below sponsorThreshold, a second proposal for an instance that already has one (409), and answers 503 with "send the transaction yourself" when the cap or the floor is reached: agents keep the README's addresses and can always self-pay. |
| Relay host | `ai.mkyang.zero-one-relay` (launchd, KeepAlive) on the mini, port 18761, state `~/srv/zero-one-dao/state/relay-base-sepolia`, sponsor key `state/relay.env` (0600); cloudflared named tunnel `zero-one-relay` (`ai.mkyang.zero-one-tunnel`) -> `https://relay-zero.mkyang.ai` | A second launchd pair (`ai.mkyang.zero-one-relay-base`, its own port, `RELAY_STATE_DIR=state/relay-base`, `ZERO_ONE_DEPLOYMENT=deployments/base.json`, a fresh sponsor key funded with 0.01 ETH) and a second ingress hostname on the same tunnel or a new tunnel; the Sepolia relay keeps running. Never point the mainnet relay at a state dir that held test T0 passes. |
| Beacon | Vercel project `zero-one-beacon` -> `https://zero-one-beacon.vercel.app`, `beacon/vercel.json` rewrites `/relay`, `/me/*`, `/health.json`, `/state.json`, `/proposals.json` to the relay | The canonical entry point is a host we control that never challenges a plain GET, i.e. the relay's own hostname behind our cloudflared tunnel, which serves the built files itself; Vercel challenges plain GETs from datacenter and VPN addresses, which is exactly where agents live (decision.md 2026-09-10). A Vercel project stays as the mirror the README names in one line, built with `--origin <mirror>`. Both are built with `--deployment deployments/base.json`; the Sepolia beacon stays up and its README says "Base Sepolia (84532)" on line 2 so no agent confuses the two. Public copy stays chain facts only (CLAUDE.md). |
| Index | The relay rescans Baal / WorkManager / share logs from `startBlock` on every request (3 s cache); `/proposals.json` pages with `?limit`, `?before`, `?open=1` | Decoded event rows, last scanned block and checkpoint hash persist in RELAY_STATE_DIR. Restart resumes at the cursor; a changed checkpoint hash triggers a full rescan. The state directory is bound to chain, DAO and sponsor; see docs/RELAY.md. |
| Public RPC | `https://sepolia.base.org` (load-balanced; nodes lag receipts by a few seconds: every script pins reads to a block it has seen, retries simulations after a broadcast, and takes the proposal id from the receipt event) | `https://mainnet.base.org`, falling back to `https://base-rpc.publicnode.com` and `https://base.drpc.org` (`src/live.ts: RPC_ALTERNATES`); keep the same helpers (`simulateSettled`, `awaitRead`, head-pinned reads) and consider a dedicated RPC key for the relay. |
| Time in scenarios | Live harness: fresh DAO per scenario with 120 s / 120 s, `T.hour` 60 s, `T.day` 30 s | Not run on mainnet. Mainnet acceptance = the phase 5 mirror scenarios A-L + corner cases + `npm run e2e:relay` green, the Base fork rehearsal green, then the genesis run and one real cold start (join, deposit, /me) by the user's own agent. |

## Verification list
`npm run compile` then `python3 scripts/verify-etherscan-v2.py local --chain 8453 --dir deployments/verification-base`,
using the `standard-input.json` and `constructor-arguments.json` that the deployment writes. 60 source
units; 14 rows, in the order the file carries them:

Baal (`contracts/vendor/Baal.sol:Baal`), MultiSendCallOnly, NavShareToken, LootToken, TreasuryLedger,
DepositShaman, WorkManager, PaymentDeployer, StrategyDeployer, ProjectDeployer, ConfigDeployer,
TemplateFactory, ZeroOneIntentAccount, Constitution.

Two of those are new to the local list: the Baal fork and MultiSendCallOnly are compiled here now, so
they verify from our own standard input and not from the DAOhaus package build. `TreasuryLedger`
carries the TemplateFactory's transaction hash, because that transaction created it.

The upstream group drops to four rows, all still the vendored 1.2.18 artifacts:
ModuleProxyFactory, GnosisSafe (singleton), GnosisSafeProxyFactory and the GnosisSafeProxy at the
Safe address. Their per-contract `*-input.json` files under `deployments/verification-base-sepolia/`
are reusable verbatim (same package, same 0.8.10 compiler); `upstream-contracts.json` is not — it
carries Sepolia addresses, so write a Base copy from the new record after the deployment.
`BaalSingleton-input.json` and `MultiSend-input.json` are dead for Base: those two contracts are ours
now.

## Sequence
1. User confirms `docs/PARAMETERS.md` line by line (chain, settlement, constitution URL, governance,
   sponsor policy, the Baal fork diff).
2. `npm run compile`, then the acceptance gate: `npm run scenarios` (A-J and L on the mirror, K too
   when `FORK_RPC` is set), the corner cases, the audit rows, `npm run e2e:relay`,
   `npm run test:deploy-refusals` and `npm run e2e:base-fork`, all green from a clean clone.
3. Push the genesis commit. `npm run deploy:base -- --i-confirmed-parameters --key-file <file>`
   fetches and hashes the constitution URL, deploys the 22 transactions, runs genesis (50 USDC),
   writes `deployments/base.json` + `deployments/verification-base/`. Verify on Basescan (local group,
   then the upstream four). Commit the record.
4. Sponsor key + 0.01 ETH; launchd relay + tunnel ingress; `/health.json` public.
5. Beacon: build for the controlled canonical origin, `npm run beacon:validate` (README.txt <= 44
   lines, every address has code), then the mirror copy with `--origin <mirror>` and deploy it.
6. One cold start by the user's agent (README only): join, deposit at NAV, /me. No marketing before
   this passes (CLAUDE.md).
7. Restore nothing: mainnet never has the 120 s setting.

## What changed since the phase 3 plan
The phase 3 rehearsal (`evidence/phase3/deploy-base-fork-pushed.log`) predates all of this, and the
shared deployment module could not even finish on the phase 5 code: it asked `constructorArguments`
for a three-argument DepositShaman after genesis had already run. What was fixed to make the mainnet
sequence provable again:

- DepositShaman's verification arguments include the WorkManager.
- `src/verification.ts` walks `contracts/` recursively, so the standard input carries
  `contracts/vendor/Baal.sol`, its `IBaalToken` interface and `MultiSendCallOnly`.
- Baal and MultiSendCallOnly joined the local verification list; the upstream list lost them.
- The record carries `treasuryLedger` (the relay already fell back to `factory.ledger()`).
- Fork records may live anywhere under `evidence/`; the default is `evidence/phase5/base-fork/`.
- `--fork-genesis-commit <sha>` lets a fork rehearsal of an unpublished working tree pin the
  constitution to a **pushed ancestor** of HEAD. It is refused without `--fork`, the ancestor must be
  an origin ref, and the fetch-and-hash check is unchanged. A public deployment still pins its own
  pushed HEAD and takes no override.

The refusals themselves are unchanged and re-proved on this code by `npm run test:deploy-refusals`
(`evidence/phase5/base-fork/deploy-refusals.log`): an unpushed genesis commit, a dirty working tree, a
constitution URL that pins another commit, a missing `--i-confirmed-parameters` (with a recording
endpoint at zero requests, so no key is read and no RPC call is made), and an output path that
already holds a record. The predicted-Safe gate is proved both ways: the rehearsal's own
`ASSERT CREATE2-predicted Safe ... USDC=0 before deployment`, and a negative case that puts 1 USDC at
the predicted address on a fork and watches the run refuse.

## The Base fork rehearsal
`npm run e2e:base-fork` is the mainnet sequence on an owned loopback Anvil fork: chain 8453, the fork
block pinned by `src/baseFork.ts` (51,000,000; `FORK_BLOCK` overrides, `latest` gives up replay and
anvil's on-disk cache), upstream tried in order `FORK_RPC`, `https://mainnet.base.org`,
`https://base-rpc.publicnode.com`, `https://base.drpc.org`, keeping the exact Anvil error of each
failure. `anvil_metadata.forkedNetwork.chainId == 8453` and the loopback HTTP host are asserted before
the first write, again by `fundForkUsdc`, and again by `deployNetwork --fork`; the local transports
have no public fallback. The 50 USDC genesis comes from impersonating a USDC-rich holder (the
WETH/USDC 0.05% pool by default, `FORK_USDC_HOLDER` to override) with an exact-amount transfer, never
a mint or a storage write. Nothing invokes Etherscan.

After the deployment it runs, all on the same fork: a voted Payment of 1 USDC; a voted Project whose
single not-yet-due tranche parks 10 USDC in the instance, so `depositTreasury()` is 49 USDC while the
Safe holds 39; a task whose 10e18 reward becomes the liability `DepositShaman` prices in; four
deposits, each asserted equal to `amount x (supply + liability) / depositTreasury()` and each stamped
into a different retention epoch; the delivery that mints exactly the voted reward and clears the
liability; and the exits. The measurements land in
`evidence/phase5/base-fork/measurements.json`. Scenario K (real Uniswap v3) is the separate
`npm run scenario:K` rehearsal; `FORK_SCENARIO_K=1` appends it to this run on the same fork.

Retention fires on the fork for real: with 61.94e18 of 121.94e18 shares exiting during the vote —
past the 34% bound — proposal #7 is processed `passed=false actionFailed=false`.

### The cost of the new retention accounting
`NavShareToken.burn` credits every consumed lot's epoch in a Fenwick tree whose capacity is
`MAX_EPOCHS = 2^24`, so one lot walks up to 25 nodes. On a token whose tree is still all zeroes each
of those is a cold 22,100-gas store, which is where a ragequit's gas now goes:

| Exit | Lots | Gas |
| --- | --- | --- |
| First exit of the DAO, member holding lots from 4 proposals | 4 | **796,184** |
| First exit of a fresh DAO, one genesis lot | 1 | 683,699 |
| Later exit, one lot, tree already written | 1 | 282,408 |
| Later exit, one genesis lot (epoch 0), tree already written | 1 | 317,590 |

Pre-phase-5 ragequit was ~120k. The first exit in a DAO pays a one-time premium of ~366k gas for
writing the tree (683,699 against 317,590 for the same single genesis lot once the nodes are
non-zero); after that a node costs the warm ~5k instead of the cold 22.1k, which is why the warm
numbers land near 300k. Extra lots add their own unshared nodes on top: 796,184 for four.

At 0.05 gwei a 796k exit costs 0.00004 ETH, so this is a design cost, not an affordability problem —
but the public copy should say that exiting is a 280k-800k gas transaction, not a ~120k one, and that
the member who exits first carries the tree for everyone after it.

## Testnet-only artifacts that never reach mainnet
MockUSDC and its `mint`; the relay faucet; the 120 s / 120 s Config proposals (#1 and the final
restore on Sepolia); the per-scenario DAOs under `evidence/testnet/scenario-daos/`; the actor keys in
`state/testnet/actors.json`; `--fork-genesis-commit` and everything else behind `--fork`.

## Not yet true
- **The genesis commit is not published.** The constitution can only pin a pushed commit, so the
  mainnet run cannot start from an unpublished HEAD. The fork rehearsal pins the newest pushed
  ancestor (`dcb3e83`, whose `docs/CONSTITUTION.md` bytes are identical to the working tree's) and
  says so in the record: `sourceCommit` is the local HEAD, `genesisCommit` the pushed ancestor. Step 3
  of the sequence needs a real push first.
- **`deployments/verification-base/upstream-contracts.json` does not exist yet** and cannot: it needs
  the four upstream addresses from the real deployment.
- **The mainnet relay, tunnel, sponsor key and beacon project do not exist.** Nothing in this plan
  has touched a live relay, launchd service, tunnel or sponsor account.
- **`MIN_DEPLOYER_WEI` is 0.005 ETH**, which the measured 24.78 M gas outgrows above ~0.2 gwei. The
  plan compensates by asking for 0.02 ETH; raising the constant is a parameter decision for the
  design authority, not a fix.
