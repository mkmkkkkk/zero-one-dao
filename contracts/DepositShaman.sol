// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBaalV3, IERC20Minimal, INavShareToken} from "./Interfaces.sol";

/// @notice Deposit the settlement asset into the treasury Safe and receive shares at current NAV.
/// @dev Baal manager shaman. Open to any address: phase-1 "agents only" is a constitution clause
/// enforced by votes, not by code (DESIGN.md §2). Exit is Baal.ragequit, always at NAV.
contract DepositShaman {
    IBaalV3 public immutable baal;
    address public immutable safe;
    INavShareToken public immutable shares;
    IERC20Minimal public immutable settlementToken;

    uint256 private _entered = 1;

    error Reentrancy();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroShares(uint256 amount);
    error TransferFailed();
    error InexactDeposit(uint256 expected, uint256 observed);

    event Deposited(
        address indexed depositor,
        uint256 amount,
        uint256 sharesMinted,
        uint256 treasuryValueBefore,
        uint256 supplyBefore
    );

    modifier nonReentrant() {
        if (_entered != 1) revert Reentrancy();
        _entered = 2;
        _;
        _entered = 1;
    }

    constructor(IBaalV3 baal_, INavShareToken shares_) {
        if (address(baal_) == address(0) || address(shares_) == address(0)) revert ZeroAddress();
        baal = baal_;
        shares = shares_;
        safe = shares_.safe();
        settlementToken = IERC20Minimal(shares_.settlementToken());
        if (safe == address(0) || address(settlementToken) == address(0)) revert ZeroAddress();
    }

    /// @notice Shares that `amount` of the settlement asset would mint right now.
    function quote(uint256 amount) external view returns (uint256) {
        return shares.navSharesFor(amount);
    }

    /// @notice Pull `amount` (pre-approved) from the caller into the Safe and mint shares at NAV.
    /// @return sharesMinted Shares credited to the caller.
    function deposit(uint256 amount) external nonReentrant returns (uint256 sharesMinted) {
        if (amount == 0) revert ZeroAmount();
        uint256 valueBefore = shares.treasuryValue();
        uint256 supplyBefore = shares.totalSupply();
        sharesMinted = shares.navSharesFor(amount);
        if (sharesMinted == 0) revert ZeroShares(amount);
        if (!settlementToken.transferFrom(msg.sender, safe, amount)) revert TransferFailed();
        uint256 valueAfter = shares.treasuryValue();
        if (valueAfter != valueBefore + amount) revert InexactDeposit(valueBefore + amount, valueAfter);
        address[] memory to = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        to[0] = msg.sender;
        amounts[0] = sharesMinted;
        baal.mintShares(to, amounts);
        emit Deposited(msg.sender, amount, sharesMinted, valueBefore, supplyBefore);
    }
}
