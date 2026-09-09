// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryLedger} from "./TreasuryLedger.sol";
import {IBaalV3, IERC20Minimal, INavShareToken, IWorkManager} from "./Interfaces.sol";

/// @notice Deposit the settlement asset (USDC, 6 dec) into the treasury Safe and receive shares.
/// @dev shares = amount x (totalShares + liability) / depositTreasury, where depositTreasury = Safe USDC +
/// USDC held by open instances (TreasuryLedger) and liability = Σ rewardShares of Active, unexpired
/// tasks (WorkManager.activeRewardShares: shares the members already voted away but not yet minted;
/// phase 5 ruling 4c). While totalShares == 0 (genesis, or after every share exited) one settlement unit
/// mints one share scaled to share decimals (1 USDC -> 1e18 shares) regardless of the treasury (phase 5
/// ruling 8: pre-existing dust is a gift to the first depositor, never a trap). Deposits are refused
/// (`TreasuryNotSettled`) while an open instance holds its registered asset. Baal manager shaman. Open to
/// any address: phase-1 "agents only" is a constitution clause enforced by votes, not by code
/// (DESIGN.md §2). Exit is Baal.ragequit at NAV.
contract DepositShaman {
    TreasuryLedger public immutable ledger;
    IBaalV3 public immutable baal;
    address public immutable safe;
    INavShareToken public immutable shares;
    IERC20Minimal public immutable settlementToken;
    IWorkManager public immutable workManager;

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

    /// @param baal_ The DAO's Baal (mints through it as a manager shaman).
    /// @param shares_ The NavShareToken.
    /// @param ledger_ The TreasuryLedger (deposit NAV and the settled gate).
    /// @param workManager_ The WorkManager whose Active task rewards are the share liability.
    constructor(IBaalV3 baal_, INavShareToken shares_, TreasuryLedger ledger_, IWorkManager workManager_) {
        if (address(baal_) == address(0) || address(shares_) == address(0) || address(ledger_) == address(0) || address(workManager_) == address(0)) revert ZeroAddress();
        ledger = ledger_;
        baal = baal_;
        shares = shares_;
        workManager = workManager_;
        safe = shares_.safe();
        settlementToken = IERC20Minimal(shares_.settlementToken());
        if (safe == address(0) || address(settlementToken) == address(0)) revert ZeroAddress();
    }

    /// @notice Deposit NAV numerator right now (Safe USDC + USDC held by open instances).
    function depositTreasury() external view returns (uint256) {
        return ledger.depositTreasury();
    }

    /// @notice Shares already voted to Active, unexpired tasks and not yet minted (priced into deposits).
    function shareLiability() public view returns (uint256) {
        return workManager.activeRewardShares();
    }

    /// @notice Shares that `amount` of the settlement asset would mint right now.
    function quote(uint256 amount) external view returns (uint256) {
        if (!ledger.settled()) revert TreasuryNotSettled();
        return _quote(amount, ledger.depositTreasury(), shares.totalSupply(), shareLiability());
    }

    /// @dev supply == 0: 1 settlement unit -> 1e18 shares regardless of treasury; treasury == 0 with
    /// supply > 0 keeps the same unit price (the empty-treasury rule of DESIGN.md §6); otherwise NAV
    /// including the unminted task liability.
    function _quote(uint256 amount, uint256 treasury, uint256 supply, uint256 liability) private pure returns (uint256) {
        if (supply == 0 || treasury == 0) return amount * 1e18 / 1e6;
        return amount * (supply + liability) / treasury;
    }

    /// @notice Pull `amount` (pre-approved) from the caller into the Safe and mint shares at NAV.
    /// @return sharesMinted Shares credited to the caller.
    function deposit(uint256 amount) external nonReentrant returns (uint256 sharesMinted) {
        if (amount == 0) revert ZeroAmount();
        if (!ledger.settled()) revert TreasuryNotSettled();
        uint256 valueBefore = ledger.depositTreasury();
        uint256 supplyBefore = shares.totalSupply();
        sharesMinted = _quote(amount, valueBefore, supplyBefore, shareLiability());
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
