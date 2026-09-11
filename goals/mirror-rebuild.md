# Zero One DAO — rebuild the Vercel mirror so both origins serve the same corrected files

Red-line clarification: a static site rebuild for our own project; Base Sepolia only; no mainnet transaction; no contract
change. Never construct any rm command; never commit .env, keys or state; git email yangzk01@gmail.com.

Run on this Mac mini in ~/srv/zero-one-dao (branch main, already at the commit that fixed the served instructions). Its
network reaches Vercel; the main Mac's does not, which is why this runs here.

Background: the canonical origin https://relay-zero.mkyang.ai now serves the corrected README (raw-unit rule, where the
settlement token comes from, the optional amount on the fetch-only exit, the key-file note) and a member document whose
custody field tells the truth for fetch-only accounts. The Vercel mirror https://zero-one-beacon.vercel.app still serves the
older build, so the two origins disagree about the DAO's own trust disclosure.

## GOAL
1. Build the mirror from the current tree with the mirror origin and the current Sepolia deployment record, and deploy it to
   the existing Vercel project (do not create a new project, do not change its domain).
2. Prove the mirror now agrees with the canonical origin: fetch both READMEs and diff them, expecting differences only in
   the lines that name the origin itself; fetch the mirror's member document for the fetch-only address
   0x321D04C0ED837304F90162e55e76317378038fF2 and assert it reports custodial-lite; fetch every path the mirror README
   advertises and assert each answers with the expected content type.
3. Run beacon/scripts/validate.ts against the mirror origin and save the output. If a Vercel bot challenge answers instead
   of the file, that is a finding to record with the exact status and headers, not a failure to hide: report it and say
   which paths were affected.
4. Write evidence/testnet/phase5/mirror-rebuild.md with the deployment id, the diff, the assertions and any challenge you
   saw, and commit. Do not push.

## ACCEPTANCE
The mirror serves the corrected README; its member document reports custodial-lite for that address; the validator output
against the mirror is committed; any bot challenge is reported with its status and headers.

## NOT AN ANSWER
Creating a second Vercel project; editing the README by hand instead of building it; claiming the mirror is fine without
fetching it; hiding a challenge response.
