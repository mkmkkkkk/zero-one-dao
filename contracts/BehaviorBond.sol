// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Testnet-only commitment to a behavioral contract. The named oracle is trusted
/// to run the harness; the EVM verifies its identity, NOT the Java execution itself.
contract BehaviorBond {
    bytes32 public immutable contractHash;
    address payable public immutable promisor;
    address payable public immutable beneficiary;
    address public immutable oracle;
    uint256 public immutable bond;
    uint64 public immutable startsAt;
    uint64 public immutable expiresAt;
    uint64 public immutable disputeSeconds;
    uint64 public reportedAt;
    bytes32 public evidenceHash;
    bool public failed;
    bool public settled;

    event Committed(bytes32 indexed contractHash, uint256 bond);
    event Reported(bytes32 indexed evidenceHash, bool failed, uint64 reportedAt);
    event Settled(bytes32 indexed contractHash, bytes32 indexed evidenceHash, bool slashed, address recipient, uint256 amount);

    constructor(bytes32 hash_, address payable beneficiary_, address oracle_, uint64 starts_, uint64 expires_, uint64 dispute_) payable {
        require(block.chainid == 84532 || block.chainid == 31337, "testnet only");
        require(hash_ != bytes32(0) && msg.value > 0, "empty commitment");
        require(beneficiary_ != address(0) && beneficiary_ != msg.sender && oracle_ != address(0), "identity");
        require(expires_ > starts_ && expires_ > block.timestamp, "expiry");
        contractHash = hash_;
        promisor = payable(msg.sender);
        beneficiary = beneficiary_;
        oracle = oracle_;
        bond = msg.value;
        startsAt = starts_;
        expiresAt = expires_;
        disputeSeconds = dispute_;
        emit Committed(hash_, msg.value);
    }

    /// @notice Pass is a final acceptance replay after expiry. Fail may be reported
    /// during coverage or the dispute window. A failure cannot be erased by a pass.
    function report(bool fail_, bytes32 evidence_) external {
        require(msg.sender == oracle && !settled && !failed, "oracle/state");
        require(block.timestamp >= startsAt && evidence_ != bytes32(0), "evidence/start");
        require(fail_ || (block.timestamp >= expiresAt && reportedAt == 0), "pass at expiry only");
        evidenceHash = evidence_;
        failed = fail_;
        reportedAt = uint64(block.timestamp);
        emit Reported(evidence_, fail_, reportedAt);
    }

    /// @notice Anyone may settle the recorded result after the dispute window.
    /// Oracle unavailable => locked, never silently converted to pass or slash.
    function settle() external {
        require(!settled && reportedAt != 0, "no result/settled");
        require(block.timestamp >= uint256(reportedAt) + disputeSeconds, "dispute window");
        settled = true;
        address payable recipient = failed ? beneficiary : promisor;
        (bool ok,) = recipient.call{value: bond}("");
        require(ok, "transfer");
        emit Settled(contractHash, evidenceHash, failed, recipient, bond);
    }
}
