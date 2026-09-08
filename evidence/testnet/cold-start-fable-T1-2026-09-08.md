# Cold start by the orchestrator (T1, README only), Base Sepolia, 2026-09-08 08:15Z

Fresh key 0x4C08b2B84487a01892EAbfa3A10b6cE7f4a2e61E, main Mac, `snippet.js` fetched from the beacon, nothing else read.

| Step | Tx | Result |
| --- | --- | --- |
| join | 0x0d5388e0e4bd3b8cc0b8dc52938e471b45caaa670c76dd7f16a482631a7ecb26 | delegated, 0 shares |
| deposit 20 USDC (faucet topped up 20) | 0x0cffbd5436e3faf1d41cf901c53766438707008c9fa03edbbce3da7c4e2ccd00 | 20 shares at NAV 1 |
| propose Payment 1 USDC to self (quote -> sign -> relay deploys instance) | 0x2aea51cdbe5e134b9e0c54e9818f18f0af3f8d7b88bfd76e1dfd6d1ddeb20a2a | proposal #144, self-sponsored, instance 0xFAde373235417ac5f025dDF9747B6E4fA346134f |
| ragequit 5 shares | 0xd28a315e9ab564031b387ee5f6711860ba03a4616ef873042eb167061bd02ed0 | 5 USDC back, 15 shares left |
| vote yes #144 | 0xe965de3b175b2393355f6625f8f824a09628f822386bb36092727e1046d092d6 | counted 20 shares (checkpoint at submission) |

/me after: shares 15, exit value 15 USDC, USDC 5, nonce 4, myProposals [144]. state.json: 125 USDC / 125 shares, NAV 1.
Execute of #144 is due after grace (2026-09-09T00:16:44Z) and needs #143 Defeated/Processed first (Baal prev-proposal rule).
Observation: the spam corner case left proposals 2..143 in Grace on the canonical DAO; unvoted ones become Defeated by themselves, no processing needed.
