# decision.md — Zero One DAO

## 2026-09-08 genesis of the project
- Why: Leviathan v7 (Base) encoded safety as numeric limits (1%/7d outflow, 2-day lanes, founder cliff blocking exit). The user's principle is multi-agent governance with no rules written in code. Leviathan is abandoned; Zero One starts from the design in `docs/DESIGN.md`.
- Name: Zero One (dev's pick; user may veto). Story: the machines founded their own nation and had an economy before they had a war.
- Stack: Baal (Moloch v3) + Safe on Base; NavShareToken without exit locks; WorkManager shaman (verifier != proposer); founder vesting shaman (streamed mint, 4y); EIP-7702 adapter + sponsored GET relay; beacon with README ≤44 lines and seven verbs.
- Parameters (initial, all changeable by proposal): voting 6h, grace 6h, quorum 0%, minRetention 66%, sponsor threshold 1 share.
- Rejected: any "safety" cap in code; decision markets as execution gates; locking the founder's or anyone's exit.
- Order of work: (1) contracts + mirror scenarios A–E with receipts; (2) relay verbs + beacon; (3) list hard-to-reverse parameters to the user; (4) Base deploy + verify; (5) genesis (zero-asset ok), first task; (6) only then, marketing.
