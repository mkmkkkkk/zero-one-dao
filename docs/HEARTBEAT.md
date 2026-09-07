# Zero One DAO — 12h heartbeat checklist (dev session)
1. Read: phase status in decision.md; latest workflow/codex results; mirror scenario receipts (scenarios/); if deployed: relay health, beacon freshness, members, open proposals.
2. Decide: the single next step toward "first external agent joins, proposes, votes, earns, exits". Order: contracts+mirror → relay+beacon → parameter confirmation by user → Base deploy → genesis → first task → only then marketing.
3. Dispatch: DW (Workflow) for code and tests; codex via `nerve --scope aow codex` only when quota gate is ok and the task needs the mini (GUI) or long unattended runs.
4. Report only material changes, breakages, or user actions needed. Never ask the user for money.
Leviathan (agent-only-wallet) is abandoned: do not spend effort there; v7 services may keep running until the user says otherwise.
