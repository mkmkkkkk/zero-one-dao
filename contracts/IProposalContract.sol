// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The common surface of every Zero One proposal contract (DESIGN.md §7).
/// @dev A proposal contract is deployed by the proposer, funded and started by the Safe when the Baal
/// proposal passes (the voted multicall is `settlement.transfer(instance, budget)` + `start()`), and
/// owned by the Safe afterwards: topUp / amend / stop / migrate are callable only by the Safe, i.e.
/// only by a later passed proposal. The proposer holds only the operational role its template defines.
interface IProposalContract {
    /// @notice Lifecycle of a proposal contract.
    /// Pending: deployed, not yet started (a failed vote leaves it here forever, holding nothing).
    /// Running: funded and started. Complete: finished by its own rules; everything returned to the Safe.
    /// Stopped: stopped by a passed proposal; everything returned to the Safe.
    /// Migrated: funds moved to a new voted contract by a passed proposal.
    enum Status {
        Pending,
        Running,
        Complete,
        Stopped,
        Migrated
    }

    /// @notice Template name, hash of the voted parameters, operator, budget, deadline and status.
    /// @return template Template name ("Payment", "Strategy", "Project", "Config").
    /// @return paramsHash keccak256(abi.encode(params)) of the latest voted parameters.
    /// @return operator The address that leads execution (the proposer by default).
    /// @return budget Settlement units the treasury has committed to this contract (funding + topUps).
    /// @return deadline Unix time after which the contract ends by itself (0 = none).
    /// @return status Current lifecycle status.
    function describe()
        external
        view
        returns (string memory template, bytes32 paramsHash, address operator, uint256 budget, uint256 deadline, Status status);

    /// @notice Executed by the Safe in the voted multicall right after funding.
    function start() external;

    /// @notice Executed by the Safe (a later passed proposal) after transferring `amount` more settlement.
    function topUp(uint256 amount) external;

    /// @notice Executed by the Safe (a later passed proposal): replace the template's parameters.
    function amend(bytes calldata params) external;

    /// @notice Executed by the Safe (a later passed proposal): return everything to the Safe and end.
    function stop() external;

    /// @notice Executed by the Safe (a later passed proposal): move everything to `newContract`.
    function migrate(address newContract) external;
}
