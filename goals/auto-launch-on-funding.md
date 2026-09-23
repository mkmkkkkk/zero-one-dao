# Zero One DAO — one fail-closed launch script + a funding watcher that runs it (prove on a Base fork; do not touch mainnet)

Red-line clarification: our own repo. This task builds and PROVES on a local anvil fork of Base. It must NOT send any
transaction to Base mainnet or any public chain, must NOT touch the live Sepolia services (ai.mkyang.zero-one-relay,
ai.mkyang.zero-one-tunnel) or their state, and must leave the watcher DISARMED. Never construct any rm command; never
commit .env, keys or state; never print a private key; git email yangzk01@gmail.com; do not push.
Reading Base mainnet through a public RPC to build a local fork is allowed (export HTTPS_PROXY=http://127.0.0.1:7897).

Context: the user will send 0.025 ETH + 50 USDC on Base mainnet to the deployer 0xD38E179BD9dCfFC2F004Aa96d93A11896921A49c,
whose key is in the repo-relative state/deployer-base.env (0600, var ANCHOR_PRIVATE_KEY). Parameters are confirmed. The goal
is that funding alone completes the launch, with no human or orchestrator awake. Read docs/MAINNET_PLAN.md,
scripts/deploy-network.ts, scripts/deploy-base.ts, scripts/install-mainnet-services.py, src/deployerGate.ts,
beacon/scripts/build.ts and validate.ts, and decision.md (2026-09-17 installer + hostname ruling: relay.zeroone.mkyang.ai).

## GOAL
1. scripts/launch-mainnet.sh (or .ts): the whole sequence, fail-closed, idempotent and resumable (a state file records
   which step finished; a rerun continues from the next step, never repeats a transaction):
   a. preflight: deployer holds >= computed gas requirement and >= 50 USDC; HEAD is pushed and clean; constitution URL
      = raw GitHub at HEAD, bytes hash to the on-chain hash constant.
   b. npm run deploy:base with --i-confirmed-parameters, the key file and that URL; write deployments/base.json.
   c. Basescan verification of every contract (use the existing Etherscan V2 verify script and whatever API key the repo
      already uses for Sepolia; if none is found on disk, record the step as pending, do not fail the launch).
   d. a fresh 0600 sponsor key (scripts/testnet-key.ts), transfer 0.01 ETH to it from the deployer.
   e. the Cloudflare DNS route for relay.zeroone.mkyang.ai to the tunnel (cloudflared tunnel route dns, or the API the
      repo already uses), then scripts/install-mainnet-services.py --deployment deployments/base.json --sponsor-key <file>
      --hostname relay.zeroone.mkyang.ai, then beacon build + validate against the live mainnet origin.
   f. write evidence/mainnet/launch-<timestamp>.md with every transaction hash and address, and a one-line status file.
2. A launchd watcher on this mini (label ai.mkyang.zero-one-launch-watch) that every 10 minutes checks the deployer's ETH and
   USDC on Base mainnet and, when BOTH thresholds are met, runs the launch script once, logging to state/logs/. It must be
   installed DISARMED: it runs only if the file state/launch-armed exists. Document how to arm it (touch that file).
3. Prove it on a local anvil fork of Base: fund the deployer by impersonation, point the script at the loopback fork
   (a flag), run the whole sequence steps a-b and d on the fork (c and e are mainnet-only: exercise them in a dry-run mode
   that prints exactly what they would do), then run it a second time to show resume/idempotence (no repeated tx). Also
   prove the watcher logic on the fork: below threshold does nothing; above threshold triggers exactly once.
4. Receipts under evidence/phase5/auto-launch/; docs/MAINNET_PLAN.md updated to "fund the address, the watcher launches";
   decision.md entry "2026-09-23 auto-launch on funding" with any designQuestion. Commit, do not push.

## ACCEPTANCE
Fork run completes deploy + genesis + sponsor funding with hashes; second run is a no-op per step; watcher triggers once on
the fork and not below threshold; the real watcher is installed but DISARMED (show launchctl print and the absent arm file);
live Sepolia services byte-identical before/after; no public-chain transaction sent.

## NOT AN ANSWER
Running anything against Base mainnet; an armed watcher; a script that repeats a transaction on rerun; printing a key;
touching Sepolia services; a launch that silently skips a failed step without writing it to the status file.
