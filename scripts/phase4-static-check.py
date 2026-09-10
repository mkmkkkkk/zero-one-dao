"""Phase 4 source/document acceptance; run after compiling the committed local branch."""
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
BASE = "3e3f3de7ba6b5d1b6e3e735d1422b60e6273cd08"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


def main():
    receipts = []

    def record(line):
        receipts.append(line)
        print(line)

    pattern = r"\b(onlyOwner|Ownable|pause)\b"
    record(f"Source baseline: {BASE}")
    for name in ["TreasuryLedger.sol", "UniswapV3Venue.sol"]:
        command = ["rg", "-n", pattern, f"contracts/{name}"]
        result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
        record("$ " + " ".join(command))
        record(result.stdout.strip() or "(no matches)")
        assert result.returncode == 1, result.stderr or result.stdout
    diff = git("diff", "--no-ext-diff", "--unified=0", BASE, "--", "contracts")
    additions = [line[1:] for line in diff.splitlines() if line.startswith("+") and not line.startswith("+++")]
    matches = [line for line in additions if re.search(pattern, line)]
    record("Added Solidity lines: onlyOwner / Ownable / pause matches = " + str(len(matches)))
    assert not matches, matches
    # Baal's pre-existing token compatibility methods revert permanently. Their
    # names cannot honestly be reported absent from the entire repository.
    result = subprocess.run(["rg", "-n", pattern, "contracts", "--glob", "*.sol"], cwd=ROOT, text=True, capture_output=True)
    record("Full source grep (existing compatibility methods/comments, unchanged):")
    record(result.stdout.strip())
    for name in ["contracts/NavShareToken.sol", "contracts/LootToken.sol", "contracts/TestToken.sol"]:
        assert not git("diff", BASE, "--", name).strip(), f"legacy source changed: {name}"
    for name in ["TreasuryLedger", "UniswapV3Venue"]:
        artifact = json.loads((ROOT / "contracts" / "artifacts" / f"{name}.json").read_text())
        functions = [row["name"] for row in artifact["abi"] if row["type"] == "function"]
        assert not any(re.search(r"owner|admin|pause|^set", name, re.I) for name in functions if name not in ["settled", "settlement"])
        record(f"{name} ABI has no owner/admin/pause/setter function")
    for name in ["docs/CONSTITUTION.md", "CLAUDE.md"]:
        assert git("show", f"{BASE}:{name}") == (ROOT / name).read_text(), f"protected file changed: {name}"
    record("Protected constitution and CLAUDE.md: byte-for-byte unchanged")
    design = (ROOT / "docs/DESIGN.md").read_text()
    for section, count in [("6b", 3), ("6c", 8)]:
        body = re.search(rf"^## {section}\. .*\n(.*?)(?=^## |\Z)", design, re.M | re.S)
        assert body, f"missing DESIGN section {section}"
        lines = [line for line in body.group(1).splitlines() if line.strip()]
        assert len(lines) == count if section == "6b" else len(lines) <= count
        record(f"DESIGN section {section}: {len(lines)} nonempty lines")
    readme = (ROOT / "beacon/templates/README.txt").read_text()
    lines = len(readme.rstrip().splitlines())
    assert lines <= 44
    assert "Deposits pause while the treasury holds anything but USDC; exit is pro-rata of the Safe." in readme
    record(f"README template: {lines} lines (maximum 44); settlement/exit sentence present")
    assert "phase 4 designQuestions" in (ROOT / "decision.md").read_text()
    changed = git("diff", "--name-only", BASE).splitlines()
    sensitive = [name for name in changed if any(part in ["state", ".env", "keys"] or part.startswith(".env.") for part in Path(name).parts)]
    assert not sensitive, sensitive
    record("Changed tracked files: no .env / keys / state paths")
    record("PHASE 4 STATIC ACCEPTANCE PASS")
    target = ROOT / "evidence/phase4/no-admin.log"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(receipts) + "\n")


if __name__ == "__main__":
    main()
