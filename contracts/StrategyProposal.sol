// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "./Interfaces.sol";
import {ProposalBase} from "./ProposalBase.sol";

/// @notice Minimal venue surface a Strategy trades on (the mirror's MockDex implements it).
interface IStrategyVenue {
    function price() external view returns (uint256);
    function assetUnit() external view returns (uint256);
    function buy(uint256 settlementIn, uint256 slippageBps) external returns (uint256 assetOut);
    function sell(uint256 assetIn, uint256 slippageBps) external returns (uint256 settlementOut);
}

/// @notice Strategy template (DESIGN.md §7.2): holds a settlement budget and trades it against one
/// asset on one venue by a coded rule. `run()` is callable by anyone (no keeper can hold it hostage).
/// @dev The coded rule, evaluated per run():
///   1. deadline reached -> unwind (sell all asset) and return every settlement unit to the Safe; Complete.
///   2. otherwise at most one run per `minInterval` seconds;
///   3. value = settlement held + asset held x venue price; if takeProfitBps != 0 and
///      value >= budget x (1 + takeProfit) or stopLossBps != 0 and value <= budget x (1 - stopLoss)
///      -> unwind, return, Complete;
///   4. otherwise buy the asset with min(maxPerRun, settlement held) settlement units.
/// stop() and migrate(newContract) (Safe only) move the raw holdings (every settlement unit and every
/// asset unit) to the Safe / the new contract WITHOUT calling the venue, so a dead venue can never trap
/// funds (DESIGN.md §7; decision.md phase 2a ruling 2). Unwinding on the venue is run()'s job before the
/// deadline. params = abi.encode(address venue, address asset, uint256 budget, Rule rule);
/// amend(params) replaces the Rule only (venue, asset and budget do not change by amend).
contract StrategyProposal is ProposalBase {
    struct Rule {
        uint256 maxPerRun;
        uint256 minInterval;
        uint256 deadline;
        uint256 takeProfitBps;
        uint256 stopLossBps;
        uint256 slippageBps;
    }

    uint256 public constant PRICE_UNIT = 1e6;
    uint256 public constant BPS = 10_000;

    IStrategyVenue public immutable venue;
    IERC20Minimal public immutable asset;

    Rule public rule;
    uint256 public lastRun;
    uint256 public runs;

    error ZeroBudget();
    error ZeroMaxPerRun();
    error DeadlinePassed(uint256 deadline, uint256 nowTs);
    error BadBps(uint256 bps);
    error TooSoon(uint256 nextRunAt);
    error NothingToDo();
    error ApproveFailed();

    event Ran(uint256 indexed run, uint256 valueBefore, uint256 bought, uint256 assetOut);
    event Unwound(uint256 assetIn, uint256 settlementOut, string reason);
    event Moved(address indexed to, uint256 settlementMoved, uint256 assetMoved, string reason);

    /// @param safe_ The treasury Safe.
    /// @param settlement_ The settlement ERC-20.
    /// @param operator_ The proposer (leads by default; has no special power).
    /// @param venue_ The venue (mirror: MockDex).
    /// @param asset_ The traded asset.
    /// @param budget_ Settlement units the Safe funds on start.
    /// @param rule_ The coded rule's parameters.
    constructor(
        address safe_,
        address settlement_,
        address operator_,
        address venue_,
        address asset_,
        uint256 budget_,
        Rule memory rule_
    ) ProposalBase(safe_, settlement_, operator_) {
        if (venue_ == address(0) || asset_ == address(0)) revert ZeroAddress();
        if (budget_ == 0) revert ZeroBudget();
        venue = IStrategyVenue(venue_);
        asset = IERC20Minimal(asset_);
        budget = budget_;
        _setRule(rule_);
        paramsHash = keccak256(abi.encode(venue_, asset_, budget_, rule_));
    }

    /// @inheritdoc ProposalBase
    function template() public pure override returns (string memory) {
        return "Strategy";
    }

    /// @notice Settlement held + asset held valued at the venue price.
    function value() public view returns (uint256) {
        return held() + (asset.balanceOf(address(this)) * venue.price()) / venue.assetUnit();
    }

    /// @notice Execute one step of the coded rule; anyone may call.
    function run() external nonReentrant {
        _requireStatus(Status.Running);
        if (block.timestamp >= rule.deadline) {
            _unwind("deadline");
            _complete();
            return;
        }
        uint256 nextRunAt = lastRun + rule.minInterval;
        if (runs != 0 && block.timestamp < nextRunAt) revert TooSoon(nextRunAt);
        lastRun = block.timestamp;
        runs += 1;

        uint256 valueBefore = value();
        if (rule.takeProfitBps != 0 && valueBefore >= (budget * (BPS + rule.takeProfitBps)) / BPS) {
            _unwind("take-profit");
            _complete();
            return;
        }
        if (rule.stopLossBps != 0 && valueBefore <= (budget * (BPS - rule.stopLossBps)) / BPS) {
            _unwind("stop-loss");
            _complete();
            return;
        }

        uint256 balance = held();
        uint256 size = balance < rule.maxPerRun ? balance : rule.maxPerRun;
        if (size == 0) revert NothingToDo();
        if (!settlement.approve(address(venue), size)) revert ApproveFailed();
        uint256 assetOut = venue.buy(size, rule.slippageBps);
        emit Ran(runs, valueBefore, size, assetOut);
    }

    /// @dev Funding check only; the rule runs through run(). A migrated position arrives as raw
    /// holdings (settlement plus asset), so the settlement-only check applies when no asset is held;
    /// valuing the asset here would call the venue, which stop()/migrate() must never depend on.
    function _start() internal view override {
        uint256 balance = held();
        if (balance < budget && asset.balanceOf(address(this)) == 0) revert Underfunded(budget, balance);
    }

    /// @dev Replace the rule; venue, asset and budget stay.
    function _amend(bytes calldata params) internal override {
        Rule memory next = abi.decode(params, (Rule));
        _setRule(next);
        paramsHash = keccak256(abi.encode(address(venue), address(asset), budget, next));
    }

    /// @dev Move the raw holdings (settlement + asset) to the Safe; the venue is not called.
    function _stop() internal override returns (uint256 returned) {
        return _moveHoldings(safe, "stop");
    }

    /// @dev Move the raw holdings (settlement + asset) to the new voted contract; the venue is not called.
    function _migrate(address newContract) internal override returns (uint256 moved) {
        return _moveHoldings(newContract, "migrate");
    }

    /// @dev Transfer every settlement unit and every asset unit held to `to` without touching the venue.
    /// @return settlementMoved Settlement units transferred (the asset amount is in the Moved event).
    function _moveHoldings(address to, string memory reason) private returns (uint256 settlementMoved) {
        settlementMoved = _returnSettlement(to);
        uint256 assetBalance = asset.balanceOf(address(this));
        if (assetBalance != 0 && !asset.transfer(to, assetBalance)) revert TransferFailed();
        emit Moved(to, settlementMoved, assetBalance, reason);
    }

    function _setRule(Rule memory next) private {
        if (next.maxPerRun == 0) revert ZeroMaxPerRun();
        if (next.deadline <= block.timestamp) revert DeadlinePassed(next.deadline, block.timestamp);
        if (next.takeProfitBps > BPS * 100) revert BadBps(next.takeProfitBps);
        if (next.slippageBps > BPS) revert BadBps(next.slippageBps);
        if (next.stopLossBps >= BPS) revert BadBps(next.stopLossBps);
        rule = next;
        deadline = next.deadline;
    }

    /// @dev Sell every asset unit held back into settlement.
    function _unwind(string memory reason) private {
        uint256 assetBalance = asset.balanceOf(address(this));
        if (assetBalance == 0) return;
        if (!asset.approve(address(venue), assetBalance)) revert ApproveFailed();
        uint256 settlementOut = venue.sell(assetBalance, rule.slippageBps);
        emit Unwound(assetBalance, settlementOut, reason);
    }
}
