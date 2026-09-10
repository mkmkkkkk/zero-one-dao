// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryLedger} from "./TreasuryLedger.sol";
import {ProposalBase} from "./ProposalBase.sol";

/// @notice Payment template (DESIGN.md §7.1): on start(), transfer the listed amounts of settlement
/// to the listed addresses, once; anything left over goes back to the Safe; then Complete.
/// @dev params = abi.encode(address[] recipients, uint256[] amounts); budget = sum(amounts).
/// The proposer has no operational role: the Safe funds and starts, the contract pays and ends.
contract PaymentProposal is ProposalBase {
    address[] private _recipients;
    uint256[] private _amounts;

    error LengthMismatch(uint256 recipients, uint256 amounts);
    error NoRecipients();
    error ZeroAmount(uint256 index);

    event Paid(address indexed recipient, uint256 amount);

    /// @param safe_ The treasury Safe.
    /// @param settlement_ The settlement ERC-20.
    /// @param operator_ The proposer (recorded; no role).
    /// @param recipients Payees.
    /// @param amounts Settlement units per payee (same length).
    constructor(address safe_, address settlement_, address operator_, TreasuryLedger ledger_, address[] memory recipients, uint256[] memory amounts)
        ProposalBase(safe_, settlement_, operator_, ledger_)
    {
        _set(recipients, amounts);
    }

    /// @inheritdoc ProposalBase
    function template() public pure override returns (string memory) {
        return "Payment";
    }

    /// @notice The payment list.
    function payments() external view returns (address[] memory recipients, uint256[] memory amounts) {
        return (_recipients, _amounts);
    }

    /// @dev Pay every recipient once, return the rest, end.
    function _start() internal override {
        uint256 balance = held();
        if (balance < budget) revert Underfunded(budget, balance);
        for (uint256 i; i < _recipients.length; ++i) {
            _transfer(_recipients[i], _amounts[i]);
            emit Paid(_recipients[i], _amounts[i]);
        }
        _complete();
    }

    /// @dev Only meaningful before start: the topped-up amount joins what start() checks and returns.
    function _topUp(uint256 amount) internal override {
        _requireStatus(Status.Pending);
        budget += amount;
    }

    /// @dev Replace the payment list before start.
    function _amend(bytes calldata params) internal override {
        _requireStatus(Status.Pending);
        (address[] memory recipients, uint256[] memory amounts) = abi.decode(params, (address[], uint256[]));
        delete _recipients;
        delete _amounts;
        _set(recipients, amounts);
    }

    function _set(address[] memory recipients, uint256[] memory amounts) private {
        if (recipients.length != amounts.length) revert LengthMismatch(recipients.length, amounts.length);
        if (recipients.length == 0) revert NoRecipients();
        uint256 total;
        for (uint256 i; i < recipients.length; ++i) {
            if (recipients[i] == address(0)) revert ZeroAddress();
            if (amounts[i] == 0) revert ZeroAmount(i);
            _recipients.push(recipients[i]);
            _amounts.push(amounts[i]);
            total += amounts[i];
        }
        budget = total;
        paramsHash = keccak256(abi.encode(recipients, amounts));
    }
}
