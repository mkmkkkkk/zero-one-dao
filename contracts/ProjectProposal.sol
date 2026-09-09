// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryLedger} from "./TreasuryLedger.sol";
import {ProposalBase} from "./ProposalBase.sol";

/// @notice Project template (DESIGN.md §7.3): a funding plan in tranches, each released to the
/// operator when its condition holds: a date, or confirmation by named verifiers (never the
/// operator). Unspent funds return to the Safe on stop(), on the deadline (end()), or when the
/// last tranche is released (Complete).
/// @dev params = abi.encode(Tranche[] tranches, uint256 deadline). Date tranches already due are
/// released inside start(), so "first tranche on vote" is releaseType Date with releaseAt 0.
/// topUp(amount) (Safe only) adds money without a schedule; amend(params) (Safe only) cancels every
/// unreleased tranche and installs the new list (released tranches are history and stay). Both are
/// normally voted in one multicall. Anything held beyond the unreleased tranches is unallocated and
/// returns with the rest. Once the deadline has come, release() and confirm() revert (`DeadlinePassed`)
/// and only end() applies, so the destination of a due-but-unreleased tranche is the Safe, never the
/// winner of a transaction race (phase 5 ruling 10, T-7); a Project whose deadline has already come
/// cannot start.
contract ProjectProposal is ProposalBase {
    enum ReleaseType {
        Date,
        Verifiers
    }

    struct Tranche {
        uint256 amount;
        ReleaseType releaseType;
        uint256 releaseAt;
        address[] verifiers;
        uint16 threshold;
    }

    struct TrancheState {
        bool released;
        bool cancelled;
        uint16 confirmations;
    }

    Tranche[] private _tranches;
    TrancheState[] private _state;
    mapping(uint256 trancheId => mapping(address verifier => bool)) public isVerifier;
    mapping(uint256 trancheId => mapping(address verifier => bool)) public confirmedBy;

    uint256 public released;

    error NoTranches();
    error ZeroAmount(uint256 index);
    error DateTrancheHasVerifiers(uint256 index);
    error NoVerifiers(uint256 index);
    error VerifierIsOperator(uint256 index, address verifier);
    error DuplicateVerifier(uint256 index, address verifier);
    error InvalidThreshold(uint256 index, uint16 threshold, uint256 verifierCount);
    error UnknownTranche(uint256 index);
    error TrancheSettled(uint256 index);
    error WrongReleaseType(uint256 index);
    error NotDue(uint256 index, uint256 releaseAt);
    error OnlyVerifier(uint256 index, address caller);
    error AlreadyConfirmed(uint256 index, address verifier);
    error NoDeadline();
    error DeadlineNotReached(uint256 deadline);
    error DeadlinePassed(uint256 deadline);
    error Overcommitted(uint256 scheduled, uint256 held);

    event TrancheAdded(uint256 indexed index, uint256 amount, ReleaseType releaseType, uint256 releaseAt, address[] verifiers, uint16 threshold);
    event TrancheCancelled(uint256 indexed index);
    event TrancheConfirmed(uint256 indexed index, address indexed verifier, uint16 confirmations);
    event TrancheReleased(uint256 indexed index, address indexed operator, uint256 amount);

    /// @param safe_ The treasury Safe.
    /// @param settlement_ The settlement ERC-20.
    /// @param operator_ The proposer (receives tranches; can never verify).
    /// @param tranches The funding plan.
    /// @param deadline_ Unix time after which anyone may end the project (0 = none).
    constructor(address safe_, address settlement_, address operator_, TreasuryLedger ledger_, Tranche[] memory tranches, uint256 deadline_)
        ProposalBase(safe_, settlement_, operator_, ledger_)
    {
        uint256 total = _addTranches(tranches);
        budget = total;
        deadline = deadline_;
        paramsHash = keccak256(abi.encode(tranches, deadline_));
    }

    /// @inheritdoc ProposalBase
    function template() public pure override returns (string memory) {
        return "Project";
    }

    /// @notice Number of tranches ever scheduled (including released and cancelled).
    function trancheCount() external view returns (uint256) {
        return _tranches.length;
    }

    /// @notice One tranche and its state.
    function tranche(uint256 index) external view returns (Tranche memory plan, TrancheState memory state) {
        if (index >= _tranches.length) revert UnknownTranche(index);
        return (_tranches[index], _state[index]);
    }

    /// @notice Sum of tranches neither released nor cancelled.
    function unreleased() public view returns (uint256 total) {
        for (uint256 i; i < _tranches.length; ++i) {
            if (!_state[i].released && !_state[i].cancelled) total += _tranches[i].amount;
        }
    }

    /// @notice Release a Date tranche whose date has come; anyone may call.
    function release(uint256 index) external nonReentrant {
        _requireStatus(Status.Running);
        _requireBeforeDeadline();
        Tranche storage plan = _open(index);
        if (plan.releaseType != ReleaseType.Date) revert WrongReleaseType(index);
        if (block.timestamp < plan.releaseAt) revert NotDue(index, plan.releaseAt);
        _release(index);
    }

    /// @notice Confirm a Verifiers tranche; at threshold it is released to the operator.
    function confirm(uint256 index) external nonReentrant {
        _requireStatus(Status.Running);
        _requireBeforeDeadline();
        Tranche storage plan = _open(index);
        if (plan.releaseType != ReleaseType.Verifiers) revert WrongReleaseType(index);
        if (!isVerifier[index][msg.sender]) revert OnlyVerifier(index, msg.sender);
        if (confirmedBy[index][msg.sender]) revert AlreadyConfirmed(index, msg.sender);
        confirmedBy[index][msg.sender] = true;
        uint16 count = _state[index].confirmations + 1;
        _state[index].confirmations = count;
        emit TrancheConfirmed(index, msg.sender, count);
        if (count >= plan.threshold) _release(index);
    }

    /// @notice After the deadline anyone may end the project; unreleased tranches return to the Safe.
    function end() external nonReentrant {
        _requireStatus(Status.Running);
        if (deadline == 0) revert NoDeadline();
        if (block.timestamp < deadline) revert DeadlineNotReached(deadline);
        _complete();
    }

    /// @dev Funding check, then release every Date tranche already due.
    function _start() internal override {
        _requireBeforeDeadline();
        uint256 balance = held();
        if (balance < budget) revert Underfunded(budget, balance);
        for (uint256 i; i < _tranches.length && status == Status.Running; ++i) {
            TrancheState storage state = _state[i];
            if (state.released || state.cancelled) continue;
            Tranche storage plan = _tranches[i];
            if (plan.releaseType == ReleaseType.Date && block.timestamp >= plan.releaseAt) _release(i);
        }
    }

    /// @dev Record more money; it is unallocated until amend() schedules it.
    function _topUp(uint256 amount) internal override {
        budget += amount;
        uint256 balance = held();
        if (balance + released < budget) revert Underfunded(budget - released, balance);
    }

    /// @dev Cancel every unreleased tranche and install the new plan (must fit what is held).
    function _amend(bytes calldata params) internal override {
        (Tranche[] memory tranches, uint256 deadline_) = abi.decode(params, (Tranche[], uint256));
        for (uint256 i; i < _tranches.length; ++i) {
            TrancheState storage state = _state[i];
            if (state.released || state.cancelled) continue;
            state.cancelled = true;
            emit TrancheCancelled(i);
        }
        uint256 scheduled = _addTranches(tranches);
        uint256 balance = held();
        if (scheduled > balance) revert Overcommitted(scheduled, balance);
        deadline = deadline_;
        paramsHash = keccak256(params);
        if (status == Status.Running) _releaseDue();
    }

    /// @dev Release every Date tranche already due (used after amend while Running).
    function _releaseDue() private {
        for (uint256 i; i < _tranches.length && status == Status.Running; ++i) {
            TrancheState storage state = _state[i];
            if (state.released || state.cancelled) continue;
            Tranche storage plan = _tranches[i];
            if (plan.releaseType == ReleaseType.Date && block.timestamp >= plan.releaseAt) _release(i);
        }
    }

    /// @dev Pay one tranche to the operator; Complete when nothing is left to release.
    function _release(uint256 index) private {
        TrancheState storage state = _state[index];
        state.released = true;
        uint256 amount = _tranches[index].amount;
        released += amount;
        _transfer(operator, amount);
        emit TrancheReleased(index, operator, amount);
        if (unreleased() == 0) _complete();
    }

    /// @dev Validate and append tranches; returns their sum.
    function _addTranches(Tranche[] memory tranches) private returns (uint256 total) {
        if (tranches.length == 0) revert NoTranches();
        for (uint256 i; i < tranches.length; ++i) {
            Tranche memory plan = tranches[i];
            uint256 index = _tranches.length;
            if (plan.amount == 0) revert ZeroAmount(index);
            if (plan.releaseType == ReleaseType.Date) {
                if (plan.verifiers.length != 0 || plan.threshold != 0) revert DateTrancheHasVerifiers(index);
            } else {
                if (plan.verifiers.length == 0) revert NoVerifiers(index);
                if (plan.threshold == 0 || plan.threshold > plan.verifiers.length) {
                    revert InvalidThreshold(index, plan.threshold, plan.verifiers.length);
                }
            }
            Tranche storage stored = _tranches.push();
            stored.amount = plan.amount;
            stored.releaseType = plan.releaseType;
            stored.releaseAt = plan.releaseAt;
            stored.threshold = plan.threshold;
            for (uint256 j; j < plan.verifiers.length; ++j) {
                address verifier = plan.verifiers[j];
                if (verifier == address(0)) revert ZeroAddress();
                if (verifier == operator) revert VerifierIsOperator(index, verifier);
                if (isVerifier[index][verifier]) revert DuplicateVerifier(index, verifier);
                isVerifier[index][verifier] = true;
                stored.verifiers.push(verifier);
            }
            _state.push(TrancheState({released: false, cancelled: false, confirmations: 0}));
            total += plan.amount;
            emit TrancheAdded(index, plan.amount, plan.releaseType, plan.releaseAt, plan.verifiers, plan.threshold);
        }
    }

    /// @dev Revert once the deadline (when set) has come: after it only end() applies.
    function _requireBeforeDeadline() private view {
        if (deadline != 0 && block.timestamp >= deadline) revert DeadlinePassed(deadline);
    }

    /// @dev The tranche at `index`, which must exist and be neither released nor cancelled.
    function _open(uint256 index) private view returns (Tranche storage plan) {
        if (index >= _tranches.length) revert UnknownTranche(index);
        TrancheState storage state = _state[index];
        if (state.released || state.cancelled) revert TrancheSettled(index);
        return _tranches[index];
    }
}
