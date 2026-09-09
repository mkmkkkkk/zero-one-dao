# Zero One DAO — pre-mainnet security audit of our own contracts: failure-mode catalogue + invariant test suite

Context: this is an internal audit of our own open-source repository (github.com/mkmkkkkk/zero-one-dao) before its mainnet
deployment, run by its maintainers on a LOCAL anvil devnet. Nothing touches a public network. "USDC", "payment", "treasury"
are contract names. Never construct any rm command; never commit .env/keys/state; git email yangzk01@gmail.com. Do not modify
contracts, relay or existing docs; outputs are docs/SECURITY_AUDIT.md and tests under evidence/audit/. You report; the design
authority (Fable) decides fixes.

Repo: ~/srv/zero-one-dao on this Mac mini. `git fetch origin && git checkout -b security-audit origin/main`. Read: CLAUDE.md,
docs/DESIGN.md, docs/CONSTITUTION.md, docs/PARAMETERS.md, docs/TEMPLATES.md, docs/RELAY.md, docs/TESTNET_PLAN.md, decision.md
(all phases; the phase 4 section describes fixes in progress on branch phase4-ledger-twap, audit those too), contracts/*.sol,
vendored Baal 1.2.18, relay/*.ts, beacon/templates, scenarios/.

## GOAL
`docs/SECURITY_AUDIT.md`: a catalogue of failure modes, one row each: id, component, invariant that should hold, the
adversarial scenario that violates it (preconditions, steps, cost to the actor, who loses how much), severity (Critical /
High / Medium / Low / Accepted-by-principle), status (Demonstrated by test <path> | Argued | Holds because ...).
"Accepted-by-principle" is only for what the constitution explicitly allows (any member may propose anything; silence is
consent; exit is the remedy) and must say why vote/exit actually protects the loser.

For every Critical / High row: an invariant test under evidence/audit/ that runs on anvil against the mirror deployment
(scripts/deploy-local.ts or scenarios/lib.ts) and FAILS today with a log showing balances / shares before and after (a
failing test is the finding); or a precise argument why the invariant cannot be violated. Numbers, not adjectives.

Components and invariants to cover, at minimum:
1. Baal governance: vote weight = checkpoint at submission; no vote in the submission block; quorum 0; minRetention 66
   boundary; grace exits; sponsorship-order processing (a Config that shortens periods delays later executions);
   cancelProposal; sponsor threshold; expiration 0; actionFailed semantics; 5,000,000 gas at processProposal (can an action be
   made to exceed it); re-entrancy through Safe execution; proposals that change Safe owners/modules; one-way lock flips;
   shaman permissions.
2. NAV and capital: DepositShaman pricing with and without the TreasuryLedger; same-transaction deposit + ragequit round trips
   (with borrowed funds); first-depositor share inflation and donation effects; rounding to zero; ragequit token ordering and
   non-settlement assets; value held in instances; Project tranches; Payment to self; strategy budgets moving NAV; the
   1 s / 1 s self-lock.
3. Work: verifier collusion; verifier ≠ proposer via a second key; sybil task farms; reward inflation; claim/deliver
   blocking; expiration edges; activation only by Safe.
4. Templates / factory: CREATE2 salt collisions; substituting code between quote and submission (prove impossible);
   permissionless deploy side effects; operator = member binding; onlySafe paths; migrate to a hostile successor; amend bounds;
   Strategy run() being permissionless (MEV, same-block price moves, TWAP window edges, observation cardinality, stale TWAP,
   near-empty pools); sweep(); Config NotApplied.
5. EIP-7702 intent account and relay: replay across chains/instances; nonce; deadline; signature malleability;
   re-delegation of the member EOA; what a misbehaving or compromised relay/sponsor can do with a signed intent (reorder,
   delay, drop, front-run, substitute); state-override simulation mismatches; sponsorship budget exhaustion; faucet limits;
   T0 passphrase custody (entropy, reuse, operator access); rate-limit bypass; cross-process lock failure modes; index
   integrity against crafted events; /proposals.json pagination; beacon staleness; constitution URL vs hash; hosting
   compromise.
6. Operations: founder key compromise (what remains under its control), sponsor key compromise, RPC lag / reorgs on Base,
   USDC blacklist of the Safe or a member, Baal singleton reuse, deployment-script refusal bypass.
7. Economic: capture of a small treasury by a large depositor; sleeping members; proposal volume economics at sponsor
   threshold 1 share; impersonation; contracts acting as members; cost of blocking vs gain.

Close with: (a) the ranked must-fix list before mainnet, (b) what is accepted by principle, (c) where the phase 4 changes
(ledger, TWAP) are insufficient or introduce a new failure mode.

## ACCEPTANCE
docs/SECURITY_AUDIT.md with ≥ 40 distinct rows across all seven components; every Critical/High row has a test path or an
impossibility argument; evidence/audit/ holds the tests and logs; branch security-audit committed locally (no push).

## NOT AN ANSWER
Generic checklists not tied to this code; rows without preconditions and cost; "could be an issue" without a test attempt;
fixing anything; touching contracts or relay code.

## NO PRESCRIBED METHOD / INDEPENDENT REVIEW
Up to 4 subagents by component, then one fresh subagent tries to refute each Critical/High row before it stays.
