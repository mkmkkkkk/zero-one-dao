// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {IBaalV3, IERC20Minimal} from "./Interfaces.sol";
import {IProposalContract} from "./IProposalContract.sol";
import {ConfigProposal} from "./ConfigProposal.sol";
import {PaymentProposal} from "./PaymentProposal.sol";
import {ProjectProposal} from "./ProjectProposal.sol";
import {StrategyProposal} from "./StrategyProposal.sol";

/// @notice One CREATE2 deployer per template. The instance address is a pure function of
/// (deployer, salt, template creation code, safe, settlement, member, params): nobody, the relay
/// included, can put different code at the address a member signed for (decision.md phase 2b ruling 2).
interface ITemplateDeployer {
    /// @notice Template name ("Payment", "Strategy", "Project", "Config").
    function template() external pure returns (string memory);

    /// @notice The exact creation code + constructor arguments an instance is created from.
    function initCode(address member, bytes calldata params) external view returns (bytes memory);

    /// @notice The CREATE2 address of the instance for (member, params, salt).
    function predict(address member, bytes calldata params, bytes32 salt) external view returns (address);

    /// @notice Deploy the instance at `predict(member, params, salt)`; reverts if that address has code.
    function deploy(address member, bytes calldata params, bytes32 salt) external returns (address);
}

/// @dev Shared CREATE2 plumbing; each concrete deployer supplies the template's init code.
abstract contract TemplateDeployer is ITemplateDeployer {
    address public immutable safe;
    address public immutable settlement;

    error ZeroAddress();

    /// @param safe_ The treasury Safe (owner of every instance).
    /// @param settlement_ The settlement ERC-20 (USDC).
    constructor(address safe_, address settlement_) {
        if (safe_ == address(0) || settlement_ == address(0)) revert ZeroAddress();
        safe = safe_;
        settlement = settlement_;
    }

    /// @inheritdoc ITemplateDeployer
    function initCode(address member, bytes calldata params) public view virtual returns (bytes memory);

    /// @inheritdoc ITemplateDeployer
    function predict(address member, bytes calldata params, bytes32 salt) external view returns (address) {
        return Create2.computeAddress(salt, keccak256(initCode(member, params)), address(this));
    }

    /// @inheritdoc ITemplateDeployer
    /// @dev CREATE2 in assembly so a constructor revert (e.g. a template's ZeroAmount) bubbles up
    /// with its own data instead of a generic "failed on deploy".
    function deploy(address member, bytes calldata params, bytes32 salt) external returns (address instance) {
        bytes memory code = initCode(member, params);
        assembly ("memory-safe") {
            instance := create2(0, add(code, 0x20), mload(code), salt)
            if iszero(instance) {
                let size := returndatasize()
                returndatacopy(0, 0, size)
                revert(0, size)
            }
        }
    }
}

/// @notice CREATE2 deployer of PaymentProposal; params = abi.encode(address[] recipients, uint256[] amounts).
contract PaymentDeployer is TemplateDeployer {
    constructor(address safe_, address settlement_) TemplateDeployer(safe_, settlement_) {}

    /// @inheritdoc ITemplateDeployer
    function template() external pure returns (string memory) {
        return "Payment";
    }

    /// @inheritdoc ITemplateDeployer
    function initCode(address member, bytes calldata params) public view override returns (bytes memory) {
        (address[] memory recipients, uint256[] memory amounts) = abi.decode(params, (address[], uint256[]));
        return abi.encodePacked(type(PaymentProposal).creationCode, abi.encode(safe, settlement, member, recipients, amounts));
    }
}

/// @notice CREATE2 deployer of StrategyProposal; params = abi.encode(address venue, address asset, uint256 budget, Rule rule).
contract StrategyDeployer is TemplateDeployer {
    constructor(address safe_, address settlement_) TemplateDeployer(safe_, settlement_) {}

    /// @inheritdoc ITemplateDeployer
    function template() external pure returns (string memory) {
        return "Strategy";
    }

    /// @inheritdoc ITemplateDeployer
    function initCode(address member, bytes calldata params) public view override returns (bytes memory) {
        (address venue, address asset, uint256 budget, StrategyProposal.Rule memory rule) =
            abi.decode(params, (address, address, uint256, StrategyProposal.Rule));
        return abi.encodePacked(type(StrategyProposal).creationCode, abi.encode(safe, settlement, member, venue, asset, budget, rule));
    }
}

