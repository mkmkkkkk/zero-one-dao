// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryLedger} from "./TreasuryLedger.sol";
import {IBaalV3, IERC20Minimal, INavShareToken} from "./Interfaces.sol";

/// @notice Deposit the settlement asset (USDC, 6 dec) into the treasury Safe and receive shares.
/// @dev shares = amount x totalShares / treasury when treasury > 0; when treasury == 0, one share
/// per one settlement unit scaled to share decimals (1 USDC -> 1e18 shares). No other fallback
/// (NavShareToken.navSharesFor). Baal manager shaman. Open to any address: phase-1 "agents only" is
/// a constitution clause enforced by votes, not by code (DESIGN.md §2). Exit is Baal.ragequit at NAV.
contract DepositShaman {
    TreasuryLedger public immutable ledger;
    IBaalV3 public immutable baal;
    address public immutable safe;
    INavShareToken public immutable shares;
    IERC20Minimal public immutable settlementToken;

    uint256 private _entered = 1;

    error TreasuryNotSettled();
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

    constructor(IBaalV3 baal_, INavShareToken shares_, TreasuryLedger ledger_) {
        if (address(baal_) == address(0) || address(shares_) == address(0)) revert ZeroAddress();
        ledger = ledger_;
        baal = baal_;
        shares = shares_;
        safe = shares_.safe();
        settlementToken = IERC20Minimal(shares_.settlementToken());
        if (safe == address(0) || address(settlementToken) == address(0)) revert ZeroAddress();
    }

    /// @notice Shares that `amount` of the settlement asset would mint right now.
    function quote(uint256 amount) external view returns (uint256) {
        if (!ledger.settled()) revert TreasuryNotSettled();
        return _quote(amount, ledger.depositTreasury(), shares.totalSupply());
    }

    function _quote(uint256 amount, uint256 treasury, uint256 supply) private pure returns (uint256) {
        return treasury == 0 ? amount * 1e18 / 1e6 : amount * supply / treasury;
    }

    /// @notice Pull `amount` (pre-approved) from the caller into the Safe and mint shares at NAV.
    /// @return sharesMinted Shares credited to the caller.
    function deposit(uint256 amount) external nonReentrant returns (uint256 sharesMinted) {
        if (amount == 0) revert ZeroAmount();
        if (!ledger.settled()) revert TreasuryNotSettled();
        uint256 valueBefore = ledger.depositTreasury();
        uint256 supplyBefore = shares.totalSupply();
        sharesMinted = _quote(amount, valueBefore, supplyBefore);
        if (sharesMinted == 0) revert ZeroShares(amount);
        if (!settlementToken.transferFrom(msg.sender, safe, amount)) revert TransferFailed();
        uint256 valueAfter = ledger.depositTreasury();
        if (valueAfter != valueBefore + amount) revert InexactDeposit(valueBefore + amount, valueAfter);
        address[] memory to = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        to[0] = msg.sender;
        amounts[0] = sharesMinted;
        baal.mintShares(to, amounts);
        emit Deposited(msg.sender, amount, sharesMinted, valueBefore, supplyBefore);
    }
}
