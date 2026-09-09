// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Audit-only helper: a contract member that executes an ordered list of calls in ONE
/// transaction (deposit, submitVote, ragequit, processProposal, submitProposal ...). It stands in
/// for an attacker EOA that uses a flash loan or a batching contract. Anyone may call run(); it
/// exists only under evidence/audit and is never deployed anywhere but a local anvil.
contract AuditMulticall {
    error CallFailed(uint256 index, bytes data);

    /// @notice Execute `data[i]` against `to[i]` in order; bubble up the first revert.
    /// @param to Targets.
    /// @param data Calldata per target.
    function run(address[] calldata to, bytes[] calldata data) external {
        for (uint256 i; i < to.length; ++i) {
            (bool ok, bytes memory ret) = to[i].call(data[i]);
            if (!ok) revert CallFailed(i, ret);
        }
    }
}