/// @notice CREATE2 deployer of ProjectProposal; params = abi.encode(Tranche[] tranches, uint256 deadline).
contract ProjectDeployer is TemplateDeployer {
    constructor(address safe_, address settlement_) TemplateDeployer(safe_, settlement_) {}

    /// @inheritdoc ITemplateDeployer
    function template() external pure returns (string memory) {
        return "Project";
    }

    /// @inheritdoc ITemplateDeployer
    function initCode(address member, bytes calldata params) public view override returns (bytes memory) {
        (ProjectProposal.Tranche[] memory tranches, uint256 deadline) = abi.decode(params, (ProjectProposal.Tranche[], uint256));
        return abi.encodePacked(type(ProjectProposal).creationCode, abi.encode(safe, settlement, member, tranches, deadline));
    }
}

/// @notice CREATE2 deployer of ConfigProposal; params = abi.encode(Config config).
contract ConfigDeployer is TemplateDeployer {
    IBaalV3 public immutable baal;

    /// @param baal_ The Baal whose governance parameters a Config instance verifies.
    constructor(address safe_, address settlement_, IBaalV3 baal_) TemplateDeployer(safe_, settlement_) {
        if (address(baal_) == address(0)) revert ZeroAddress();
        baal = baal_;
    }

    /// @inheritdoc ITemplateDeployer
    function template() external pure returns (string memory) {
        return "Config";
    }

    /// @inheritdoc ITemplateDeployer
    function initCode(address member, bytes calldata params) public view override returns (bytes memory) {
        ConfigProposal.Config memory config = abi.decode(params, (ConfigProposal.Config));
        return abi.encodePacked(type(ConfigProposal).creationCode, abi.encode(safe, settlement, member, baal, config));
    }
}

