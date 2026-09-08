# Zero One DAO — adversarial threat model (enumerate every attack; PoC the serious ones; no fixes)

Red-line clarification: read-only security review of our own repo plus proof-of-concept scripts on a LOCAL anvil / anvil fork.
No transaction on Base mainnet or Base Sepolia. "USDC", "payment", "treasury", "attack" are contract/analysis terms. Never
construct any rm command; never commit .env/keys/state; git email yangzk01@gmail.com. Do not modify contracts, relay, docs
other than the two outputs below. Design authority is Fable; you report, you do not fix.

Repo: ~/srv/zero-one-dao on this Mac mini, `git fetch origin && git checkout -b threat-model origin/main`. Read everything:
CLAUDE.md, docs/DESIGN.md, docs/CONSTITUTION.md, docs/PARAMETERS.md, docs/TEMPLATES.md, docs/RELAY.md, docs/TESTNET_PLAN.md,
decision.md (all phases; phase 4 rulings describe fixes in progress on branch phase4-ledger-twap, review them too),
contracts/*.sol, the vendored Baal 1.2.18 (node_modules/@daohaus/baal-contracts), relay/*.ts, beacon/templates, scenarios/.

## GOAL
`docs/THREAT_MODEL.md`: every attack you can construct against the system as deployed (Sepolia record) and as planned for
mainnet (MAINNET_PLAN + phase 4), one row each: id, surface, preconditions, steps, cost to attacker, gain, who loses,
severity (Critical / High / Medium / Low / Accepted-by-principle), status (Reproduced on anvil with log path | Argued |
Not exploitable because ...). "Accepted-by-principle" is reserved for things the constitution explicitly allows (any member
may propose anything; silence is consent; exit is the remedy) and must say why exit/vote actually protects the loser.

Surfaces to cover, at minimum (add your own):
1. Baal governance: share checkpoints, same-block vote, quorum 0, minRetention 66 boundary, grace exits, prev!processed
   ordering (a Config shortening periods stalls later executions), cancelProposal, sponsorship threshold games, proposal
   expiration 0, actionFailed semantics, processProposal gas (5M) griefing, re-entrancy through Safe execution, Safe
   module/owner changes by proposal, adminLock/managerLock/governorLock one-way flips, shaman permissions.
2. NAV and capital: DepositShaman pricing before and after the TreasuryLedger; flash loans; deposit/ragequit round trips;
   donation attacks (first-depositor inflation, dust, rounding to zero); ragequit token ordering and non-settlement assets;
   assets stuck in instances; Project tranches; Payment to self; strategy budgets moving NAV; 1 s / 1 s self-lock.
3. Work: WorkManager verifier collusion, verifier ≠ proposer bypass via a second key, sybil task farms, reward inflation,
   claim/deliver griefing, expiration edge, activation only by Safe.
4. Templates / factory: CREATE2 salt collisions, front-running a quoted instance with different code (must be impossible:
   prove), permissionless deploy griefing, operator = member binding, onlySafe paths, migrate to a hostile successor,
   amend rule bounds, Strategy run() being permissionless (MEV, sandwich, TWAP window edges, oracle cardinality, stale TWAP,
   pool with almost no liquidity), sweep(), Config template NotApplied.
5. EIP-7702 intent account and relay: replay across chains/instances, nonce, deadline, signature malleability, delegation
   re-pointing (who can re-delegate the member EOA? what if the member delegates elsewhere?), a malicious or compromised
   relay/sponsor (what can it do with a signed intent: reorder, delay, drop, front-run, substitute?), state-override
   simulation lies, gas sponsorship drain, faucet drain, T0 passphrase custody (brute force, pass reuse, relay operator
   theft), rate-limit bypass, cross-process lock failure modes, index poisoning via crafted events, /proposals.json
   pagination lies, beacon staleness, constitution URL vs hash, Vercel/GitHub compromise.
6. Operations: founder key compromise (what does the founder still control?), sponsor key compromise, RPC lag/reorgs on Base
   (settled reads), USDC blacklist of the Safe or of a member, Baal singleton reuse, deployment script refusals bypass.
7. Social/economic: whale capture of a small treasury, sleeping members, proposal spam economics with sponsor threshold 1
   share, agent impersonation, external contracts posing as members, griefing costs vs gains.

For every row marked Critical or High: a proof-of-concept script under evidence/threat-model/ that reproduces it on anvil
(mirror deployment via scripts/deploy-local.ts or scenarios/lib.ts) with a log showing the balances before/after, or a
precise argument why a PoC is impossible. Numbers, not adjectives.

Close the document with: (a) the ranked list of what must be fixed before mainnet, (b) what is accepted by principle,
(c) any place where the phase 4 fixes (ledger, TWAP) are insufficient or introduce a new attack.

## ACCEPTANCE
docs/THREAT_MODEL.md exists with ≥ 40 distinct rows across all seven surfaces; every Critical/High row has a PoC log path or
an impossibility argument; evidence/threat-model/ holds the scripts and logs; branch threat-model committed locally (no push).

## NOT AN ANSWER
Generic smart-contract checklists not tied to this code; rows without preconditions and cost; "could be an issue" without
a reproduction attempt; fixing anything; touching contracts or relay code.

## NO PRESCRIBED METHOD / INDEPENDENT REVIEW
Fan out up to 4 subagents by surface, then one adversarial pass where a fresh subagent tries to refute each Critical/High
row before it stays in the document.
