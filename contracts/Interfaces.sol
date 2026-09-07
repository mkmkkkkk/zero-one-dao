// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Minimal {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

interface IERC20Metadata is IERC20Minimal {
    function decimals() external view returns (uint8);
}

/// @notice Zero One share token surface used by the shamans.
interface INavShareToken is IERC20Minimal {
    function baal() external view returns (address);
    function safe() external view returns (address);
    function settlementToken() external view returns (address);
    function treasuryValue() external view returns (uint256);
    function navSharesFor(uint256 contributedValue) external view returns (uint256);
    function navValueForShares(uint256 shares) external view returns (uint256);
    function getVotes(address account) external view returns (uint256);
    function getPastVotes(address account, uint256 timePoint) external view returns (uint256);
}

/// @notice Narrow ABI of audited @daohaus/baal-contracts 1.2.18 used by Zero One.
interface IBaalV3 {
    function avatar() external view returns (address);
    function target() external view returns (address);
    function sharesToken() external view returns (address);
    function lootToken() external view returns (address);
    function shamans(address shaman) external view returns (uint256);
    function isManager(address shaman) external view returns (bool);
    function votingPeriod() external view returns (uint32);
    function gracePeriod() external view returns (uint32);
    function sponsorThreshold() external view returns (uint256);
    function totalShares() external view returns (uint256);

    function mintShares(address[] calldata to, uint256[] calldata amount) external;
    function burnShares(address[] calldata from, uint256[] calldata amount) external;
    function setShamans(address[] calldata shamans_, uint256[] calldata permissions) external;
    function setGovernanceConfig(bytes calldata governanceConfig) external;

    function encodeMultisend(bytes[] calldata calls, address target) external pure returns (bytes memory);
    function submitProposal(
        bytes calldata proposalData,
        uint32 expiration,
        uint256 baalGas,
        string calldata details
    ) external payable returns (uint256);
    function sponsorProposal(uint32 id) external;
    function submitVote(uint32 id, bool approved) external;
    function processProposal(uint32 id, bytes calldata proposalData) external;
    function cancelProposal(uint32 id) external;
    function ragequit(address to, uint256 sharesToBurn, uint256 lootToBurn, address[] calldata tokens) external;
    function state(uint32 id) external view returns (uint8);
}

interface IDepositShaman {
    function deposit(uint256 amount) external returns (uint256 sharesMinted);
    function settlementToken() external view returns (address);
}

interface IWorkManager {
    function submitTask(
        address[] calldata verifiers,
        uint16 verifierThreshold,
        uint256 rewardValue,
        uint32 expiration,
        string calldata details
    ) external payable returns (uint256 taskId, uint256 proposalId);
    function claim(uint256 taskId) external;
    function deliver(uint256 taskId, bytes32 evidenceHash) external;
    function confirm(uint256 taskId, bytes calldata evidence) external;
}
