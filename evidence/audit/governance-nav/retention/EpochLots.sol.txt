// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "./Interfaces.sol";

/// @notice Non-transferable Baal voting shares priced at treasury NAV, with timestamp checkpoints.
/// @dev Derived from agent-only-wallet/exit NavShareToken. Removed on purpose: the founder vesting
/// lock (cliff, unvested gate on burn/transfer), the exit gate, the burn observer and the genesis
/// mint. Every share is minted through Baal by a shaman the DAO chose, and every share is exitable
/// through Baal.ragequit at any time. Votes equal balance (self-delegated, no delegation).
///
/// Retention accounting (phase 5 ruling 2, replaces Baal's high-water mark): Baal registers every
/// sponsored proposal here (`registerProposal`, the registration index is the proposal's "epoch"). Shares
/// are held in per-account lots stamped with the epoch they were minted in; burns consume the newest lots
/// first. `exitedSince(id)` = shares burned after the proposal's registration out of lots minted before it,
/// i.e. Σ over accounts of max(0, balance at votingStarts − balance now): a deposit made after the vote
/// opened and exited again (flash or not) never counts, a member who was in at votingStarts and left does.
/// Implemented as a Fenwick tree over epochs (one point update per lot consumed by a burn); the sum is
/// exact and costs O(log EPOCHS) on burn and on query, never a loop over accounts or proposals.
contract NavShareToken {
    using Math for uint256;

    struct Checkpoint {
        uint32 fromTimePoint;
        uint256 votes;
    }

    /// @dev Shares minted while `epoch` proposals had been registered (LIFO-consumed by burns).
    struct Lot {
        uint32 epoch;
        uint224 amount;
    }

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    address public immutable baal;
    address public immutable safe;
    IERC20Metadata public immutable settlementToken;
    /// @notice 10 ** settlement decimals; one settlement unit mints one share while the treasury is empty.
    uint256 public immutable settlementUnit;

    uint256 public totalSupply;
    uint256 public totalBurned;

    /// @notice Fenwick tree capacity over epochs: at most this many proposals can ever be registered.
    uint256 public constant MAX_EPOCHS = 1 << 24;

    /// @notice Number of proposals Baal has registered (the epoch new lots are stamped with).
    uint32 public epoch;
    /// @notice Registration index of a Baal proposal id (0 = never sponsored).
    mapping(uint256 proposalId => uint32) public registrationOf;
    /// @notice Cumulative burned shares when registration `index` happened.
    mapping(uint32 index => uint256) public burnedAtRegistration;
    /// @notice Share supply when registration `index` happened (the retention base).
    mapping(uint32 index => uint256) public supplyAtRegistration;
    /// @dev Fenwick tree: node i covers burned amounts of lots whose epoch + 1 is in (i - lowbit(i), i].
    mapping(uint256 => uint256) private _burnedByEpoch;

    mapping(address account => uint256) public balanceOf;
    mapping(address account => Checkpoint[]) private _checkpoints;
    mapping(address account => Lot[]) private _lots;

    error OnlyBaal(address caller);
    error ZeroAddress();
    error EmptyName();
    error EmptySymbol();
    error NonTransferable();
    error PermanentlyUnpaused();
    error TimePointNotDetermined(uint256 timePoint, uint256 now_);
    error InsufficientBalance(address account, uint256 available, uint256 required);
    error SupplyCapExceeded(uint256 attemptedSupply);
    error EpochsExhausted();
    error AlreadyRegistered(uint256 proposalId);
    error NotRegistered(uint256 proposalId);

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event SharesBurned(address indexed account, uint256 amount, uint256 cumulativeBurned);
    event DelegateVotesChanged(address indexed delegate, uint256 previousBalance, uint256 newBalance);
    event ProposalRegistered(uint256 indexed proposalId, uint32 indexed index, uint256 supply, uint256 burned);

    modifier onlyBaal() {
        if (msg.sender != baal) revert OnlyBaal(msg.sender);
        _;
    }

    /// @param name_ ERC-20 name.
    /// @param symbol_ ERC-20 symbol.
    /// @param baal_ The Baal module that alone may mint and burn.
    /// @param safe_ The treasury Safe whose settlement balance defines NAV.
    /// @param settlementToken_ The settlement asset used for NAV pricing.
    constructor(
        string memory name_,
        string memory symbol_,
        address baal_,
        address safe_,
        IERC20Metadata settlementToken_
    ) {
        if (bytes(name_).length == 0) revert EmptyName();
        if (bytes(symbol_).length == 0) revert EmptySymbol();
        if (baal_ == address(0) || safe_ == address(0) || address(settlementToken_) == address(0)) {
            revert ZeroAddress();
        }
        name = name_;
        symbol = symbol_;
        baal = baal_;
        safe = safe_;
        settlementToken = settlementToken_;
        settlementUnit = 10 ** uint256(settlementToken_.decimals());
    }

    // ---------------------------------------------------------------- ERC-20 (non-transferable)

    function transfer(address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    function approve(address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    function allowance(address, address) external pure returns (uint256) {
        return 0;
    }

    // ---------------------------------------------------------------- Baal token surface

    function paused() external pure returns (bool) {
        return false;
    }

    function pause() external pure {
        revert PermanentlyUnpaused();
    }

    function unpause() external pure {
        revert PermanentlyUnpaused();
    }

    /// @notice Mint shares; callable only by Baal (i.e. by a manager shaman the DAO installed).
    function mint(address recipient, uint256 amount) external onlyBaal {
        _mint(recipient, amount);
    }

    /// @notice Burn shares; callable only by Baal (ragequit path). No lock, no gate, no cliff.
    function burn(address account, uint256 amount) external onlyBaal {
        if (account == address(0)) revert ZeroAddress();
        uint256 available = balanceOf[account];
        if (available < amount) revert InsufficientBalance(account, available, amount);
        unchecked {
            balanceOf[account] = available - amount;
            totalSupply -= amount;
        }
        totalBurned += amount;
        _consumeLots(account, amount);
        _writeCheckpoint(account, available, available - amount);
        emit Transfer(account, address(0), amount);
        emit SharesBurned(account, amount, totalBurned);
    }

    // ---------------------------------------------------------------- Retention accounting (Baal)

    /// @notice Record the start of voting on `proposalId`; callable only by Baal, once per proposal.
    /// @return index The registration index (the proposal's epoch boundary).
    function registerProposal(uint256 proposalId) external onlyBaal returns (uint32 index) {
        if (registrationOf[proposalId] != 0) revert AlreadyRegistered(proposalId);
        if (epoch >= MAX_EPOCHS - 1) revert EpochsExhausted();
        index = ++epoch;
        registrationOf[proposalId] = index;
        burnedAtRegistration[index] = totalBurned;
        supplyAtRegistration[index] = totalSupply;
        emit ProposalRegistered(proposalId, index, totalSupply, totalBurned);
    }

    /// @notice Shares that existed when voting on `proposalId` started and were burned since, and the
    /// supply at that moment. Shares minted after the registration never count, whoever burns them.
    /// @return exited Burned shares out of lots minted before the registration (burns after it only).
    /// @return supplyAtStart Share supply at the registration.
    function exitedSince(uint256 proposalId) external view returns (uint256 exited, uint256 supplyAtStart) {
        uint32 index = registrationOf[proposalId];
        if (index == 0) revert NotRegistered(proposalId);
        // Lots minted before registration `index` carry epoch <= index - 1, i.e. Fenwick positions 1..index.
        exited = _prefix(index) - burnedAtRegistration[index];
        supplyAtStart = supplyAtRegistration[index];
    }

    /// @notice Number of mint lots `account` holds (informational).
    function lotCount(address account) external view returns (uint256) {
        return _lots[account].length;
    }

    /// @notice One mint lot of `account` (informational).
    function lot(address account, uint256 index) external view returns (Lot memory) {
        return _lots[account][index];
    }

    // ---------------------------------------------------------------- Votes (timestamp checkpoints)

    /// @notice Current voting weight: the account's balance (shares are self-delegated).
    function getVotes(address account) external view returns (uint256) {
        return balanceOf[account];
    }

    /// @notice Voting weight of `account` at unix `timePoint`; Baal reads this at proposal votingStarts.
    function getPastVotes(address account, uint256 timePoint) external view returns (uint256) {
        if (timePoint >= block.timestamp) revert TimePointNotDetermined(timePoint, block.timestamp);
        Checkpoint[] storage history = _checkpoints[account];
        uint256 count = history.length;
        if (count == 0) return 0;
        if (history[count - 1].fromTimePoint <= timePoint) return history[count - 1].votes;
        if (history[0].fromTimePoint > timePoint) return 0;
        uint256 lower = 0;
        uint256 upper = count - 1;
        while (upper > lower) {
            uint256 center = upper - (upper - lower) / 2;
            Checkpoint storage cp = history[center];
            if (cp.fromTimePoint == timePoint) return cp.votes;
            if (cp.fromTimePoint < timePoint) lower = center;
            else upper = center - 1;
        }
        return history[lower].votes;
    }

    function numCheckpoints(address account) external view returns (uint256) {
        return _checkpoints[account].length;
    }

    function getCheckpoint(address account, uint256 index) external view returns (Checkpoint memory) {
        return _checkpoints[account][index];
    }

    function delegates(address account) external pure returns (address) {
        return account;
    }

    // ---------------------------------------------------------------- NAV

    /// @notice Settlement-asset balance of the treasury Safe.
    function treasuryValue() public view returns (uint256) {
        return settlementToken.balanceOf(safe);
    }

    /// @notice Shares matching a settlement contribution at the current NAV per share.
    /// @dev While NAV is undefined (no shares or no assets) one settlement unit mints one share.
    /// @notice Shares minted for `contributedValue` settlement units: amount x totalSupply / treasury
    /// while the treasury holds assets; one share (18 dec) per one settlement unit while the treasury
    /// is empty (DESIGN.md §6). No other fallback: treasury > 0 with totalSupply == 0 quotes zero.
    function navSharesFor(uint256 contributedValue) external view returns (uint256) {
        uint256 nav = treasuryValue();
        if (nav == 0) return Math.mulDiv(contributedValue, 10 ** decimals, settlementUnit);
        return Math.mulDiv(contributedValue, totalSupply, nav);
    }

    /// @notice Settlement-asset claim represented by a share amount, rounded down (zero when NAV is zero).
    function navValueForShares(uint256 shares) external view returns (uint256) {
        uint256 supply = totalSupply;
        uint256 nav = treasuryValue();
        if (supply == 0 || nav == 0) return 0;
        return Math.mulDiv(shares, nav, supply);
    }

    // ---------------------------------------------------------------- internals

    function _mint(address recipient, uint256 amount) internal {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 nextSupply = totalSupply + amount;
        if (nextSupply > type(uint224).max) revert SupplyCapExceeded(nextSupply);
        totalSupply = nextSupply;
        uint256 previous = balanceOf[recipient];
        unchecked {
            balanceOf[recipient] = previous + amount;
        }
        _pushLot(recipient, amount);
        _writeCheckpoint(recipient, previous, previous + amount);
        emit Transfer(address(0), recipient, amount);
    }

    /// @dev Append `amount` to the account's newest lot when it has the current epoch, else open a lot.
    function _pushLot(address account, uint256 amount) private {
        Lot[] storage lots = _lots[account];
        uint256 count = lots.length;
        if (count != 0 && lots[count - 1].epoch == epoch) {
            lots[count - 1].amount += uint224(amount);
        } else {
            lots.push(Lot({epoch: epoch, amount: uint224(amount)}));
        }
    }

    /// @dev Consume `amount` from the account's lots, newest first, crediting each lot's epoch in the tree.
    function _consumeLots(address account, uint256 amount) private {
        Lot[] storage lots = _lots[account];
        while (amount != 0) {
            Lot storage last = lots[lots.length - 1];
            uint256 held = last.amount;
            if (held <= amount) {
                _addBurned(last.epoch, held);
                amount -= held;
                lots.pop();
            } else {
                _addBurned(last.epoch, amount);
                last.amount = uint224(held - amount);
                amount = 0;
            }
        }
    }

    /// @dev Fenwick point update at position mintEpoch + 1.
    function _addBurned(uint32 mintEpoch, uint256 amount) private {
        for (uint256 i = uint256(mintEpoch) + 1; i <= MAX_EPOCHS; i += i & (~i + 1)) {
            _burnedByEpoch[i] += amount;
        }
    }

    /// @dev Fenwick prefix sum over positions 1..`position` (lots with epoch < position).
    function _prefix(uint256 position) private view returns (uint256 total) {
        for (uint256 i = position; i != 0; i -= i & (~i + 1)) {
            total += _burnedByEpoch[i];
        }
    }

    function _writeCheckpoint(address account, uint256 oldVotes, uint256 newVotes) internal {
        Checkpoint[] storage history = _checkpoints[account];
        uint32 timePoint = uint32(block.timestamp);
        uint256 count = history.length;
        if (count != 0 && history[count - 1].fromTimePoint == timePoint) {
            history[count - 1].votes = newVotes;
        } else {
            history.push(Checkpoint({fromTimePoint: timePoint, votes: newVotes}));
        }
        emit DelegateVotesChanged(account, oldVotes, newVotes);
    }
}
