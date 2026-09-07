// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Baal loot token. Zero One mints no loot; Baal only requires the token to exist.
/// @dev Mint and burn are accepted only from the immutable Baal. Supply stays zero unless a passed
/// proposal installs a manager shaman that mints loot; nothing in code forbids that.
contract LootToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    address public immutable baal;
    uint256 public totalSupply;

    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    error OnlyBaal(address caller);
    error ZeroAddress();
    error PermanentlyUnpaused();
    error InsufficientBalance(address account, uint256 available, uint256 required);
    error InsufficientAllowance(address owner, address spender, uint256 available, uint256 required);

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    modifier onlyBaal() {
        if (msg.sender != baal) revert OnlyBaal(msg.sender);
        _;
    }

    constructor(string memory name_, string memory symbol_, address baal_) {
        if (baal_ == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        baal = baal_;
    }

    function paused() external pure returns (bool) {
        return false;
    }

    function pause() external pure {
        revert PermanentlyUnpaused();
    }

    function unpause() external pure {
        revert PermanentlyUnpaused();
    }

    function mint(address recipient, uint256 amount) external onlyBaal {
        if (recipient == address(0)) revert ZeroAddress();
        totalSupply += amount;
        balanceOf[recipient] += amount;
        emit Transfer(address(0), recipient, amount);
    }

    function burn(address account, uint256 amount) external onlyBaal {
        uint256 available = balanceOf[account];
        if (available < amount) revert InsufficientBalance(account, available, amount);
        unchecked {
            balanceOf[account] = available - amount;
            totalSupply -= amount;
        }
        emit Transfer(account, address(0), amount);
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
            if (available < amount) revert InsufficientAllowance(sender, msg.sender, available, amount);
            unchecked {
                allowance[sender][msg.sender] = available - amount;
            }
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
