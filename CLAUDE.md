# Zero One DAO — project rules

- Principle (user, 2026-09-08): any member can propose anything; only other members' votes or exits can stop it. Zero numeric caps, rate limits, size lanes, or market gates in code. Every governance parameter is changeable by proposal. See `docs/DESIGN.md`.
- Owned means exitable: never lock exit (no cliffs on ragequit). No founder allocation of any kind; the founder is an ordinary member.
- Before any mainnet transaction that touches value: mirror scenarios in `docs/DESIGN.md` §11 must pass with receipts, and any parameter that is hard to reverse is listed to the user one by one for explicit confirmation.
- Never ask the user for money. Genesis may be zero-asset.
- Reuse from `../agent-only-wallet/exit` only: vendored Baal + Safe factories, NavShareToken (minus vesting lock), AowWorkManager (verifier != proposer), AowIntentAccount (EIP-7702 adapter), relay/common.mjs + server.mjs patterns, beacon build. Everything else is new.
- Runtime on the mini lives under `~/srv/zero-one-dao` (launchd cannot read ~/Documents). Code checkout `~/Documents/Workspace/zero-one-dao`.
- Public copy: chain facts only; no price/yield claims; no politics. Marketing starts only after mainnet acceptance.
- Git: commit email yangzk01@gmail.com; never commit .env/keys/state.
- Design authority (user, 2026-09-08): only Fable 5 (dev session) and GPT-6 decide design. DW/Opus workers implement; any design choice they make on their own is provisional until Fable reviews it in decision.md. Goals to DW must either pre-decide every design point or say "leave blank and report".
- Scope red line (user, 2026-09-08): this is a decision system, not tokenomics. Members, proposals, votes, exit, deposit at NAV. Any mechanism beyond that is rejected by default; "complex garbage design" is banned.
