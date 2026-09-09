// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UniswapV3Venue} from "../UniswapV3Venue.sol";
import {IERC20Minimal} from "../Interfaces.sol";

interface IProbePool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
}
interface IProbeWeth { function deposit() external payable; }
interface IProbeStrategy { function run() external; }

/// @dev Test fixture only: a real pool swap and rejected Strategy run occur inside one
/// reverted subcall, then the restored strategy runs successfully in the same transaction.
/// The rollback removes the manipulation exactly, including fees and oracle writes.
contract TwapForkProbe {
    UniswapV3Venue public immutable venue;
    IProbePool public immutable pool;
    error ProbeResult(uint256 beforePrice, uint256 duringPrice, uint160 beforeSqrt, uint160 duringSqrt, uint256 output, uint256 minimum);
    event Proven(uint256 blockNumber, uint256 beforePrice, uint256 duringPrice, uint160 beforeSqrt, uint160 duringSqrt, uint256 output, uint256 minimum);

    constructor(UniswapV3Venue venue_) payable {
        venue = venue_;
        pool = IProbePool(venue_.pool());
        IProbeWeth(address(venue_.asset())).deposit{value: msg.value}();
    }

    function prove(address strategy) external {
        (uint160 beforeSqrt,,,,,,) = pool.slot0();
        uint256 beforePrice = venue.price();
        try this.manipulate(strategy) { revert("probe must report rollback"); }
        catch (bytes memory reason) {
            require(bytes4(reason) == ProbeResult.selector, "unexpected probe failure");
            // Strip the custom-error selector before decoding its six static words.
            bytes memory payload = new bytes(reason.length - 4);
            for (uint256 i; i < payload.length; i++) payload[i] = reason[i + 4];
            (uint256 p0, uint256 p1, uint160 s0, uint160 s1, uint256 output, uint256 minimum) =
                abi.decode(payload, (uint256, uint256, uint160, uint160, uint256, uint256));
            require(p0 == beforePrice && p1 == p0 && s0 == beforeSqrt, "TWAP changed");
            // sqrtAfter <= 0.8 sqrtBefore means spot fell >=36%, well over 20%.
            require(uint256(s1) * 10 <= uint256(s0) * 8, "spot move too small");
            require(output < minimum, "not a TWAP refusal");
            (uint160 restored,,,,,,) = pool.slot0();
            require(restored == s0 && venue.price() == p0, "pool not restored");
            IProbeStrategy(strategy).run();
            emit Proven(block.number, p0, p1, s0, s1, output, minimum);
        }
    }

    function manipulate(address strategy) external {
        require(msg.sender == address(this), "self only");
        uint256 beforePrice = venue.price();
        (uint160 beforeSqrt,,,,,,) = pool.slot0();
        require(address(venue.asset()) < address(venue.settlement()), "WETH must be token0");
        pool.swap(address(this), true, int256(venue.asset().balanceOf(address(this))), uint160(uint256(beforeSqrt) * 8 / 10), "");
        (uint160 duringSqrt,,,,,,) = pool.slot0();
        uint256 duringPrice = venue.price();
        try IProbeStrategy(strategy).run() { revert("manipulated run unexpectedly succeeded"); }
        catch (bytes memory reason) {
            require(bytes4(reason) == UniswapV3Venue.TwapBoundExceeded.selector, "wrong run refusal");
            uint256 output;
            uint256 minimum;
            assembly { output := mload(add(reason, 36)) minimum := mload(add(reason, 68)) }
            revert ProbeResult(beforePrice, duringPrice, beforeSqrt, duringSqrt, output, minimum);
        }
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == address(pool), "pool only");
        if (amount0Delta > 0) require(venue.asset().transfer(msg.sender, uint256(amount0Delta)), "WETH transfer");
        if (amount1Delta > 0) require(venue.settlement().transfer(msg.sender, uint256(amount1Delta)), "USDC transfer");
    }
}
