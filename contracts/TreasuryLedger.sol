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
/// @dev No asset valuation. Deposit NAV counts the settlement held by the Safe and by every open
/// instance; deposits are refused while an open instance holds its registered asset (phase 5 ruling 4a:
/// the gate never looks at Safe balances, so dust sent to the Safe cannot pause deposits). `assets` is an
/// append-only registry of every non-settlement asset a voted instance ever held; it is informational.
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

    /// @param safe_ The treasury Safe.
    /// @param settlement_ The settlement ERC-20 (USDC).
    /// @param factory_ The TemplateFactory whose deployment record authenticates callers.
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
    /// @dev Requires status Running (set by start() before the call); registers the instance's asset once.
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

    /// @notice Terminal template paths return/move funds first; closing a never-open instance is a no-op.
    /// @dev Requires a terminal status (Complete, Stopped, Migrated) on the caller.
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

    /// @notice Every instance currently in the active set.
    function openInstances() external view returns (address[] memory) { return _open; }

    /// @notice Whether `instance` is in the active set.
    function isOpen(address instance) external view returns (bool) { return _indexPlusOne[instance] != 0; }

    /// @notice Number of assets ever registered.
    function assetCount() external view returns (uint256) { return assets.length; }

    /// @notice The non-settlement asset registered for an open instance (0 when none or not open).
    function assetOf(address instance) external view returns (address) {
        return _indexPlusOne[instance] == 0 ? address(0) : _asset[instance];
    }

    /// @notice Deposit NAV numerator: Safe settlement plus the settlement held by every open instance.
    function depositTreasury() external view returns (uint256 total) {
        total = settlement.balanceOf(safe);
        for (uint256 i; i < _open.length; ++i) total += settlement.balanceOf(_open[i]);
    }

    /// @notice True while no open instance holds any of its registered asset. Safe balances are never
    /// consulted: a non-settlement asset on the Safe is shared by exit only (phase 5 ruling 4a).
    function settled() external view returns (bool) {
        for (uint256 i; i < _open.length; ++i) {
            address asset = _asset[_open[i]];
            if (asset != address(0) && IERC20Minimal(asset).balanceOf(_open[i]) != 0) return false;
        }
        return true;
    }
}
