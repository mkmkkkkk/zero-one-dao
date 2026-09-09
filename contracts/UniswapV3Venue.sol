// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TickMath} from "./TickMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC20Minimal, IERC20Metadata} from "./Interfaces.sol";
import {IStrategyVenue} from "./StrategyProposal.sol";

interface IV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}
interface IV3Pool {
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory, uint160[] memory);
    function slot0() external view returns (
        uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality,
        uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked
    );
    function observations(uint256 index) external view returns (
        uint32 blockTimestamp, int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, bool initialized
    );
}
interface IV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function factory() external view returns (address);
    function WETH9() external view returns (address);
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}
interface IV3Quoter {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }
    function factory() external view returns (address);
    function WETH9() external view returns (address);
    function quoteExactInputSingle(QuoteExactInputSingleParams calldata params)
        external returns (uint256, uint160, uint32, uint256);
}

/// @notice Stateless single-pool Strategy venue on Uniswap v3 (phase 4 ruling "Hole 2"). No owner,
/// administrator or mutable configuration; holdings belong to the calling Strategy.
/// @dev `price()` is the pool's own 30-minute arithmetic-mean tick (`observe`), never `slot0`. Every
/// swap must return at least the TWAP-implied output x (10_000 - slippageBps) / 10_000 and at least the
/// same-transaction QuoterV2 quote discounted the same way, so a same-block spot move (flash swap,
/// sandwich) makes the swap revert instead of filling at the printed price. Thin pools therefore refuse
/// large runs; `maxPerRun` is the voted chunk size. The constructor refuses a pool whose stored
/// observation history does not already cover the window. No asset valuation is used for deposits.
contract UniswapV3Venue is IStrategyVenue, ReentrancyGuard {
    /// @notice Fixed TWAP window in seconds (docs/PARAMETERS.md "Phase 4 venue pricing", IMMUTABLE).
    uint32 public constant TWAP_WINDOW = 30 minutes;

    address public immutable safe;
    IERC20Minimal public immutable settlement;
    IERC20Minimal public immutable asset;
    IV3Router public immutable router;
    IV3Quoter public immutable quoter;
    IV3Factory public immutable factory;
    address public immutable pool;
    uint24 public immutable fee;
    uint256 public immutable assetUnit;
    uint8 public immutable settlementDecimals;

    error InvalidDependency();
    error WindowUnavailable(uint16 observationCardinality, uint32 oldestObservationAge);
    error InvalidAmount();
    error BadSlippage();
    error TransferFailed();
    error InexactTransfer();
    error ResidualHoldings();
    error TwapBoundExceeded(uint256 output, uint256 minimum);

    event Swapped(address indexed strategy, address indexed tokenIn, uint256 amountIn, uint256 quoted, uint256 minimum, uint256 amountOut);

    /// @notice Bind the venue to one Safe, one pair, one fee tier and the published router / quoter / factory.
    /// @dev Reverts `InvalidDependency` on a zero Safe, an identical pair, a code-less dependency, a router or
    /// quoter that does not report `factory_`, or a pair/fee with no pool. Reverts `WindowUnavailable` when the
    /// pool's oldest stored observation is younger than `TWAP_WINDOW` (its history cannot serve the window), and
    /// bubbles the pool's own `OLD` revert if `observe(TWAP_WINDOW)` still fails.
    /// @param safe_ The treasury Safe (immutable sweep sink).
    /// @param settlement_ The settlement ERC-20 (USDC).
    /// @param asset_ The traded ERC-20 (e.g. WETH).
    /// @param router_ Uniswap SwapRouter02.
    /// @param quoter_ Uniswap QuoterV2.
    /// @param factory_ Uniswap v3 factory.
    /// @param fee_ Pool fee tier (e.g. 500 = 0.05%).
    constructor(address safe_, address settlement_, address asset_, address router_, address quoter_, address factory_, uint24 fee_) {
        if (safe_ == address(0) || settlement_ == asset_ || settlement_.code.length == 0 || asset_.code.length == 0 ||
            router_.code.length == 0 || quoter_.code.length == 0 || factory_.code.length == 0) revert InvalidDependency();
        safe = safe_;
        settlement = IERC20Minimal(settlement_);
        asset = IERC20Minimal(asset_);
        router = IV3Router(router_);
        quoter = IV3Quoter(quoter_);
        factory = IV3Factory(factory_);
        if (router.factory() != factory_ || quoter.factory() != factory_) revert InvalidDependency();
        address pool_ = factory.getPool(settlement_, asset_, fee_);
        if (pool_.code.length == 0) revert InvalidDependency();
        pool = pool_;
        fee = fee_;
        // Read metadata through the token address (USDC is a proxy).
        settlementDecimals = IERC20Metadata(settlement_).decimals();
        assetUnit = 10 ** uint256(IERC20Metadata(asset_).decimals());
        _requireWindow(pool_);
        // The pool itself must already serve the fixed window (reverts "OLD" otherwise).
        _meanTick();
    }

    /// @dev Refuse a pool whose stored observation history is shorter than the window. The oldest stored
    /// observation is the slot after the current index (or slot 0 while the ring is not yet full).
    /// @param pool_ The pool under inspection.
    function _requireWindow(address pool_) private view {
        (,, uint16 index, uint16 cardinality,,,) = IV3Pool(pool_).slot0();
        if (cardinality == 0) revert WindowUnavailable(0, 0);
        (uint32 oldest,,, bool initialized) = IV3Pool(pool_).observations((uint256(index) + 1) % cardinality);
        if (!initialized) (oldest,,,) = IV3Pool(pool_).observations(0);
        uint32 age = uint32(block.timestamp) - oldest;
        if (age < TWAP_WINDOW) revert WindowUnavailable(cardinality, age);
    }

    /// @dev Arithmetic-mean tick of the pool over the last `TWAP_WINDOW` seconds.
    /// @return tick The mean tick, rounded toward negative infinity like Uniswap's OracleLibrary.
    function _meanTick() private view returns (int24 tick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = TWAP_WINDOW;
        (int56[] memory cumulatives,) = IV3Pool(pool).observe(secondsAgos);
        int56 delta;
        // V3 tick cumulatives intentionally wrap int56.
        unchecked { delta = cumulatives[1] - cumulatives[0]; }
        int56 window = int56(uint56(TWAP_WINDOW));
        tick = int24(delta / window);
        // Solidity rounds toward zero; an arithmetic mean tick rounds toward negative infinity.
        if (delta < 0 && delta % window != 0) tick--;
    }

    /// @notice 30-minute TWAP in settlement base units per whole asset token (`assetUnit`).
    /// @dev Converts the mean tick to sqrtPriceX96 and squares it; the second branch avoids overflow for
    /// sqrt prices above uint128 (exotic pairs only).
    /// @return Settlement base units per `assetUnit` asset units.
    function price() public view returns (uint256) {
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(_meanTick());
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            return address(asset) < address(settlement)
                ? Math.mulDiv(ratioX192, assetUnit, 1 << 192)
                : Math.mulDiv(1 << 192, assetUnit, ratioX192);
        }
        uint256 ratioX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
        return address(asset) < address(settlement)
            ? Math.mulDiv(ratioX128, assetUnit, 1 << 128)
            : Math.mulDiv(1 << 128, assetUnit, ratioX128);
    }

    /// @notice Swap `amount` settlement units (pre-approved by the caller) into the asset, delivered to the caller.
    /// @param amount Settlement base units to spend.
    /// @param slippageBps Voted tolerance (0..10_000) applied to the TWAP-implied output and to the quote.
    /// @return Asset base units received by the caller.
    function buy(uint256 amount, uint256 slippageBps) external nonReentrant returns (uint256) {
        return _swap(settlement, asset, amount, slippageBps);
    }

    /// @notice Swap `amount` asset units (pre-approved by the caller) into settlement, delivered to the caller.
    /// @param amount Asset base units to sell.
    /// @param slippageBps Voted tolerance (0..10_000) applied to the TWAP-implied output and to the quote.
    /// @return Settlement base units received by the caller.
    function sell(uint256 amount, uint256 slippageBps) external nonReentrant returns (uint256) {
        return _swap(asset, settlement, amount, slippageBps);
    }

    /// @notice Anyone may return unsolicited pair-token dust to the immutable treasury.
    /// @dev The caller can neither choose a recipient nor touch holdings in a Strategy instance.
    function sweep() external nonReentrant {
        uint256 settlementHeld = settlement.balanceOf(address(this));
        uint256 assetHeld = asset.balanceOf(address(this));
        if (settlementHeld != 0 && !settlement.transfer(safe, settlementHeld)) revert TransferFailed();
        if (assetHeld != 0 && !asset.transfer(safe, assetHeld)) revert TransferFailed();
    }

    /// @dev Exact-input swap bounded by the TWAP and by the same-transaction quote.
    /// Reverts `InvalidAmount` (zero amount, zero quote or zero TWAP), `BadSlippage`, `ResidualHoldings` (the
    /// venue must be empty before and after), `TwapBoundExceeded` (quote below the TWAP-implied minimum),
    /// `InexactTransfer` (token deltas differ from the amounts) and `TransferFailed`.
    /// @param tokenIn Token pulled from the caller.
    /// @param tokenOut Token delivered to the caller.
    /// @param amount Exact input in `tokenIn` base units.
    /// @param slippageBps Voted tolerance in basis points.
    /// @return out `tokenOut` base units delivered to the caller.
    function _swap(IERC20Minimal tokenIn, IERC20Minimal tokenOut, uint256 amount, uint256 slippageBps) private returns (uint256 out) {
        if (amount == 0) revert InvalidAmount();
        if (slippageBps > 10_000) revert BadSlippage();
        // Do not silently mix a caller's funds with any previous holdings.
        if (tokenIn.balanceOf(address(this)) != 0 || tokenOut.balanceOf(address(this)) != 0) revert ResidualHoldings();
        (uint256 quoted,,,) = quoter.quoteExactInputSingle(IV3Quoter.QuoteExactInputSingleParams(address(tokenIn), address(tokenOut), amount, fee, 0));
        if (quoted == 0) revert InvalidAmount();
        uint256 twapPrice = price();
        if (twapPrice == 0) revert InvalidAmount();
        uint256 implied = address(tokenIn) == address(settlement)
            ? Math.mulDiv(amount, assetUnit, twapPrice)
            : Math.mulDiv(amount, twapPrice, assetUnit);
        uint256 twapMinimum = Math.mulDiv(implied, 10_000 - slippageBps, 10_000);
        if (quoted < twapMinimum) revert TwapBoundExceeded(quoted, twapMinimum);
        uint256 minimum = Math.max(twapMinimum, Math.mulDiv(quoted, 10_000 - slippageBps, 10_000));
        uint256 inputBefore = tokenIn.balanceOf(msg.sender);
        uint256 outputBefore = tokenOut.balanceOf(msg.sender);
        if (!tokenIn.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        if (tokenIn.balanceOf(address(this)) != amount || tokenIn.balanceOf(msg.sender) != inputBefore - amount) revert InexactTransfer();
        if (!tokenIn.approve(address(router), amount)) revert TransferFailed();
        out = router.exactInputSingle(IV3Router.ExactInputSingleParams(address(tokenIn), address(tokenOut), fee, msg.sender, amount, minimum, 0));
        if (!tokenIn.approve(address(router), 0)) revert TransferFailed();
        if (out < minimum || out == 0 || tokenOut.balanceOf(msg.sender) != outputBefore + out) revert InexactTransfer();
        if (tokenIn.balanceOf(address(this)) != 0 || tokenOut.balanceOf(address(this)) != 0) revert ResidualHoldings();
        emit Swapped(msg.sender, address(tokenIn), amount, quoted, minimum, out);
    }
}
