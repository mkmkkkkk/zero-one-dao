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
