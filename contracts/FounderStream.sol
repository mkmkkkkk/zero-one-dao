// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBaalV3} from "./Interfaces.sol";

/// @notice Founder grant as a stream: shares mint linearly from genesis over `duration`.
/// @dev Baal manager shaman. What has streamed is claimable by anyone at any time and lands as
/// ordinary shares: fully owned, votable, exitable. Nothing sits in a cliff and nothing is locked.
/// All parameters are immutable; the DAO can only stop the stream by removing the shaman by proposal.
contract FounderStream {
    IBaalV3 public immutable baal;
    address public immutable founder;
    uint256 public immutable totalAmount;
    uint48 public immutable startedAt;
    uint48 public immutable endsAt;

    uint256 public minted;

    error ZeroAddress();
    error ZeroAmount();
    error ZeroDuration();
    error NothingToClaim();

    event FounderStreamCreated(address indexed founder, uint256 totalAmount, uint48 startedAt, uint48 endsAt);
    event FounderSharesClaimed(address indexed caller, uint256 amount, uint256 cumulativeMinted);

    /// @param baal_ The Baal whose mintShares this shaman calls.
    /// @param founder_ Recipient of every streamed share.
    /// @param totalAmount_ Total shares streamed over the full duration.
    /// @param duration Stream length in seconds, measured from deployment.
    constructor(IBaalV3 baal_, address founder_, uint256 totalAmount_, uint48 duration) {
        if (address(baal_) == address(0) || founder_ == address(0)) revert ZeroAddress();
        if (totalAmount_ == 0) revert ZeroAmount();
        if (duration == 0) revert ZeroDuration();
        baal = baal_;
        founder = founder_;
        totalAmount = totalAmount_;
        startedAt = uint48(block.timestamp);
        endsAt = uint48(block.timestamp) + duration;
        emit FounderStreamCreated(founder_, totalAmount_, startedAt, endsAt);
    }

    /// @notice Shares streamed so far (linear, no cliff).
    function vested() public view returns (uint256) {
        if (block.timestamp >= endsAt) return totalAmount;
        return (totalAmount * (block.timestamp - startedAt)) / (endsAt - startedAt);
    }

    /// @notice Streamed shares not yet minted.
    function claimable() public view returns (uint256) {
        return vested() - minted;
    }

    /// @notice Mint every streamed-but-unminted share to the founder. Anyone may call.
    function claim() external returns (uint256 amount) {
        amount = claimable();
        if (amount == 0) revert NothingToClaim();
        minted += amount;
        address[] memory to = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        to[0] = founder;
        amounts[0] = amount;
        baal.mintShares(to, amounts);
        emit FounderSharesClaimed(msg.sender, amount, minted);
    }
}
