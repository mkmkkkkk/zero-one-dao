"""Summarize explorer source readbacks against the fresh Sepolia deployment, never submission GUIDs."""
import datetime
import hashlib
import json
import pathlib

root = pathlib.Path("evidence/testnet/phase5")
base = pathlib.Path("deployments/verification-base-sepolia")
manifest = json.loads((root / "verification-manifest.json").read_text())
assert manifest["chainId"] == 84532
records = manifest["contracts"] + [dict(manifest["baalProxy"], name="BaalProxy")]
rows = []
for contract in records:
    file = base / "evidence" / (contract["name"] + "-source.json")
    body = json.loads(file.read_text()) if file.exists() else {}
    result = body.get("result", [])
    source = result[0] if isinstance(result, list) and result else {}
    verified = body.get("status") == "1" and bool(source.get("SourceCode")) and source.get("ABI") != "Contract source code not verified"
    if contract["name"] == "BaalProxy":
        verified = verified and source.get("Implementation", "").lower() == contract["implementation"].lower()
    rows.append({**contract, "verified": bool(verified), "contractName": source.get("ContractName", "unknown"),
                 "compiler": source.get("CompilerVersion", "unknown"), "readback": str(file),
                 "readbackSha256": hashlib.sha256(file.read_bytes()).hexdigest() if file.exists() else "unknown"})
out = {"chainId": 84532, "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
       "verified": sum(row["verified"] for row in rows), "expected": len(rows), "contracts": rows}
(root / "verification-result.json").write_text(json.dumps(out, indent=2) + "\n")
print(f'BASESCAN SOURCE READBACK: {out["verified"]}/{out["expected"]} verified')
for row in rows:
    print(f'{row["name"]}: {"VERIFIED" if row["verified"] else "unknown"} {row["address"]}')
raise SystemExit(0 if out["verified"] == out["expected"] else 1)
