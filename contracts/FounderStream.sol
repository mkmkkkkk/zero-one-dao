// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IBaalV3} from "./Interfaces.sol";

/// @notice Founder grant as a stream of a PROPORTION of supply, not an absolute number.
/// @dev Baal manager shaman. The founder is entitled to stream shares such that
///   streamShares / totalSupply == 10% x min(elapsed, duration) / duration,
/// where totalSupply counts everyone else's shares plus what the stream has minted. Solving for the
/// target with others = totalSupply - minted and p = 10% x elapsed / duration:
///   target = others x p / (1 - p) = others x elapsed / (10 x duration - elapsed).
/// At full vest target = others / 9, i.e. exactly 10% of supply; the founder never exceeds 10% and
/// never dilutes everyone else below 90%. What has streamed is claimable by anyone at any time and
/// lands as ordinary shares: fully owned, votable, exitable. No cliff, no lock. If others exit, the
/// entitlement shrinks but nothing already minted is clawed back (claimable simply reads zero).
/// All parameters are immutable; the DAO can only stop the stream by removing the shaman by proposal.
contract FounderStream {
    /// @notice Fixed-point one for `vestedFraction` (1e18 = fully vested).
    uint256 public constant WAD = 1e18;
    /// @notice Founder's share of total supply at full vest, in basis points (1000 = 10%).
    uint256 public constant TARGET_BPS = 1000;
    uint256 private constant BPS = 10_000;

    IBaalV3 public immutable baal;
    address public immutable founder;
    uint48 public immutable startedAt;
    uint48 public immutable endsAt;

    /// @notice Cumulative shares minted by this stream (the founder's stream shares).
    uint256 public minted;

    error ZeroAddress();
    error ZeroDuration();
    error NothingToClaim();

    event FounderStreamCreated(address indexed founder, uint256 targetBps, uint48 startedAt, uint48 endsAt);
    event FounderSharesClaimed(address indexed caller, uint256 amount, uint256 cumulativeMinted, uint256 totalSupplyAfter);

    /// @param baal_ The Baal whose mintShares / totalShares this shaman uses.
    /// @param founder_ Recipient of every streamed share; immutable.
    /// @param duration Stream length in seconds, measured from deployment (genesis).
    constructor(IBaalV3 baal_, address founder_, uint48 duration) {
        if (address(baal_) == address(0) || founder_ == address(0)) revert ZeroAddress();
        if (duration == 0) revert ZeroDuration();
        baal = baal_;
        founder = founder_;
        startedAt = uint48(block.timestamp);
        endsAt = uint48(block.timestamp) + duration;
        emit FounderStreamCreated(founder_, TARGET_BPS, startedAt, endsAt);
    }

    /// @notice Seconds of the stream elapsed so far, capped at the full duration.
    function elapsed() public view returns (uint256) {
        if (block.timestamp >= endsAt) return endsAt - startedAt;
        return block.timestamp - startedAt;
    }

    /// @notice Vested fraction of the 10% target, WAD-scaled (0 at genesis, 1e18 after 4 years).
    function vestedFraction() public view returns (uint256) {
        return (elapsed() * WAD) / (endsAt - startedAt);
    }

    /// @notice Shares held by everyone except the stream: totalSupply minus what this stream minted.
    /// @dev Saturates at zero if the founder has exited stream shares and the supply fell below `minted`.
    function othersShares() public view returns (uint256) {
        uint256 supply = baal.totalShares();
        return supply > minted ? supply - minted : 0;
    }

    /// @notice Stream shares the founder is entitled to right now, cumulative (see contract note).
    function entitlement() public view returns (uint256) {
        uint256 e = elapsed();
        if (e == 0) return 0;
        uint256 duration = endsAt - startedAt;
        // target / (others + target) == TARGET_BPS/BPS x e/duration  <=>  target = others x TARGET_BPS x e / (BPS x duration - TARGET_BPS x e)
        return Math.mulDiv(othersShares(), TARGET_BPS * e, BPS * duration - TARGET_BPS * e);
    }

    /// @notice Entitled-but-unminted stream shares (zero if the entitlement fell below `minted`).
    function claimable() public view returns (uint256) {
        uint256 target = entitlement();
        return target > minted ? target - minted : 0;
    }

    /// @notice Mint every claimable stream share to the founder. Anyone may call.
    function claim() external returns (uint256 amount) {
        amount = claimable();
        if (amount == 0) revert NothingToClaim();
        minted += amount;
        address[] memory to = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        to[0] = founder;
        amounts[0] = amount;
        baal.mintShares(to, amounts);
        emit FounderSharesClaimed(msg.sender, amount, minted, baal.totalShares());
    }
}
