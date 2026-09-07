// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Zero-value devnet settlement asset mirroring USDC (6 decimals) with simple ERC20 semantics.
/// @dev Mirror stand-in for Base USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, see
/// docs/PARAMETERS.md). Supply is minted once in the constructor. There is no owner, later mint,
/// burn, pause, rebase, fee, hook, permit, blacklist, upgrade, or recovery mechanism.
contract TestToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    uint256 public immutable totalSupply;

    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    error ZeroAddress();
    error InsufficientBalance(address account, uint256 available, uint256 required);
    error InsufficientAllowance(address owner, address spender, uint256 available, uint256 required);

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(string memory name_, string memory symbol_, uint256 fixedSupply) {
        if (msg.sender == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        totalSupply = fixedSupply;
        balanceOf[msg.sender] = fixedSupply;
        emit Transfer(address(0), msg.sender, fixedSupply);
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
        uint256 available = allowance[sender][msg.sender];
        if (available != type(uint256).max) {
            if (available < amount) {
                revert InsufficientAllowance(sender, msg.sender, available, amount);
            }
            unchecked {
                allowance[sender][msg.sender] = available - amount;
            }
            emit Approval(sender, msg.sender, allowance[sender][msg.sender]);
        }
        _transfer(sender, recipient, amount);
        return true;
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
