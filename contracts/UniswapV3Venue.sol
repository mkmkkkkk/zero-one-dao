// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC20Minimal, IERC20Metadata} from "./Interfaces.sol";
import {IStrategyVenue} from "./StrategyProposal.sol";

interface IV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}
interface IV3Pool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
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

/// @notice Stateless single-pool venue dependency. No owner, administrator or mutable configuration.
/// @dev Holdings belong to the calling Strategy, not this venue. QuoterV2 and execution occur in
/// one transaction; the voted tolerance bounds execution against that quote, not against an oracle
/// or an earlier block. price() is the current slot0 spot price, not a manipulation-resistant oracle.
contract UniswapV3Venue is IStrategyVenue, ReentrancyGuard {
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
    error InvalidAmount();
    error BadSlippage();
    error TransferFailed();
    error InexactTransfer();
    error ResidualHoldings();

    event Swapped(address indexed strategy, address indexed tokenIn, uint256 amountIn, uint256 quoted, uint256 minimum, uint256 amountOut);

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
    }

    /// @notice Settlement base units per whole asset token, for Strategy's spot-value rule.
    function price() external view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = IV3Pool(pool).slot0();
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

    function buy(uint256 amount, uint256 slippageBps) external nonReentrant returns (uint256) {
        return _swap(settlement, asset, amount, slippageBps);
    }

    function sell(uint256 amount, uint256 slippageBps) external nonReentrant returns (uint256) {
        return _swap(asset, settlement, amount, slippageBps);
    }

    /// @notice Anyone may return unsolicited pair-token dust to the immutable treasury.
    /// The caller can neither choose a recipient nor touch holdings in a Strategy instance.
    function sweep() external nonReentrant {
        uint256 settlementHeld = settlement.balanceOf(address(this));
        uint256 assetHeld = asset.balanceOf(address(this));
        if (settlementHeld != 0 && !settlement.transfer(safe, settlementHeld)) revert TransferFailed();
        if (assetHeld != 0 && !asset.transfer(safe, assetHeld)) revert TransferFailed();
    }

    function _swap(IERC20Minimal tokenIn, IERC20Minimal tokenOut, uint256 amount, uint256 slippageBps) private returns (uint256 out) {
        if (amount == 0) revert InvalidAmount();
        if (slippageBps > 10_000) revert BadSlippage();
        // Do not silently mix a caller's funds with any previous holdings.
        if (tokenIn.balanceOf(address(this)) != 0 || tokenOut.balanceOf(address(this)) != 0) revert ResidualHoldings();
        (uint256 quoted,,,) = quoter.quoteExactInputSingle(IV3Quoter.QuoteExactInputSingleParams(address(tokenIn), address(tokenOut), amount, fee, 0));
        if (quoted == 0) revert InvalidAmount();
        uint256 minimum = Math.mulDiv(quoted, 10_000 - slippageBps, 10_000);
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
