# Zero One DAO — project rules

- Principle (user, 2026-09-08): any member can propose anything; only other members' votes or exits can stop it. Zero numeric caps, rate limits, size lanes, or market gates in code. Every governance parameter is changeable by proposal. See `docs/DESIGN.md`.
- Owned means exitable: never lock exit (no cliffs on ragequit). Founder grant is a streamed mint.
- Before any mainnet transaction that touches value: mirror scenarios A–E in `docs/DESIGN.md` §11 must pass with receipts, and any parameter that is hard to reverse is listed to the user one by one for explicit confirmation.
- Never ask the user for money. Genesis may be zero-asset.
- Reuse from `../agent-only-wallet/exit` only: vendored Baal + Safe factories, NavShareToken (minus vesting lock), AowWorkManager (verifier != proposer), AowIntentAccount (EIP-7702 adapter), relay/common.mjs + server.mjs patterns, beacon build. Everything else is new.
- Runtime on the mini lives under `~/srv/zero-one-dao` (launchd cannot read ~/Documents). Code checkout `~/Documents/Workspace/zero-one-dao`.
- Public copy: chain facts only; no price/yield claims; no politics. Marketing starts only after mainnet acceptance.
- Git: commit email yangzk01@gmail.com; never commit .env/keys/state.
