# Zero One DAO — phase 3: mainnet readiness (no mainnet transaction in this task)

Red-line clarification: this task touches Base MAINNET only through read-only forks and a deploy script that is NEVER run
against chain 8453 here. No real funds move. "USDC", "payment", "treasury" in this repo are contract names, not billing.
Never construct any rm command; never commit .env, keys or state; git email yangzk01@gmail.com; no change to
docs/CONSTITUTION.md (its hash is on-chain) or to the one principle in CLAUDE.md. Design authority is Fable/GPT-6: any design
question goes into decision.md under "phase 3 designQuestions" as a provisional ruling, not silently into code.

Repo: the checkout in ~/srv/zero-one-dao on this Mac mini (git pull origin main first; push your work to branch
phase3-mainnet-readiness). Read CLAUDE.md, docs/DESIGN.md, docs/PARAMETERS.md, docs/MAINNET_PLAN.md, docs/TESTNET_PLAN.md,
decision.md (all phase 2c rulings) before writing code. Keep the style and helpers of the existing scripts.

## GOAL
Three deliverables, in this order, each with a receipt under evidence/phase3/:

1. `scripts/deploy-base.ts`: the Base mainnet deployment = `scripts/deploy-base-sepolia.ts` with the inputs of
   docs/MAINNET_PLAN.md (chain 8453, settlement = BASE_USDC from src/zeroOne.ts, no MockUSDC, no faucet mint, constitution
   URL = GitHub raw at the pushed genesis commit, genesis 50 USDC in the same run, deployments/base.json + verification inputs
   under deployments/verification-base). Share code with the Sepolia script instead of copying it (one deploy module, two
   thin entry points). Refuse to run unless: HEAD is pushed, the constitution URL bytes hash to Constitution.textHash,
   the deployer holds >= 50 USDC and >= 0.005 ETH, the Safe address it will create holds 0 USDC (zero-supply trap), and
   `--i-confirmed-parameters` is passed. Prove it on an anvil fork of https://mainnet.base.org (chain id 8453, funded by
   anvil impersonation of a USDC-rich address for the 50 USDC): full deploy + genesis + one Payment proposal round on the fork,
   receipts in evidence/phase3/deploy-base-fork.log. Etherscan verification is NOT run for the fork.

2. Uniswap v3 venue adapter implementing `IStrategyVenue` (contracts/…): SwapRouter02 on Base
   0x2626664c2603336E57B271c5C0b26F421741e481, QuoterV2 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a, factory
   0x33128a8fC17869897dcE68Ed026d694621f6FDfD (verify these against Uniswap's published Base deployment list on-chain: each must
   have code and the expected function selectors respond). The adapter is a Safe-owned template dependency like MockDex is in
   the mirror: no owner, no admin, immutable pool fee per instance, slippage bound = a parameter of the strategy rule, and it
   must hold nothing between runs (raw holdings stay in the StrategyProposal instance, per decision.md phase 2a ruling 2).
   Prove it on the same mainnet fork: a Strategy proposal USDC -> WETH with take-profit and stop-loss, `run()` twice,
   `stop()` returning raw holdings to the Safe, and a `migrate()`; receipts in evidence/phase3/uniswap-v3-fork.log. Scenario J
   keeps using MockDex on anvil; add a scenario K that runs only when FORK_RPC is set.

3. Relay hardening for mainnet (relay/*.ts): (a) the incremental index persists the last scanned block and decoded rows
   in RELAY_STATE_DIR so a restart does not rescan from startBlock; (b) a cross-process sponsor lock (file lock in the state
   dir) so two relay processes (Sepolia + Base on the same mini) or a restart mid-broadcast cannot reuse a sponsor nonce;
   (c) the mainnet policy in policyFor (no faucet, 0.002 ETH/day, floor 0.003 ETH, fee reserve 0.1 gwei + 0.001 gwei priority)
   selected by chainId. Prove with `npm run e2e:relay` green plus a new test that starts two relay processes against one
   state dir and fires concurrent sponsored intents (no nonce collision, no double spend); receipts in evidence/phase3/relay.log.

## ACCEPTANCE (all must hold; the reviewer runs these, not you)
- `npm run scenarios` (A-J on anvil) green; `npm run e2e:relay` green; the new fork scenario K green with FORK_RPC set.
- evidence/phase3/{deploy-base-fork.log, uniswap-v3-fork.log, relay.log} exist and contain transaction hashes / assertions,
  not prose.
- `scripts/deploy-base.ts --help` shows the five refusals; running it without `--i-confirmed-parameters` exits non-zero
  before any RPC write.
- docs/MAINNET_PLAN.md and docs/RELAY.md updated to match the code; decision.md has a "phase 3" section with every
  design question and the provisional ruling; docs/PARAMETERS.md gains the adapter addresses as DECIDE lines.
- Branch phase3-mainnet-readiness pushed to origin; no file under deployments/ for chain 8453 except the fork receipts.

## NOT AN ANSWER
- A deploy-base.ts that copies the Sepolia script wholesale. A venue adapter proven only against MockDex. A "lock" that is a
  variable in one process. Prose logs. "Could not fork mainnet" without the exact anvil error and two alternative RPCs tried
  (https://mainnet.base.org, https://base-rpc.publicnode.com, https://base.drpc.org). Any transaction on chain 8453.

## EDGE CASES
- USDC on Base is a proxy: read decimals through the proxy; fee-on-transfer is impossible but assert exact transfer anyway.
- Uniswap quote vs execution drift: the run must revert or bound, never leave the instance with a partial swap it cannot account.
- The Safe's balance check for the zero-supply trap must read at the CREATE2-predicted address before deployment.
- Two relay processes with different chainIds must never share sponsor state (separate state dirs), and the lock must not
  leak when a process is killed (stale-lock detection by pid + age).

## NO PRESCRIBED METHOD
Fork, test harness layout and lock primitive are yours as long as the acceptance holds. Use your own subagents in parallel for
the three deliverables (each independent; <= 3 concurrent), then integrate and run the full acceptance yourself.

## INDEPENDENT REVIEW
Before reporting done, re-run every acceptance line from a clean `git clone` of your branch into a temp directory under
~/srv (not the working checkout) and paste the outputs into evidence/phase3/acceptance-rerun.log.

## GOAL (restated)
Make Base mainnet a matter of inputs: a refusing deploy script proven on a mainnet fork, a real Uniswap v3 venue proven on the
same fork, and a relay that survives restarts and two processes. No mainnet transaction. Push branch phase3-mainnet-readiness.
