// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IBaalV3, IDepositShaman, IERC20Minimal, IWorkManager} from "./Interfaces.sol";
import {TemplateFactory} from "./TemplateFactory.sol";

/// @notice EIP-7702 account code for Zero One members. Each EOA verifies its own EIP-712 intent, so a
/// relay can sponsor gas without gaining any authority over the account.
/// @dev Derived from agent-only-wallet/exit AowIntentAccount, retargeted to Baal-native verbs.
/// No admin, no arbitrary call, no delegation opcode, no sponsor authority. Ops:
/// 0 propose (template id + params + salt -> TemplateFactory.deploy if absent -> Baal.submitProposal
/// of the factory-built fund+start multicall; decision.md phase 2b ruling 2) | 2 vote | 3 execute
/// (processProposal) | 4 ragequit | 5 deposit | 6 work (submitTask, then sponsorProposal in the same
/// transaction; ruling 4) | 7 claim | 8 deliver | 9 confirm. Op 1 (sponsor) no longer exists.
/// Op 0 baalGas (phase 5 ruling 1): the intent's `proposalId` field (unused by op 0 otherwise) carries the
/// baalGas the relay simulated (action need x 1.5, at most 8,000,000); 0 selects DEFAULT_BAAL_GAS, which
/// covers every template start the mirror measures (< 1.3 M) with the same margin.
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
    /// @notice baalGas of an op 0 proposal whose intent carries no explicit value.
    uint256 public constant DEFAULT_BAAL_GAS = 2_000_000;
    bytes32 public constant TYPEHASH = keccak256(
        "Intent(address member,uint8 op,uint32 proposalId,uint256 amount,bytes32 evidenceHash,bytes data,string details,uint256 nonce,uint256 deadline)"
    );

    address public immutable adapter;
    uint256 public immutable chainId;
    IBaalV3 public immutable baal;
    IERC20Minimal public immutable settlementToken;
    IDepositShaman public immutable depositShaman;
    IWorkManager public immutable workManager;
    TemplateFactory public immutable factory;

    event IntentExecuted(address indexed member, uint256 indexed nonce, uint8 op, bytes32 result);

    constructor(IBaalV3 baal_, IDepositShaman depositShaman_, IWorkManager workManager_, TemplateFactory factory_) {
        require(address(factory_) != address(0), "factory");
        adapter = address(this);
        chainId = block.chainid;
        baal = baal_;
        depositShaman = depositShaman_;
        settlementToken = IERC20Minimal(depositShaman_.settlementToken());
        workManager = workManager_;
        factory = factory_;
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
            // data = abi.encode(uint8 template, bytes params, bytes32 salt); amount = expiration (0 = none).
            (uint8 template, bytes memory params, bytes32 salt) = abi.decode(i.data, (uint8, bytes, bytes32));
            (address instance,) = factory.deploy(template, params, address(this), salt);
            bytes memory proposalData = factory.proposalData(template, params, instance);
            uint256 baalGas = i.proposalId == 0 ? DEFAULT_BAAL_GAS : uint256(i.proposalId);
            result = bytes32(baal.submitProposal{value: msg.value}(proposalData, uint32(i.amount), baalGas, i.details));
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
            (address[] memory verifiers, uint16 threshold, uint256 rewardShares, uint32 expiration) =
                abi.decode(i.data, (address[], uint16, uint256, uint32));
            (uint256 taskId, uint256 proposalId) =
                workManager.submitTask{value: msg.value}(verifiers, threshold, rewardShares, expiration, i.details);
            baal.sponsorProposal(uint32(proposalId));
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
