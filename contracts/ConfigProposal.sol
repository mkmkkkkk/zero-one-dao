// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBaalV3} from "./Interfaces.sol";
import {ProposalBase} from "./ProposalBase.sol";

/// @notice Config template (DESIGN.md §7.5): change Baal's governance parameters by proposal.
/// @dev Baal.setGovernanceConfig is callable only by the Safe (avatar) or a governor shaman, so the
/// voted multicall is [Baal.setGovernanceConfig(governanceConfig()), start()] executed by the Safe;
/// start() then reads every parameter back and reverts unless Baal holds exactly the voted values,
/// which fails the whole action atomically. No settlement is involved; budget = 0.
/// params = abi.encode(Config). No operational role for the proposer.
contract ConfigProposal is ProposalBase {
    struct Config {
        uint32 votingPeriod;
        uint32 gracePeriod;
        uint256 proposalOffering;
        uint256 quorumPercent;
        uint256 sponsorThreshold;
        uint256 minRetentionPercent;
    }

    IBaalV3 public immutable baal;
    Config public config;

    error NotApplied(string parameter);
    error NotApplicable();

    /// @param safe_ The treasury Safe.
    /// @param settlement_ The settlement ERC-20 (unused; kept for the common surface).
    /// @param operator_ The proposer (recorded; no role).
    /// @param baal_ The Baal whose parameters change.
    /// @param config_ The voted governance parameters.
    constructor(address safe_, address settlement_, address operator_, IBaalV3 baal_, Config memory config_)
        ProposalBase(safe_, settlement_, operator_)
    {
        if (address(baal_) == address(0)) revert ZeroAddress();
        baal = baal_;
        _set(config_);
    }

    /// @inheritdoc ProposalBase
    function template() public pure override returns (string memory) {
        return "Config";
    }

    /// @notice The exact bytes for Baal.setGovernanceConfig.
    function governanceConfig() public view returns (bytes memory) {
        Config memory c = config;
        return abi.encode(c.votingPeriod, c.gracePeriod, c.proposalOffering, c.quorumPercent, c.sponsorThreshold, c.minRetentionPercent);
    }

    /// @dev Verify Baal now holds the voted values; ends Complete.
    function _start() internal override {
        Config memory c = config;
        if (baal.votingPeriod() != c.votingPeriod) revert NotApplied("votingPeriod");
        if (baal.gracePeriod() != c.gracePeriod) revert NotApplied("gracePeriod");
        if (baal.proposalOffering() != c.proposalOffering) revert NotApplied("proposalOffering");
        if (baal.quorumPercent() != c.quorumPercent) revert NotApplied("quorumPercent");
        if (baal.sponsorThreshold() != c.sponsorThreshold) revert NotApplied("sponsorThreshold");
        if (baal.minRetentionPercent() != c.minRetentionPercent) revert NotApplied("minRetentionPercent");
        _complete();
    }

    /// @dev No money in a Config proposal.
    function _topUp(uint256) internal pure override {
        revert NotApplicable();
    }

    /// @dev Replace the parameters before start.
    function _amend(bytes calldata params) internal override {
        _requireStatus(Status.Pending);
        _set(abi.decode(params, (Config)));
    }

    function _set(Config memory config_) private {
        config = config_;
        paramsHash = keccak256(abi.encode(config_));
    }
}
