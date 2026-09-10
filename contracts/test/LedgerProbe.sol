// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryLedger} from "../TreasuryLedger.sol";
import {IProposalContract} from "../IProposalContract.sol";
import {IBaalV3, IERC20Minimal, IDepositShaman} from "../Interfaces.sol";

/// @notice Local-only scenario L probe: atomic deposit/exit and an unregistered caller.
contract LedgerProbe {
    event RoundTrip(uint256 beforeBalance, uint256 deposited, uint256 minted, uint256 afterBalance);

    function status() external pure returns (IProposalContract.Status) { return IProposalContract.Status.Running; }
    function ledgerAsset() external pure returns (address) { return address(0); }
    function spoofOpen(TreasuryLedger ledger) external { ledger.open(); }
    function spoofClose(TreasuryLedger ledger) external { ledger.close(); }

    function roundTrip(IDepositShaman shaman, IBaalV3 baal, uint256 amount) external {
        IERC20Minimal token = IERC20Minimal(shaman.settlementToken());
        uint256 beforeBalance = token.balanceOf(address(this));
        require(token.approve(address(shaman), amount), "approve");
        uint256 minted = shaman.deposit(amount);
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        baal.ragequit(address(this), minted, 0, tokens);
        uint256 afterBalance = token.balanceOf(address(this));
        require(afterBalance == beforeBalance, "nonzero round trip");
        emit RoundTrip(beforeBalance, amount, minted, afterBalance);
    }
}
