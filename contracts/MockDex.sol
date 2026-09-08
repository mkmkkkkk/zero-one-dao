// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "./Interfaces.sol";

/// @notice Mirror-only constant-price venue: swap settlement (USDC-mock) <-> a mock asset at `price`.
/// @dev Both tokens are 6-decimal TestTokens; `price` is settlement units per one whole asset unit
/// (PRICE_UNIT = 1e6, so price 2_000_000 means 2 USDC per MOCK). Anyone may move the price: the
/// mirror uses that to drive a Strategy's take-profit / stop-loss rules. Liquidity is whatever was
/// transferred in. Never deployed anywhere but a local anvil; real venues are named in the
/// Strategy parameters on mainnet.
contract MockDex {
    uint256 public constant PRICE_UNIT = 1e6;
    uint256 public constant assetUnit = 1e6;

    IERC20Minimal public immutable settlement;
    IERC20Minimal public immutable asset;
    uint256 public price;

    error ZeroAddress();
    error ZeroPrice();
    error ZeroAmount();
    error TransferFailed();

    event PriceSet(uint256 price);
    event Drained(address indexed token, address indexed to, uint256 amount);
    event Bought(address indexed buyer, uint256 settlementIn, uint256 assetOut);
    event Sold(address indexed seller, uint256 assetIn, uint256 settlementOut);

    /// @param settlement_ Settlement token (USDC-mock).
    /// @param asset_ Traded asset (MOCK).
    /// @param price_ Initial price in settlement units per whole asset unit.
    constructor(IERC20Minimal settlement_, IERC20Minimal asset_, uint256 price_) {
        if (address(settlement_) == address(0) || address(asset_) == address(0)) revert ZeroAddress();
        if (price_ == 0) revert ZeroPrice();
        settlement = settlement_;
        asset = asset_;
        price = price_;
        emit PriceSet(price_);
    }

    /// @notice Move the price (mirror control; anyone).
    function setPrice(uint256 price_) external {
        if (price_ == 0) revert ZeroPrice();
        price = price_;
        emit PriceSet(price_);
    }

    /// @notice Remove the whole balance of `token` (mirror control; anyone): simulates a dead venue
    /// whose sells revert, so scenarios can show that stop()/migrate() never call it.
    /// @param token The token to drain (settlement or asset).
    /// @param to Recipient of the drained balance.
    /// @return amount Units moved.
    function drain(IERC20Minimal token, address to) external returns (uint256 amount) {
        amount = token.balanceOf(address(this));
        if (amount == 0) revert ZeroAmount();
        if (!token.transfer(to, amount)) revert TransferFailed();
        emit Drained(address(token), to, amount);
    }

    /// @notice Asset received for `settlementIn` at the current price.
    function quoteBuy(uint256 settlementIn) public view returns (uint256 assetOut) {
        return (settlementIn * PRICE_UNIT) / price;
    }

    /// @notice Settlement received for `assetIn` at the current price.
    function quoteSell(uint256 assetIn) public view returns (uint256 settlementOut) {
        return (assetIn * price) / PRICE_UNIT;
    }

    /// @notice Pull `settlementIn` (pre-approved) and send the asset at the current price.
    function buy(uint256 settlementIn, uint256) external returns (uint256 assetOut) {
        if (settlementIn == 0) revert ZeroAmount();
        assetOut = quoteBuy(settlementIn);
        if (assetOut == 0) revert ZeroAmount();
        if (!settlement.transferFrom(msg.sender, address(this), settlementIn)) revert TransferFailed();
        if (!asset.transfer(msg.sender, assetOut)) revert TransferFailed();
        emit Bought(msg.sender, settlementIn, assetOut);
    }

    /// @notice Pull `assetIn` (pre-approved) and send settlement at the current price.
    function sell(uint256 assetIn, uint256) external returns (uint256 settlementOut) {
        if (assetIn == 0) revert ZeroAmount();
        settlementOut = quoteSell(assetIn);
        if (settlementOut == 0) revert ZeroAmount();
        if (!asset.transferFrom(msg.sender, address(this), assetIn)) revert TransferFailed();
        if (!settlement.transfer(msg.sender, settlementOut)) revert TransferFailed();
        emit Sold(msg.sender, assetIn, settlementOut);
    }
}