/// @notice The template factory agents and the intent account use (decision.md phase 2b rulings 2, 3):
/// `deploy` puts the template instance for (template, params, member, salt) at its deterministic
/// address (idempotent: an existing instance is returned, never redeployed), and `proposalData`
/// builds the exact Baal multicall that funds and starts that instance, so a member signs only the
/// template id, the parameters and a salt, and the account derives everything else on-chain.
/// @dev Template ids: 0 Payment, 1 Strategy, 2 Project, 3 Config. Permissionless by design: whoever
/// deploys, the code and the operator (`member`) are fixed by the arguments. The relay sponsors
/// deployments only for members holding >= sponsorThreshold (relay policy, not code).
contract TemplateFactory {
    address public immutable safe;
    IERC20Minimal public immutable settlement;
    IBaalV3 public immutable baal;
    ITemplateDeployer public immutable paymentDeployer;
    ITemplateDeployer public immutable strategyDeployer;
    ITemplateDeployer public immutable projectDeployer;
    ITemplateDeployer public immutable configDeployer;

    /// @dev Gnosis MultiSend.multiSend(bytes) selector; Baal executes proposalData through MultiSend.
    bytes4 private constant MULTISEND = 0x8d80ff0a;
    uint8 public constant TEMPLATE_COUNT = 4;

    error ZeroAddress();
    error UnknownTemplate(uint8 template);
    error DeployerMismatch(address deployer, string expected);
    error AddressMismatch(address predicted, address deployed);

    event InstanceDeployed(
        uint8 indexed template, address indexed instance, address indexed member, bytes32 paramsHash, bytes32 salt, bytes32 codeHash
    );

    /// @param safe_ The treasury Safe.
    /// @param settlement_ The settlement ERC-20 (USDC).
    /// @param baal_ The DAO's Baal.
    /// @param deployers_ [Payment, Strategy, Project, Config] deployers bound to the same Safe and settlement.
    constructor(address safe_, address settlement_, IBaalV3 baal_, ITemplateDeployer[4] memory deployers_) {
        if (safe_ == address(0) || settlement_ == address(0) || address(baal_) == address(0)) revert ZeroAddress();
        safe = safe_;
        settlement = IERC20Minimal(settlement_);
        baal = baal_;
        string[4] memory names = ["Payment", "Strategy", "Project", "Config"];
        for (uint256 i; i < 4; ++i) {
            ITemplateDeployer deployer_ = deployers_[i];
            if (address(deployer_) == address(0)) revert ZeroAddress();
            if (keccak256(bytes(deployer_.template())) != keccak256(bytes(names[i]))) revert DeployerMismatch(address(deployer_), names[i]);
        }
        paymentDeployer = deployers_[0];
        strategyDeployer = deployers_[1];
        projectDeployer = deployers_[2];
        configDeployer = deployers_[3];
    }

    /// @notice Deployer of a template id.
    function deployer(uint8 template) public view returns (ITemplateDeployer) {
        if (template == 0) return paymentDeployer;
        if (template == 1) return strategyDeployer;
        if (template == 2) return projectDeployer;
        if (template == 3) return configDeployer;
        revert UnknownTemplate(template);
    }

    /// @notice Template name of a template id.
    function templateName(uint8 template) external view returns (string memory) {
        return deployer(template).template();
    }

    /// @notice The instance address for (template, params, member, salt), deployed or not.
    function predict(uint8 template, bytes calldata params, address member, bytes32 salt) public view returns (address) {
        return deployer(template).predict(member, params, salt);
    }

    /// @notice Deploy the instance if absent; returns its address and runtime code hash either way.
    /// @param template Template id.
    /// @param params abi.encode(params) exactly as the template hashes into `paramsHash`.
    /// @param member The proposer; becomes the instance's `operator`.
    /// @param salt Distinguishes otherwise identical proposals (the relay uses the member's intent nonce).
    /// @return instance The deterministic instance address.
    /// @return codeHash keccak256 of the runtime code at `instance` (immutables included).
    function deploy(uint8 template, bytes calldata params, address member, bytes32 salt) public returns (address instance, bytes32 codeHash) {
        if (member == address(0)) revert ZeroAddress();
        ITemplateDeployer d = deployer(template);
        instance = d.predict(member, params, salt);
        if (instance.code.length == 0) {
            address deployed = d.deploy(member, params, salt);
            if (deployed != instance) revert AddressMismatch(instance, deployed);
            codeHash = instance.codehash;
            emit InstanceDeployed(template, instance, member, keccak256(params), salt, codeHash);
        } else {
            codeHash = instance.codehash;
        }
    }

    /// @notice The exact Baal proposalData (MultiSend calldata) that funds and starts `instance`:
    /// `[settlement.transfer(instance, budget), instance.start()]`, the transfer omitted when budget
    /// is 0; for Config `[baal.setGovernanceConfig(params), instance.start()]` (docs/TEMPLATES.md).
    /// @param template Template id.
    /// @param params The instance's params bytes (used by Config).
    /// @param instance A deployed instance.
    function proposalData(uint8 template, bytes calldata params, address instance) public view returns (bytes memory) {
        bytes memory packed;
        if (template == 3) {
            packed = _pack(address(baal), abi.encodeWithSelector(IBaalV3.setGovernanceConfig.selector, params));
        } else {
            (,,, uint256 budget,,) = IProposalContract(instance).describe();
            if (budget != 0) packed = _pack(address(settlement), abi.encodeWithSelector(IERC20Minimal.transfer.selector, instance, budget));
        }
        packed = abi.encodePacked(packed, _pack(instance, abi.encodeWithSelector(IProposalContract.start.selector)));
        return abi.encodeWithSelector(MULTISEND, packed);
    }

    /// @notice Dry run for agents (call with eth_call): deploy if absent and describe the result.
    /// @return instance The instance address.
    /// @return codeHash keccak256 of its runtime code.
    /// @return paramsHash keccak256(params) as the instance reports it.
    /// @return budget Settlement the Safe will transfer on pass.
    /// @return deadline The instance's deadline (0 = none).
    /// @return data The proposalData the account will submit.
    function quote(uint8 template, bytes calldata params, address member, bytes32 salt)
        external
        returns (address instance, bytes32 codeHash, bytes32 paramsHash, uint256 budget, uint256 deadline, bytes memory data)
    {
        (instance, codeHash) = deploy(template, params, member, salt);
        (, paramsHash,, budget, deadline,) = IProposalContract(instance).describe();
        data = proposalData(template, params, instance);
    }

    /// @dev One MultiSend transaction: operation 0 | to | value 0 | data length | data.
    function _pack(address to, bytes memory data) private pure returns (bytes memory) {
        return abi.encodePacked(uint8(0), to, uint256(0), data.length, data);
    }
}
