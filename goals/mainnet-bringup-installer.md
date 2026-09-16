# Zero One DAO — a one-command, dry-run-validated mainnet bring-up installer (no live mainnet action)

Red-line clarification: our own repo. This task writes and DRY-RUNS an installer; it does NOT deploy to Base mainnet, does
NOT send any public-chain transaction, and MUST NOT touch, restart, or reconfigure the LIVE Base Sepolia services
(`ai.mkyang.zero-one-relay`, `ai.mkyang.zero-one-tunnel`) or their state/ports/ingress — those carry the running testnet
DAO and the canonical entry point. Never construct any rm command; never commit .env/keys/state; never print a key; git
email yangzk01@gmail.com; do not push. Do not touch docs/CONSTITUTION.md or the CLAUDE.md principle.

Run on the Mac mini, repo ~/srv/zero-one-dao (branch main). Read first: docs/MAINNET_PLAN.md (steps 3-5), the existing
relay server and static serving (relay/server.ts, relay/static.ts), beacon/scripts/build.ts and validate.ts, and how the
current Sepolia launchd services and cloudflared tunnel are wired (inspect ~/Library/LaunchAgents/ai.mkyang.zero-one-*.plist
and the tunnel config under ~/srv/zero-one-dao/state/tunnel/ READ-ONLY). Base the installer on the MAINNET_PLAN and the existing Sepolia launchd plists you can inspect on this mini; no other repo is needed.

## GOAL
`scripts/install-mainnet-services.py` (or .ts, your call) that, given a mainnet deployment record `deployments/base.json`
and a sponsor key file, stands up a SECOND, independent service pair on the mini without disturbing the Sepolia pair:
- a launchd relay `ai.mkyang.zero-one-relay-base` on its own free port, its own `RELAY_STATE_DIR=state/relay-base` (never a
  dir that held Sepolia requests or T0 passes), `ZERO_ONE_DEPLOYMENT=deployments/base.json`, `RELAY_BEACON_DIR` pointing at
  a mainnet beacon build, HOME in the env (launchd does not inject it; cloudflared hangs without it), KeepAlive.
- a cloudflared ingress for a mainnet hostname (e.g. `relay.zeroone.mkyang.ai` — confirm the exact hostname is a DECIDE line
  in docs/PARAMETERS.md; if unset, use a clearly-marked placeholder and record it as a designQuestion) added ADDITIVELY to
  the existing tunnel or a new named tunnel, protocol `quic` (http2 was blocked in the 2026-09-11 outage; decision.md), never
  dropping the Sepolia ingress.
- idempotent: re-running with an unchanged config is a no-op; it reports what it would change.
- a `--dry-run` that prints the exact plists, ports, env, ingress and the commands it would run, writing nothing and
  bootstrapping nothing, plus a preflight that fails loudly if `deployments/base.json` is absent, if the sponsor key is not
  0600, if the chosen port is taken, or if it would collide with a Sepolia label/port/ingress/state dir.

## ACCEPTANCE
- `--dry-run` against the CURRENT tree (which has no deployments/base.json) fails preflight naming the missing record, and
  against a copy of deployments/base-sepolia.json placed at a temp path prints a complete, plausible plist + ingress + port
  with zero side effects (prove the Sepolia services are untouched: their plists, ports and ingress identical before/after).
- A second dry-run with the beacon actually built for that record (beacon:build to a temp dir) shows RELAY_BEACON_DIR wired
  and the README the mainnet relay would serve.
- Receipts under evidence/phase5/mainnet-bringup/ (dry-run output, before/after diff of the Sepolia service files proving no
  change, the preflight failures). docs/MAINNET_PLAN.md step 4-5 rewritten to "run scripts/install-mainnet-services.py
  --deployment deployments/base.json --sponsor-key <file>" with the manual prose removed. decision.md gets a
  "2026-09-17 mainnet bring-up installer" entry with any designQuestion (the hostname, the tunnel choice). Committed, not pushed.

## NOT AN ANSWER
Anything that restarts or edits the live Sepolia relay/tunnel; a script with no dry-run; hardcoding a port or hostname
without a preflight; an installer that reuses a Sepolia state dir; a real mainnet deploy or transaction; leaving the manual
prose in the plan next to the new script.
