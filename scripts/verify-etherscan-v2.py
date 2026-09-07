"""Verify Zero One sources on Basescan through the Etherscan V2 API.

Run from the repository root on the Mac mini; the API key is read only from
~/.config/etherscan/api_key and redacted from every printed line.

Usage: python3 scripts/verify-etherscan-v2.py local [--chain 84532] [--dir deployments/verification-base-sepolia]
       python3 scripts/verify-etherscan-v2.py upstream ...   (vendored Baal/Safe singletons; per-contract inputs)
"""
import argparse
import json
import os
import pathlib
import subprocess
import time
import urllib.parse

parser = argparse.ArgumentParser()
parser.add_argument("group", choices=["local", "upstream"])
parser.add_argument("--chain", default="84532", help="Etherscan V2 chainid (84532 Base Sepolia, 8453 Base)")
parser.add_argument("--dir", default="deployments/verification-base-sepolia", help="verification input directory")
parser.add_argument("--only", default="", help="comma-separated contract names to (re)submit")
args = parser.parse_args()
base = pathlib.Path(args.dir)
(base / "evidence").mkdir(exist_ok=True)
key = (pathlib.Path.home() / ".config/etherscan/api_key").read_text().strip()
assert key, "Empty API key"


def api(**fields):
    """POST one Etherscan V2 contract-module call and return the parsed JSON (key redacted).

    Args:
        **fields: Form fields (action, contractaddress, ...).

    Returns:
        dict: The parsed response.

    Raises:
        subprocess.CalledProcessError: If curl fails at the HTTP level.
    """
    fields.update(chainid=args.chain, module="contract", apikey=key)
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    response = subprocess.run(
        ["curl", "--silent", "--show-error", "--fail-with-body", "--max-time", "90",
         *(["--proxy", proxy] if proxy else []),
         "https://api.etherscan.io/v2/api?chainid=" + args.chain, "--data-binary", "@-"],
        input=urllib.parse.urlencode(fields), text=True, capture_output=True, check=True)
    return json.loads(response.stdout.replace(key, "[REDACTED]"))


records_file = "constructor-arguments.json" if args.group == "local" else "upstream-contracts.json"
only = {name for name in args.only.split(",") if name}
source = (base / "standard-input.json").read_text() if args.group == "local" else None
results = {}
for contract in json.loads((base / records_file).read_text()):
    if only and contract["name"] not in only:
        continue
    already = api(action="getsourcecode", address=contract["address"])
    if already["status"] == "1" and already["result"][0].get("SourceCode"):
        print(contract["name"], "already-verified", already["result"][0].get("ContractName"))
        results[contract["name"]] = "already-verified"
        (base / "evidence" / (contract["name"] + "-source.json")).write_text(json.dumps(already, indent=2) + "\n")
        time.sleep(0.5)
        continue
    result = api(action="verifysourcecode",
                 contractaddress=contract["address"],
                 sourceCode=source if args.group == "local" else (base / contract["inputFile"]).read_text(),
                 codeformat="solidity-standard-json-input",
                 contractname=contract["contractName"],
                 compilerversion=contract["compiler"],
                 constructorArguements=contract["constructorArguments"])
    print(contract["name"], "submission", json.dumps(result))
    if result["status"] == "1":
        guid = result["result"]
        for _attempt in range(40):
            time.sleep(5)
            status = api(action="checkverifystatus", guid=guid)
            print(contract["name"], "verification-status", json.dumps(status))
            if "pending" not in status["result"].lower():
                break
        else:
            raise RuntimeError("Verification polling timed out: " + contract["name"])
    time.sleep(1)
    observed = api(action="getsourcecode", address=contract["address"])
    (base / "evidence" / (contract["name"] + "-source.json")).write_text(json.dumps(observed, indent=2) + "\n")
    verified = (observed["status"] == "1" and isinstance(observed["result"], list)
                and bool(observed["result"][0].get("SourceCode"))
                and observed["result"][0].get("ABI") != "Contract source code not verified")
    print(contract["name"], "source-present", verified)
    results[contract["name"]] = "verified" if verified else "FAILED"
    if not verified:
        raise RuntimeError("Source verification not confirmed: " + contract["name"])
    time.sleep(1)
print(json.dumps(results))
