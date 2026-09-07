// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "./Interfaces.sol";

/// @notice Non-transferable Baal voting shares priced at treasury NAV, with timestamp checkpoints.
/// @dev Derived from agent-only-wallet/exit NavShareToken. Removed on purpose: the founder vesting
/// lock (cliff, unvested gate on burn/transfer), the exit gate, the burn observer and the genesis
/// mint. Every share is minted through Baal by a shaman the DAO chose, and every share is exitable
/// through Baal.ragequit at any time. Votes equal balance (self-delegated, no delegation).
contract NavShareToken {
    using Math for uint256;

    struct Checkpoint {
        uint32 fromTimePoint;
        uint256 votes;
    }

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    address public immutable baal;
    address public immutable safe;
    IERC20Metadata public immutable settlementToken;
    /// @notice 10 ** settlement decimals; one settlement unit mints one share while NAV is undefined.
    uint256 public immutable settlementUnit;

    uint256 public totalSupply;
    uint256 public totalBurned;

    mapping(address account => uint256) public balanceOf;
    mapping(address account => Checkpoint[]) private _checkpoints;

    error OnlyBaal(address caller);
    error ZeroAddress();
    error EmptyName();
    error EmptySymbol();
    error NonTransferable();
    error PermanentlyUnpaused();
    error TimePointNotDetermined(uint256 timePoint, uint256 now_);
    error InsufficientBalance(address account, uint256 available, uint256 required);
    error SupplyCapExceeded(uint256 attemptedSupply);

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event SharesBurned(address indexed account, uint256 amount, uint256 cumulativeBurned);
    event DelegateVotesChanged(address indexed delegate, uint256 previousBalance, uint256 newBalance);

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
        _writeCheckpoint(account, available, available - amount);
        emit Transfer(account, address(0), amount);
        emit SharesBurned(account, amount, totalBurned);
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
    function navSharesFor(uint256 contributedValue) external view returns (uint256) {
        uint256 supply = totalSupply;
        uint256 nav = treasuryValue();
        if (supply == 0 || nav == 0) return Math.mulDiv(contributedValue, 10 ** decimals, settlementUnit);
        return Math.mulDiv(contributedValue, supply, nav);
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
        if (nextSupply > type(uint256).max / 2) revert SupplyCapExceeded(nextSupply);
        totalSupply = nextSupply;
        uint256 previous = balanceOf[recipient];
        unchecked {
            balanceOf[recipient] = previous + amount;
        }
        _writeCheckpoint(recipient, previous, previous + amount);
        emit Transfer(address(0), recipient, amount);
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
