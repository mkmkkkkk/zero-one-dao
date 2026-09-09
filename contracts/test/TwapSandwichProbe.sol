// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UniswapV3Venue} from "../UniswapV3Venue.sol";
import {IERC20Minimal} from "../Interfaces.sol";

interface IProbePool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external returns (int256 amount0, int256 amount1);
}
interface IProbeWeth { function deposit() external payable; }
interface IProbeStrategy {
    function run() external;
    function value() external view returns (uint256);
}

/// @notice Fork-only test fixture (scenario K, audit rows T-4 / T-5): a sandwich against a Strategy in one
/// transaction. Front-run: move the real pool's spot price with the fixture's own capital until a sqrt price
/// limit. Victim: call `run()` on the Strategy in the same block. Back-run: swap everything received back with
/// the pre-manipulation sqrt price as the limit. Never deployed anywhere but a local Anvil fork.
/// @dev The fixture pays the pool directly through `uniswapV3SwapCallback`, so it needs no router approval.
/// It asserts, inside the transaction, that `venue.price()` (30-minute TWAP) and `strategy.value()` do not
/// move with the spot print; the TypeScript caller decodes `Sandwiched` and asserts the spot move size, the
/// refusal and the fills.
contract TwapSandwichProbe {
    struct Report {
        uint256 priceBefore;
        uint256 priceDuring;
        uint256 valueBefore;
        uint256 valueDuring;
        uint160 sqrtBefore;
        uint160 sqrtDuring;
        uint160 sqrtAfter;
        uint256 moved;
        uint256 received;
        uint256 refusedOutput;
        uint256 refusedMinimum;
    }

    UniswapV3Venue public immutable venue;
    IProbePool public immutable pool;
    IERC20Minimal public immutable asset;
    IERC20Minimal public immutable settlement;

    error PriceMoved(uint256 priceBefore, uint256 priceDuring);
    error ValueMoved(uint256 valueBefore, uint256 valueDuring);
    error RunDidNotRevert();
    error UnexpectedRevert(bytes reason);
    error PoolOnly();

    event Sandwiched(address indexed strategy, bool zeroForOne, bool expectRefusal, Report report);

    /// @param venue_ The UniswapV3Venue whose pool and pair the fixture trades.
    constructor(UniswapV3Venue venue_) {
        venue = venue_;
        pool = IProbePool(venue_.pool());
        asset = venue_.asset();
        settlement = venue_.settlement();
    }

    /// @notice Wrap the attached ether into the venue's asset (WETH) as manipulation capital.
    function wrap() external payable {
        IProbeWeth(address(asset)).deposit{value: msg.value}();
    }

    /// @notice Sandwich `strategy` in this transaction.
    /// @dev Front-run with the fixture's whole `asset` (zeroForOne) or `settlement` (oneForZero) balance until
    /// `sqrtPriceLimit`; requires `venue.price()` and `strategy.value()` unchanged by the print. With
    /// `expectRefusal` the victim `run()` must revert `UniswapV3Venue.TwapBoundExceeded` (output and minimum are
    /// reported); without it the run must succeed. Then the back-run swaps everything received the other way,
    /// limited by the pre-manipulation sqrt price, and with `expectRefusal` the victim `run()` must now succeed.
    /// @param strategy The Running Strategy under attack.
    /// @param zeroForOne Front-run direction: true sells the pool's token0 (price of token0 falls).
    /// @param sqrtPriceLimit Front-run sqrt price limit (X96); the pool stops there.
    /// @param expectRefusal Whether the victim's run during the print must revert on the TWAP bound.
    /// @return report The numbers, also emitted as `Sandwiched`.
    function sandwich(address strategy, bool zeroForOne, uint160 sqrtPriceLimit, bool expectRefusal)
        external returns (Report memory report)
    {
        report.priceBefore = venue.price();
        report.valueBefore = IProbeStrategy(strategy).value();
        (report.sqrtBefore,,,,,,) = pool.slot0();
        (address tokenIn,) = _pair(zeroForOne);
        int256 amountIn = int256(IERC20Minimal(tokenIn).balanceOf(address(this)));
        (int256 amount0, int256 amount1) = pool.swap(address(this), zeroForOne, amountIn, sqrtPriceLimit, "");
        report.moved = uint256(zeroForOne ? amount0 : amount1);
        report.received = uint256(-(zeroForOne ? amount1 : amount0));
        (report.sqrtDuring,,,,,,) = pool.slot0();
        report.priceDuring = venue.price();
        report.valueDuring = IProbeStrategy(strategy).value();
        if (report.priceDuring != report.priceBefore) revert PriceMoved(report.priceBefore, report.priceDuring);
        if (report.valueDuring != report.valueBefore) revert ValueMoved(report.valueBefore, report.valueDuring);
        if (expectRefusal) {
            try IProbeStrategy(strategy).run() { revert RunDidNotRevert(); }
            catch (bytes memory reason) {
                if (reason.length != 68 || bytes4(reason) != UniswapV3Venue.TwapBoundExceeded.selector) revert UnexpectedRevert(reason);
                uint256 output;
                uint256 minimum;
                // Skip the 32-byte length word and the 4-byte selector.
                assembly { output := mload(add(reason, 36)) minimum := mload(add(reason, 68)) }
                report.refusedOutput = output;
                report.refusedMinimum = minimum;
            }
        } else {
            IProbeStrategy(strategy).run();
        }
        pool.swap(address(this), !zeroForOne, int256(report.received), report.sqrtBefore, "");
        (report.sqrtAfter,,,,,,) = pool.slot0();
        if (expectRefusal) IProbeStrategy(strategy).run();
        emit Sandwiched(strategy, zeroForOne, expectRefusal, report);
    }

    /// @notice Pay the pool for a swap the fixture initiated.
    /// @param amount0Delta Token0 owed to the pool when positive.
    /// @param amount1Delta Token1 owed to the pool when positive.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != address(pool)) revert PoolOnly();
        (address token0, address token1) = _pair(true);
        if (amount0Delta > 0) require(IERC20Minimal(token0).transfer(msg.sender, uint256(amount0Delta)), "token0 transfer");
        if (amount1Delta > 0) require(IERC20Minimal(token1).transfer(msg.sender, uint256(amount1Delta)), "token1 transfer");
    }

    /// @dev Order the pair as the pool does.
    /// @param zeroForOne When true, returns (token0, token1); otherwise (token1, token0).
    /// @return tokenIn The input token for that direction.
    /// @return tokenOut The output token for that direction.
    function _pair(bool zeroForOne) private view returns (address tokenIn, address tokenOut) {
        (address token0, address token1) = address(asset) < address(settlement)
            ? (address(asset), address(settlement))
            : (address(settlement), address(asset));
        return zeroForOne ? (token0, token1) : (token1, token0);
    }
}
