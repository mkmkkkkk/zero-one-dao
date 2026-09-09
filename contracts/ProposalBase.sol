// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryLedger} from "./TreasuryLedger.sol";
import {IERC20Minimal} from "./Interfaces.sol";
import {IProposalContract} from "./IProposalContract.sol";

/// @notice Shared skeleton of the proposal templates: Safe ownership, status, budget, settlement
/// accounting and the default stop / migrate behaviour (return or move the settlement balance).
/// @dev Templates override the `_start / _topUp / _amend / _stop / _migrate` hooks. Every external
/// state-changing entry point except the template's own operational functions is `onlySafe`, so
/// only a passed proposal (executed by the Safe through Baal) can call it (DESIGN.md §7).
abstract contract ProposalBase is IProposalContract {
    TreasuryLedger public immutable ledger;
    address public immutable safe;
    IERC20Minimal public immutable settlement;
    address public immutable operator;

    Status public status;
    uint256 public budget;
    uint256 public deadline;
    bytes32 public paramsHash;

    uint256 private _entered = 1;

    error Reentrancy();
    error ZeroAddress();
    error OnlySafe(address caller);
    error WrongStatus(Status observed);
    error TransferFailed();
    error Underfunded(uint256 required, uint256 held);
    error NotAContract(address target);

    event Started(uint256 budget);
    event ToppedUp(uint256 amount, uint256 budget);
    event Amended(bytes32 paramsHash);
    event Stopped(uint256 returned);
    event Migrated(address indexed newContract, uint256 moved);
    event Completed(uint256 returned);

    modifier nonReentrant() {
        if (_entered != 1) revert Reentrancy();
        _entered = 2;
        _;
        _entered = 1;
    }

    modifier onlySafe() {
        if (msg.sender != safe) revert OnlySafe(msg.sender);
        _;
    }

    /// @param safe_ The treasury Safe (owner of every proposal contract).
    /// @param settlement_ The settlement ERC-20 (USDC).
    /// @param operator_ The address that leads execution (the proposer by default).
    constructor(address safe_, address settlement_, address operator_, TreasuryLedger ledger_) {
        if (safe_ == address(0) || settlement_ == address(0) || operator_ == address(0)) revert ZeroAddress();
        ledger = ledger_;
        safe = safe_;
        settlement = IERC20Minimal(settlement_);
        operator = operator_;
    }

    /// @notice Non-settlement asset registered when voted into the active set.
    function ledgerAsset() external view virtual returns (address) { return address(0); }

    /// @notice Template name; overridden by each template.
    function template() public pure virtual returns (string memory);

    /// @inheritdoc IProposalContract
    function describe()
        external
        view
        returns (string memory template_, bytes32 paramsHash_, address operator_, uint256 budget_, uint256 deadline_, Status status_)
    {
        return (template(), paramsHash, operator, budget, deadline, status);
    }

    /// @inheritdoc IProposalContract
    function start() external onlySafe nonReentrant {
        _requireStatus(Status.Pending);
        status = Status.Running;
        ledger.open();
        _start();
        emit Started(budget);
    }

    /// @inheritdoc IProposalContract
    function topUp(uint256 amount) external onlySafe nonReentrant {
        _requireLive();
        _topUp(amount);
        emit ToppedUp(amount, budget);
    }

    /// @inheritdoc IProposalContract
    function amend(bytes calldata params) external onlySafe nonReentrant {
        _requireLive();
        _amend(params);
        emit Amended(paramsHash);
    }

    /// @inheritdoc IProposalContract
    function stop() external onlySafe nonReentrant {
        _requireLive();
        status = Status.Stopped;
        uint256 returned = _stop();
        ledger.close();
        emit Stopped(returned);
    }

    /// @inheritdoc IProposalContract
    function migrate(address newContract) external onlySafe nonReentrant {
        _requireLive();
        if (newContract == address(0)) revert ZeroAddress();
        if (newContract.code.length == 0) revert NotAContract(newContract);
        status = Status.Migrated;
        uint256 moved = _migrate(newContract);
        ledger.close();
        emit Migrated(newContract, moved);
    }

    /// @notice Settlement currently held by this contract.
    function held() public view returns (uint256) {
        return settlement.balanceOf(address(this));
    }

    /// @dev Template hook: called once when the Safe starts the contract (status already Running).
    function _start() internal virtual;

    /// @dev Template hook: the Safe has transferred `amount` more settlement; default records it.
    function _topUp(uint256 amount) internal virtual {
        budget += amount;
    }

    /// @dev Template hook: replace parameters with the voted `params` and update `paramsHash`.
    function _amend(bytes calldata params) internal virtual;

    /// @dev Template hook: return everything to the Safe (status already Stopped); default returns settlement.
    function _stop() internal virtual returns (uint256 returned) {
        return _returnSettlement(safe);
    }

    /// @dev Template hook: move everything to `newContract` (status already Migrated); default moves settlement.
    function _migrate(address newContract) internal virtual returns (uint256 moved) {
        return _returnSettlement(newContract);
    }

    /// @dev Mark Complete and return whatever settlement is left to the Safe.
    function _complete() internal {
        status = Status.Complete;
        uint256 returned = _returnSettlement(safe);
        ledger.close();
        emit Completed(returned);
    }

    /// @dev Transfer the whole settlement balance to `to`; returns the amount moved.
    function _returnSettlement(address to) internal returns (uint256 amount) {
        amount = settlement.balanceOf(address(this));
        if (amount != 0) _transfer(to, amount);
    }

    /// @dev ERC-20 transfer that reverts on a false return.
    function _transfer(address to, uint256 amount) internal {
        if (!settlement.transfer(to, amount)) revert TransferFailed();
    }

    /// @dev Revert unless `status == expected`.
    function _requireStatus(Status expected) internal view {
        if (status != expected) revert WrongStatus(status);
    }

    /// @dev Revert unless the contract is Pending or Running (i.e. can still be governed).
    function _requireLive() internal view {
        if (status != Status.Pending && status != Status.Running) revert WrongStatus(status);
    }
}
