// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IBaalV3, IDepositShaman, IERC20Minimal, IWorkManager} from "./Interfaces.sol";

/// @notice EIP-7702 account code for Zero One members. Each EOA verifies its own EIP-712 intent, so a
/// relay can sponsor gas without gaining any authority over the account.
/// @dev Derived from agent-only-wallet/exit AowIntentAccount, retargeted to Baal-native verbs.
/// No admin, no arbitrary call, no delegation opcode, no sponsor authority. Ops:
/// 0 propose | 1 sponsor | 2 vote | 3 execute (processProposal) | 4 ragequit | 5 deposit |
/// 6 task (submitTask) | 7 claim | 8 deliver | 9 confirm.
contract ZeroOneIntentAccount {
    struct Intent {
        address member;
        uint8 op;
        uint32 proposalId;
        uint256 amount;
        bytes32 evidenceHash;
        bytes data;
        string details;
        uint256 nonce;
        uint256 deadline;
    }

    struct AccountState {
        uint256 nonce;
        bool entered;
    }

    bytes32 private constant SLOT = keccak256("zero-one.intent.account.storage.v1");
    bytes32 public constant TYPEHASH = keccak256(
        "Intent(address member,uint8 op,uint32 proposalId,uint256 amount,bytes32 evidenceHash,bytes data,string details,uint256 nonce,uint256 deadline)"
    );

    address public immutable adapter;
    uint256 public immutable chainId;
    IBaalV3 public immutable baal;
    IERC20Minimal public immutable settlementToken;
    IDepositShaman public immutable depositShaman;
    IWorkManager public immutable workManager;

    event IntentExecuted(address indexed member, uint256 indexed nonce, uint8 op, bytes32 result);

    constructor(IBaalV3 baal_, IDepositShaman depositShaman_, IWorkManager workManager_) {
        adapter = address(this);
        chainId = block.chainid;
        baal = baal_;
        depositShaman = depositShaman_;
        settlementToken = IERC20Minimal(depositShaman_.settlementToken());
        workManager = workManager_;
    }

    function _state() private pure returns (AccountState storage st) {
        bytes32 slot = SLOT;
        assembly {
            st.slot := slot
        }
    }

    /// @notice Current intent nonce of this account.
    function accountNonce() external view returns (uint256) {
        return _state().nonce;
    }

    /// @notice EIP-712 digest the member signs for `i`.
    function digest(Intent calldata i) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ZeroOneIntent"),
                keccak256("1"),
                block.chainid,
                adapter
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                TYPEHASH,
                i.member,
                i.op,
                i.proposalId,
                i.amount,
                i.evidenceHash,
                keccak256(i.data),
                keccak256(bytes(i.details)),
                i.nonce,
                i.deadline
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domain, structHash));
    }

    /// @notice Execute a signed intent on behalf of this account (msg.sender may be anyone).
    function executeIntent(Intent calldata i, bytes calldata signature) external payable returns (bytes32 result) {
        require(block.chainid == chainId && address(this) != adapter && i.member == address(this), "account");
        AccountState storage st = _state();
        require(!st.entered, "reentered");
        require(i.nonce == st.nonce && block.timestamp <= i.deadline, "nonce/expiry");
        require(ECDSA.recover(digest(i), signature) == address(this), "signature");
        st.entered = true;
        st.nonce++;
        if (i.op == 0) {
            result = bytes32(baal.submitProposal{value: msg.value}(i.data, uint32(i.amount), 0, i.details));
        } else if (i.op == 1) {
            baal.sponsorProposal(i.proposalId);
        } else if (i.op == 2) {
            baal.submitVote(i.proposalId, i.amount != 0);
        } else if (i.op == 3) {
            baal.processProposal(i.proposalId, i.data);
        } else if (i.op == 4) {
            address[] memory tokens = abi.decode(i.data, (address[]));
            baal.ragequit(address(this), i.amount, 0, tokens);
        } else if (i.op == 5) {
            require(settlementToken.approve(address(depositShaman), i.amount), "approve");
            result = bytes32(depositShaman.deposit(i.amount));
        } else if (i.op == 6) {
            (address[] memory verifiers, uint16 threshold, uint256 reward, uint32 expiration) =
                abi.decode(i.data, (address[], uint16, uint256, uint32));
            (uint256 taskId,) = workManager.submitTask{value: msg.value}(verifiers, threshold, reward, expiration, i.details);
            result = bytes32(taskId);
        } else if (i.op == 7) {
            workManager.claim(i.amount);
        } else if (i.op == 8) {
            workManager.deliver(i.amount, i.evidenceHash);
        } else if (i.op == 9) {
            workManager.confirm(i.amount, i.data);
        } else {
            revert("op");
        }
        st.entered = false;
        emit IntentExecuted(address(this), i.nonce, i.op, result);
    }
}
