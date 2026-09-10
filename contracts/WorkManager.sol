// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBaalV3, INavShareToken} from "./Interfaces.sol";

/// @notice Task lifecycle: propose (Baal proposal) -> activate (executed by the Safe) -> claim ->
/// deliver -> verifier confirmations -> exactly `rewardShares` minted to the deliverer.
/// @dev Derived from agent-only-wallet/exit AowWorkManager, re-based on Baal-native governance.
/// The reward is denominated in SHARES, fixed at submitTask and voted on as part of the proposal;
/// NAV and the settlement asset play no role, so tasks work at zero treasury (DESIGN.md §5).
/// Kept: verifier != proposer (enforced here, the proposer is msg.sender of submitTask), verifiers
/// cannot claim, evidence-hash commit/confirm, threshold of named verifiers. Dropped: governor hooks,
/// tranches, timelocks, sortition, NAV conversion. Baal manager shaman; mints only after verification.
/// Phase 5: the rewards of Active tasks are a share liability that DepositShaman prices into deposits
/// (`activeRewardShares`); `expiration` (the Baal proposal expiration, 0 = none) is also the task's
/// expiration: confirm() reverts after it and anyone may `expireTask` (ruling 4c, W-1). A claim that has
/// not delivered within CLAIM_TIMEOUT can be taken over by another claim (ruling 10, W-2). The activation
/// proposal is submitted with baalGas = ACTIVATION_BAAL_GAS (the activation action's need x 1.5 with margin;
/// ruling 1) so a low-gas processProposal reverts instead of killing the passed proposal.
contract WorkManager {
    enum Status {
        None,
        Proposed,
        Active,
        Complete,
        Cancelled,
        Expired
    }

    struct Task {
        address proposer;
        address worker;
        uint256 rewardShares;
        uint16 verifierThreshold;
        uint16 confirmations;
        uint32 round;
        uint32 proposalId;
        Status status;
        bytes32 evidenceHash;
        uint32 expiration;
        uint64 claimedAt;
    }

    /// @notice Seconds a claim may sit without a delivery before anyone else may claim the task.
    uint256 public constant CLAIM_TIMEOUT = 7 days;
    /// @notice baalGas of every activation proposal (Baal refuses processing with less gas available).
    uint256 public constant ACTIVATION_BAAL_GAS = 500_000;

    IBaalV3 public immutable baal;
    address public immutable safe;
    INavShareToken public immutable shares;

    uint256 public taskCount;
    mapping(uint256 taskId => Task) private _tasks;
    mapping(uint256 taskId => address[]) private _verifiers;
    uint256[] private _activeTasks;
    mapping(uint256 taskId => uint256) private _activeIndexPlusOne;
    mapping(uint256 taskId => mapping(address verifier => bool)) public isVerifier;
    mapping(uint256 taskId => mapping(uint32 round => mapping(address verifier => bool))) public confirmedBy;

    uint256 private _entered = 1;

    error Reentrancy();
    error ZeroAddress();
    error OnlySafe(address caller);
    error NoVerifiers();
    error VerifierIsProposer(address verifier);
    error DuplicateVerifier(address verifier);
    error InvalidThreshold(uint16 threshold, uint256 verifierCount);
    error ZeroReward();
    error UnknownTask(uint256 taskId);
    error WrongStatus(uint256 taskId, Status expected, Status observed);
    error TaskAlreadyClaimed(uint256 taskId, address worker);
    error VerifierCannotClaim(uint256 taskId, address verifier);
    error OnlyWorker(uint256 taskId, address caller);
    error OnlyVerifier(uint256 taskId, address caller);
    error EmptyEvidenceHash();
    error EvidenceHashMismatch(bytes32 expected, bytes32 observed);
    error VerifierAlreadyConfirmed(uint256 taskId, uint32 round, address verifier);
    error NothingDelivered(uint256 taskId);
    error TaskExpired(uint256 taskId, uint32 expiration);
    error TaskNotExpired(uint256 taskId, uint32 expiration);

    event TaskProposed(
        uint256 indexed taskId,
        uint256 indexed proposalId,
        address indexed proposer,
        address[] verifiers,
        uint16 verifierThreshold,
        uint256 rewardShares
    );
    event TaskActivated(uint256 indexed taskId);
    event TaskCancelled(uint256 indexed taskId);
    event TaskExpiredEvent(uint256 indexed taskId, uint32 expiration);
    event TaskClaimed(uint256 indexed taskId, address indexed worker);
    event ClaimLapsed(uint256 indexed taskId, address indexed previousWorker, address indexed worker);
    event DeliveryCommitted(uint256 indexed taskId, uint32 indexed round, address indexed worker, bytes32 evidenceHash);
    event DeliveryConfirmed(uint256 indexed taskId, uint32 indexed round, address indexed verifier, uint16 confirmations);
    event TaskVerified(uint256 indexed taskId, address indexed worker, uint256 rewardShares);

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

    constructor(IBaalV3 baal_, INavShareToken shares_) {
        if (address(baal_) == address(0) || address(shares_) == address(0)) revert ZeroAddress();
        baal = baal_;
        shares = shares_;
        safe = shares_.safe();
        if (safe == address(0)) revert ZeroAddress();
    }

    /// @notice Record a task and submit the Baal proposal that, if it passes, activates it.
    /// @dev msg.sender is the proposer. A verifier equal to the proposer is rejected here, the only
    /// entry point, so no task can exist with verifier == proposer. Any proposal offering is forwarded.
    /// @param verifiers Named verifiers (distinct, non-zero, none equal to the proposer).
    /// @param verifierThreshold Confirmations required (1..verifiers.length).
    /// @param rewardShares Reward in shares (18 decimals), minted exactly as stated on final confirmation.
    /// @param expiration Baal proposal expiration and task expiration (0 = none: the liability stays until
    /// the task is confirmed or cancelled by vote).
    /// @param details Proposal text.
    /// @return taskId Task identifier in this manager.
    /// @return proposalId Baal proposal id that activates the task.
    function submitTask(
        address[] calldata verifiers,
        uint16 verifierThreshold,
        uint256 rewardShares,
        uint32 expiration,
        string calldata details
    ) external payable nonReentrant returns (uint256 taskId, uint256 proposalId) {
        if (verifiers.length == 0) revert NoVerifiers();
        if (verifierThreshold == 0 || verifierThreshold > verifiers.length) {
            revert InvalidThreshold(verifierThreshold, verifiers.length);
        }
        if (rewardShares == 0) revert ZeroReward();

        taskId = ++taskCount;
        for (uint256 i; i < verifiers.length; ++i) {
            address verifier = verifiers[i];
            if (verifier == address(0)) revert ZeroAddress();
            if (verifier == msg.sender) revert VerifierIsProposer(verifier);
            if (isVerifier[taskId][verifier]) revert DuplicateVerifier(verifier);
            isVerifier[taskId][verifier] = true;
            _verifiers[taskId].push(verifier);
        }

        proposalId = baal.submitProposal{value: msg.value}(activationData(taskId), expiration, ACTIVATION_BAAL_GAS, details);
        _tasks[taskId] = Task({
            proposer: msg.sender,
            worker: address(0),
            rewardShares: rewardShares,
            verifierThreshold: verifierThreshold,
            confirmations: 0,
            round: 0,
            proposalId: uint32(proposalId),
            status: Status.Proposed,
            evidenceHash: bytes32(0),
            expiration: expiration,
            claimedAt: 0
        });
        emit TaskProposed(taskId, proposalId, msg.sender, verifiers, verifierThreshold, rewardShares);
    }

    /// @notice Baal proposal data that activates `taskId`; pass it to Baal.processProposal.
    function activationData(uint256 taskId) public view returns (bytes memory) {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(this.activateTask.selector, taskId);
        return baal.encodeMultisend(calls, address(this));
    }

    /// @notice Executed by the Safe when the task proposal passes.
    /// @dev An activation processed after the task's expiration reverts (the whole action fails and the
    /// task stays Proposed): an expired task never enters the liability.
    function activateTask(uint256 taskId) external onlySafe {
        Task storage task = _task(taskId);
        _require(taskId, task, Status.Proposed);
        if (_expired(task)) revert TaskExpired(taskId, task.expiration);
        task.status = Status.Active;
        _activeTasks.push(taskId);
        _activeIndexPlusOne[taskId] = _activeTasks.length;
        emit TaskActivated(taskId);
    }

    /// @notice Executed by the Safe when a proposal to cancel the task passes.
    function cancelTask(uint256 taskId) external onlySafe {
        Task storage task = _task(taskId);
        if (task.status != Status.Proposed && task.status != Status.Active) {
            revert WrongStatus(taskId, Status.Active, task.status);
        }
        if (task.status == Status.Active) _removeActive(taskId);
        task.status = Status.Cancelled;
        emit TaskCancelled(taskId);
    }

    /// @notice Anyone: close an Active task whose expiration has passed (its reward can no longer mint).
    function expireTask(uint256 taskId) external {
        Task storage task = _task(taskId);
        _require(taskId, task, Status.Active);
        if (!_expired(task)) revert TaskNotExpired(taskId, task.expiration);
        _removeActive(taskId);
        task.status = Status.Expired;
        emit TaskExpiredEvent(taskId, task.expiration);
    }

    /// @notice Claim an active task. Verifiers of the task cannot claim it. A claim that has delivered
    /// nothing for CLAIM_TIMEOUT lapses: the next claimant takes the task over.
    function claim(uint256 taskId) external nonReentrant {
        Task storage task = _task(taskId);
        _require(taskId, task, Status.Active);
        if (_expired(task)) revert TaskExpired(taskId, task.expiration);
        if (isVerifier[taskId][msg.sender]) revert VerifierCannotClaim(taskId, msg.sender);
        address previous = task.worker;
        if (previous != address(0)) {
            if (!claimLapsed(taskId)) revert TaskAlreadyClaimed(taskId, previous);
            emit ClaimLapsed(taskId, previous, msg.sender);
        }
        task.worker = msg.sender;
        task.claimedAt = uint64(block.timestamp);
        emit TaskClaimed(taskId, msg.sender);
    }

    /// @notice True when the current claim has delivered nothing and CLAIM_TIMEOUT has passed since it.
    function claimLapsed(uint256 taskId) public view returns (bool) {
        Task storage task = _tasks[taskId];
        return task.worker != address(0) && task.evidenceHash == bytes32(0) && block.timestamp > uint256(task.claimedAt) + CLAIM_TIMEOUT;
    }

    /// @notice Sum of rewardShares of every Active task whose expiration has not passed: the shares the
    /// members already voted away but that are not minted yet (DepositShaman prices them into deposits).
    function activeRewardShares() external view returns (uint256 total) {
        for (uint256 i; i < _activeTasks.length; ++i) {
            Task storage task = _tasks[_activeTasks[i]];
            if (!_expired(task)) total += task.rewardShares;
        }
    }

    /// @notice Ids of every task currently Active (expired ones included until `expireTask`).
    function activeTasks() external view returns (uint256[] memory) {
        return _activeTasks;
    }

    /// @notice Commit a delivery evidence hash. Re-delivery opens a new confirmation round.
    function deliver(uint256 taskId, bytes32 evidenceHash) external nonReentrant {
        Task storage task = _task(taskId);
        _require(taskId, task, Status.Active);
        if (task.worker != msg.sender) revert OnlyWorker(taskId, msg.sender);
        if (evidenceHash == bytes32(0)) revert EmptyEvidenceHash();
        task.round += 1;
        task.confirmations = 0;
        task.evidenceHash = evidenceHash;
        emit DeliveryCommitted(taskId, task.round, msg.sender, evidenceHash);
    }

    /// @notice Confirm the current delivery; at threshold, mint exactly `rewardShares` to the worker.
    /// @dev Reverts after the task's expiration: the liability expires with the task.
    function confirm(uint256 taskId, bytes calldata evidence) external nonReentrant {
        Task storage task = _task(taskId);
        _require(taskId, task, Status.Active);
        if (_expired(task)) revert TaskExpired(taskId, task.expiration);
        if (!isVerifier[taskId][msg.sender]) revert OnlyVerifier(taskId, msg.sender);
        if (task.evidenceHash == bytes32(0)) revert NothingDelivered(taskId);
        bytes32 observed = keccak256(evidence);
        if (observed != task.evidenceHash) revert EvidenceHashMismatch(task.evidenceHash, observed);
        uint32 round = task.round;
        if (confirmedBy[taskId][round][msg.sender]) revert VerifierAlreadyConfirmed(taskId, round, msg.sender);
        confirmedBy[taskId][round][msg.sender] = true;
        uint16 count = task.confirmations + 1;
        task.confirmations = count;
        emit DeliveryConfirmed(taskId, round, msg.sender, count);

        if (count == task.verifierThreshold) {
            _removeActive(taskId);
            task.status = Status.Complete;
            address[] memory to = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            to[0] = task.worker;
            amounts[0] = task.rewardShares;
            baal.mintShares(to, amounts);
            emit TaskVerified(taskId, task.worker, task.rewardShares);
        }
    }

    function getTask(uint256 taskId) external view returns (Task memory) {
        return _tasks[taskId];
    }

    function verifiersOf(uint256 taskId) external view returns (address[] memory) {
        return _verifiers[taskId];
    }

    function _task(uint256 taskId) internal view returns (Task storage task) {
        task = _tasks[taskId];
        if (task.status == Status.None) revert UnknownTask(taskId);
    }

    function _require(uint256 taskId, Task storage task, Status expected) internal view {
        if (task.status != expected) revert WrongStatus(taskId, expected, task.status);
    }

    /// @dev True when the task carries an expiration that has passed.
    function _expired(Task storage task) internal view returns (bool) {
        return task.expiration != 0 && block.timestamp > task.expiration;
    }

    /// @dev Remove `taskId` from the active set (swap-and-pop).
    function _removeActive(uint256 taskId) internal {
        uint256 index = _activeIndexPlusOne[taskId];
        if (index == 0) return;
        uint256 last = _activeTasks[_activeTasks.length - 1];
        _activeTasks[index - 1] = last;
        _activeIndexPlusOne[last] = index;
        _activeTasks.pop();
        delete _activeIndexPlusOne[taskId];
    }
}
