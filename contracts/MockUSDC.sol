// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-chain settlement asset mirroring USDC (6 decimals): plain ERC20 plus a mint that only the
/// deployer may call, so testnet members can be funded without a browser faucet. Never deployed to mainnet
/// (Base mainnet settlement is Circle USDC, docs/PARAMETERS.md). No burn, pause, fee, hook, permit,
/// blacklist, upgrade or recovery mechanism; the minter address is fixed at construction.
contract MockUSDC {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    /// @notice The only address that may mint (the testnet deployer).
    address public immutable minter;

    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    error ZeroAddress();
    error OnlyMinter(address caller);
    error InsufficientBalance(address account, uint256 available, uint256 required);
    error InsufficientAllowance(address owner, address spender, uint256 available, uint256 required);

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    /// @param name_ Token name.
    /// @param symbol_ Token symbol.
    /// @param initialSupply Units minted to the deployer at construction (6 decimals).
    constructor(string memory name_, string memory symbol_, uint256 initialSupply) {
        if (msg.sender == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        minter = msg.sender;
        _mint(msg.sender, initialSupply);
    }

    /// @notice Mint `amount` units to `to`; only the deployer may call.
    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert OnlyMinter(msg.sender);
        _mint(to, amount);
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert ZeroAddress();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[sender][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance(sender, msg.sender, allowed, amount);
            unchecked {
                allowance[sender][msg.sender] = allowed - amount;
            }
        }
        _transfer(sender, recipient, amount);
        return true;
    }

    function _mint(address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address sender, address recipient, uint256 amount) internal {
        if (sender == address(0) || recipient == address(0)) revert ZeroAddress();
        uint256 available = balanceOf[sender];
        if (available < amount) revert InsufficientBalance(sender, available, amount);
        unchecked {
            balanceOf[sender] = available - amount;
            balanceOf[recipient] += amount;
        }
        emit Transfer(sender, recipient, amount);
    }
}
