// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "./Interfaces.sol";
import {IProposalContract} from "./IProposalContract.sol";

interface ILedgerFactory {
    function instances(address instance) external view returns (bool);
}
interface ILedgerInstance {
    function status() external view returns (IProposalContract.Status);
    function ledgerAsset() external view returns (address);
}

/// @notice Settlement accounting for the Safe and its factory-authenticated, voted active instances.
/// No asset valuation: registered non-settlement holdings refuse deposits until they are cleared.
contract TreasuryLedger {
    address public immutable safe;
    IERC20Minimal public immutable settlement;
    ILedgerFactory public immutable factory;
    address[] public assets;
    mapping(address => bool) public registeredAsset;
    address[] private _open;
    mapping(address => uint256) private _indexPlusOne;
    mapping(address => address) private _asset;

    error UnknownInstance(address instance);
    error InvalidLifecycle();
    error AlreadyOpen();

    constructor(address safe_, address settlement_, address factory_) {
        safe = safe_;
        settlement = IERC20Minimal(settlement_);
        factory = ILedgerFactory(factory_);
    }

    modifier authenticated() {
        if (!factory.instances(msg.sender)) revert UnknownInstance(msg.sender);
        _;
    }

    /// @notice Called by the authenticated template inside its Safe-only start transaction.
    function open() external authenticated {
        if (ILedgerInstance(msg.sender).status() != IProposalContract.Status.Running) revert InvalidLifecycle();
        if (_indexPlusOne[msg.sender] != 0) revert AlreadyOpen();
        address asset = ILedgerInstance(msg.sender).ledgerAsset();
        if (asset != address(0) && asset != address(settlement)) {
            _asset[msg.sender] = asset;
            if (!registeredAsset[asset]) {
                registeredAsset[asset] = true;
                assets.push(asset);
            }
        }
        _open.push(msg.sender);
        _indexPlusOne[msg.sender] = _open.length;
    }

    /// @notice Terminal template paths return/move funds first; Pending stop is an idempotent no-op.
    function close() external authenticated {
        IProposalContract.Status status = ILedgerInstance(msg.sender).status();
        if (status != IProposalContract.Status.Complete && status != IProposalContract.Status.Stopped && status != IProposalContract.Status.Migrated) revert InvalidLifecycle();
        uint256 index = _indexPlusOne[msg.sender];
        if (index == 0) return;
        address last = _open[_open.length - 1];
        _open[index - 1] = last;
        _indexPlusOne[last] = index;
        _open.pop();
        delete _indexPlusOne[msg.sender];
    }

    function openInstances() external view returns (address[] memory) { return _open; }
    function assetCount() external view returns (uint256) { return assets.length; }

    function depositTreasury() external view returns (uint256 total) {
        total = settlement.balanceOf(safe);
        for (uint256 i; i < _open.length; ++i) total += settlement.balanceOf(_open[i]);
    }

    function settled() external view returns (bool) {
        for (uint256 i; i < _open.length; ++i) {
            address asset = _asset[_open[i]];
            if (asset != address(0) && IERC20Minimal(asset).balanceOf(_open[i]) != 0) return false;
        }
        for (uint256 i; i < assets.length; ++i) {
            if (IERC20Minimal(assets[i]).balanceOf(safe) != 0) return false;
        }
        return true;
    }
}
