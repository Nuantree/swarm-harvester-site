// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LaunchToken} from "src/LaunchToken.sol";
import {SwarmHarvester} from "src/SwarmHarvester.sol";
import {SwarmSeller} from "src/SwarmSeller.sol";
import {MockToken} from "./mocks/MockToken.sol";
import {MockDistributor} from "./mocks/MockDistributor.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// @dev All token funding occurs at setup. The handler cannot mint during a sequence.
/// Pool output is measured independently at the real manager; wallet debits and
/// allowance consumption are predicted before each call, including refunded rows.
contract SwarmLifecycleHandler is Test, IUnlockCallback {
    LaunchToken public token;
    MockToken public imd;
    PoolManager public manager;
    SwarmSeller public seller;
    SwarmHarvester public harvester;
    MockDistributor public distributor;
    address[4] public actors;
    uint256[4] public expectedInput;
    uint256[4] public expectedOutput;
    uint256[4] public expectedAllowance;
    bool[4][8] public claimed;
    uint256 public allocated;
    uint256 public claimedTotal;
    uint256 public spentTotal;
    uint256 public grossTotal;
    uint256 public burnedTotal;
    uint256 public managerInputAtSetup;
    uint256 public managerOutputAtSetup;
    uint256 public managerNativeAtSetup;
    uint256 public holderInputAtSetup;
    uint256 public holderOutputAtSetup;
    uint256 public successfulBatches;
    uint256 public revertedBatches;
    uint256 public successfulClaims;
    bool private initialized;

    function initialize() external {
        require(!initialized, "already initialized");
        initialized = true;
        token = new LaunchToken();
        imd = new MockToken();
        manager = new PoolManager(address(this));
        seller = new SwarmSeller(address(manager), address(imd));
        harvester = new SwarmHarvester();
        distributor = new MockDistributor(address(token));
        imd.mint(address(this), 1e30);
        vm.deal(address(this), 1e26);
        _seed(_key(address(token), address(imd)));
        _seed(_key(address(0), address(token)));
        _seed(_key(address(0), address(imd)));

        for (uint256 i; i < 4; ++i) {
            actors[i] = makeAddr(string.concat("lifecycle wallet ", vm.toString(i)));
            token.transfer(actors[i], 1e24);
            expectedInput[i] = 1e24;
            expectedAllowance[i] = type(uint256).max;
            vm.prank(actors[i]);
            token.approve(address(seller), type(uint256).max);
        }
        for (uint256 round; round < 8; ++round) {
            bytes32[4] memory leaves = _leaves(round);
            distributor.setRoot(round, _pair(_pair(leaves[0], leaves[1]), _pair(leaves[2], leaves[3])));
            for (uint256 i; i < 4; ++i) {
                allocated += _entitlement(round, i);
            }
        }
        token.transfer(address(distributor), allocated);
        managerInputAtSetup = token.balanceOf(address(manager));
        managerOutputAtSetup = imd.balanceOf(address(manager));
        managerNativeAtSetup = address(manager).balance;
        holderInputAtSetup = token.balanceOf(address(this));
        holderOutputAtSetup = imd.balanceOf(address(this));
    }

    function approve(uint256 actorSeed, uint256 amountSeed, uint8 mode) external {
        uint256 actor = actorSeed % 4;
        uint256 amount = mode % 3 == 0 ? 0 : mode % 3 == 1 ? bound(amountSeed, 0, 2e20) : type(uint256).max;
        vm.prank(actors[actor]);
        token.approve(address(seller), amount);
        expectedAllowance[actor] = amount;
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amountSeed) external {
        uint256 from = fromSeed % 4;
        uint256 to = toSeed % 4;
        uint256 amount = bound(amountSeed, 0, expectedInput[from]);
        vm.prank(actors[from]);
        token.transfer(actors[to], amount);
        expectedInput[from] -= amount;
        expectedInput[to] += amount;
    }

    function harvest(uint256 actorSeed, uint256 roundSeed, uint256 keeperSeed, bool corrupt) external {
        uint256 actor = actorSeed % 4;
        uint256 round = roundSeed % 8;
        uint256 amount = _entitlement(round, actor);
        bytes32[4] memory leaves = _leaves(round);
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = leaves[actor ^ 1];
        proof[1] = actor < 2 ? _pair(leaves[2], leaves[3]) : _pair(leaves[0], leaves[1]);
        SwarmHarvester.Claim[] memory claims = new SwarmHarvester.Claim[](2);
        claims[0] = SwarmHarvester.Claim(address(distributor), round, actors[actor], amount + (corrupt ? 1 : 0), proof);
        claims[1] = claims[0]; // A replay in the same batch must never pay twice.
        bool pays = !corrupt && !claimed[round][actor];
        vm.prank(actors[keeperSeed % 4]);
        assertEq(harvester.claimMany(claims), pays ? 1 : 0, "claim/replay result");
        if (pays) {
            claimed[round][actor] = true;
            expectedInput[actor] += amount;
            claimedTotal += amount;
            ++successfulClaims;
        }
    }

    /// @dev Modes: both succeed; missing first pool; impossible first minimum;
    /// missing second-hop pool. Aggregate rejection must restore both rows.
    function sellBatch(
        uint256 actorSeed,
        uint256 recipientSeed,
        uint256 amountSeed,
        uint8 modeSeed,
        bool viaEth,
        bool rejectAggregate
    ) external {
        uint256 actor = actorSeed % 4;
        uint256 recipient = recipientSeed % 4;
        uint8 mode = modeSeed % 4;
        uint256 amount = bound(amountSeed, 100, 1e20);
        SwarmSeller.Sale[] memory sales = new SwarmSeller.Sale[](2);
        sales[0] = _sale(amount, viaEth);
        sales[1] = _sale(amount + 1, !viaEth);
        if (mode == 1) sales[0].route[0].fee = 500; // Not initialized.
        if (mode == 2) sales[0].minOut = type(uint256).max;
        if (mode == 3) {
            sales[1] = _sale(amount + 1, true);
            sales[1].route[1].fee = 500;
        }

        (uint256 spent, uint256 allowanceAfter) = _predict(actor, amount, mode);
        uint256 poolOutputBefore = imd.balanceOf(address(manager));
        if (rejectAggregate) {
            vm.prank(actors[actor]);
            vm.expectRevert(SwarmSeller.MinimumOutputNotMet.selector);
            seller.sellMany(sales, actors[recipient], type(uint256).max, block.timestamp);
            ++revertedBatches;
            assertEq(imd.balanceOf(address(manager)), poolOutputBefore, "aggregate rollback");
        } else {
            vm.prank(actors[actor]);
            uint256 net = seller.sellMany(sales, actors[recipient], 0, block.timestamp);
            uint256 gross = poolOutputBefore - imd.balanceOf(address(manager));
            uint256 fee = gross * 50 / 10_000;
            assertEq(net, gross - fee, "reported net differs from settled value");
            if (spent != 0) {
                assertGt(gross, 0, "funded valid sale must execute");
                ++successfulBatches;
            } else {
                assertEq(gross, 0, "failed rows paid output");
            }
            expectedInput[actor] -= spent;
            expectedAllowance[actor] = allowanceAfter;
            expectedOutput[recipient] += gross - fee;
            spentTotal += spent;
            grossTotal += gross;
            burnedTotal += fee;
        }
        // Read transient storage before the handler transaction ends, so clearing
        // transient storage between transactions cannot hide unsettled deltas.
        _assertSettled();
    }

    function _predict(uint256 actor, uint256 amount, uint8 mode)
        private
        view
        returns (uint256 spent, uint256 allowanceAfter)
    {
        uint256 balance = expectedInput[actor];
        allowanceAfter = expectedAllowance[actor];
        for (uint256 i; i < 2; ++i) {
            uint256 input = amount + i;
            if (input > allowanceAfter || input > balance) continue;
            if (allowanceAfter != type(uint256).max) allowanceAfter -= input;
            bool refunds = i == 0 ? mode == 1 || mode == 2 : mode == 3;
            if (!refunds) {
                balance -= input;
                spent += input;
            }
        }
    }

    function assertConservation() external view {
        uint256 inputSum =
            token.balanceOf(address(this)) + token.balanceOf(address(manager)) + token.balanceOf(address(distributor));
        uint256 outputSum =
            imd.balanceOf(address(this)) + imd.balanceOf(address(manager)) + imd.balanceOf(seller.BURN_SINK());
        uint256 netSum;
        for (uint256 i; i < 4; ++i) {
            assertEq(token.balanceOf(actors[i]), expectedInput[i], "wallet input ledger");
            assertEq(token.allowance(actors[i], address(seller)), expectedAllowance[i], "wallet allowance ledger");
            assertEq(imd.balanceOf(actors[i]), expectedOutput[i], "recipient output ledger");
            inputSum += token.balanceOf(actors[i]);
            outputSum += imd.balanceOf(actors[i]);
            netSum += expectedOutput[i];
            for (uint256 round; round < 8; ++round) {
                assertEq(distributor.claimed(round, actors[i]), claimed[round][i], "claim flags are monotonic");
            }
        }
        assertEq(token.totalSupply(), 1e27, "launch supply changed");
        assertEq(inputSum, 1e27, "launch tokens created or lost");
        assertEq(outputSum, 1e30, "IMD created or lost");
        assertEq(token.balanceOf(address(this)), holderInputAtSetup);
        assertEq(imd.balanceOf(address(this)), holderOutputAtSetup);
        assertEq(token.balanceOf(address(distributor)), allocated - claimedTotal);
        assertEq(token.balanceOf(address(manager)), managerInputAtSetup + spentTotal);
        assertEq(imd.balanceOf(address(manager)), managerOutputAtSetup - grossTotal);
        assertEq(imd.balanceOf(seller.BURN_SINK()), burnedTotal, "fee must round once per batch");
        assertEq(netSum + burnedTotal, grossTotal, "gross = net + fee");
        assertEq(address(manager).balance, managerNativeAtSetup, "native intermediate did not net");
        assertEq(token.balanceOf(address(seller)), 0);
        assertEq(imd.balanceOf(address(seller)), 0);
        assertEq(address(seller).balance, 0);
        assertEq(token.balanceOf(address(harvester)), 0);
        assertEq(imd.balanceOf(address(harvester)), 0);
        assertEq(token.allowance(address(seller), address(manager)), 0);
    }

    function _assertSettled() private view {
        address[3] memory currencies = [address(token), address(imd), address(0)];
        for (uint256 i; i < 3; ++i) {
            bytes32 slot = keccak256(abi.encode(address(seller), currencies[i]));
            assertEq(manager.exttload(slot), bytes32(0), "outstanding seller delta");
        }
        assertEq(manager.exttload(bytes32(uint256(keccak256("Unlocked")) - 1)), bytes32(0), "manager left unlocked");
        assertEq(manager.exttload(bytes32(uint256(keccak256("NonzeroDeltaCount")) - 1)), bytes32(0));
    }

    function _sale(uint256 amount, bool viaEth) private view returns (SwarmSeller.Sale memory) {
        PoolKey[] memory route = new PoolKey[](viaEth ? 2 : 1);
        route[0] = _key(address(token), viaEth ? address(0) : address(imd));
        if (viaEth) route[1] = _key(address(0), address(imd));
        return SwarmSeller.Sale(address(token), amount, 1, route);
    }

    function _key(address a, address b) private pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(a < b ? a : b), Currency.wrap(a < b ? b : a), 3000, 60, IHooks(address(0)));
    }

    function _seed(PoolKey memory key) private {
        manager.initialize(key, 79228162514264337593543950336);
        manager.unlock(abi.encode(key));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "only setup manager");
        PoolKey memory key = abi.decode(data, (PoolKey));
        (BalanceDelta delta,) = manager.modifyLiquidity(
            key, IPoolManager.ModifyLiquidityParams(-887220, 887220, 1e25, bytes32(0)), bytes("")
        );
        _pay(key.currency0, uint256(-int256(delta.amount0())));
        _pay(key.currency1, uint256(-int256(delta.amount1())));
        return bytes("");
    }

    function _pay(Currency currency, uint256 amount) private {
        manager.sync(currency);
        if (Currency.unwrap(currency) == address(0)) {
            assertEq(manager.settle{value: amount}(), amount);
        } else {
            IERC20(Currency.unwrap(currency)).transfer(address(manager), amount);
            assertEq(manager.settle(), amount);
        }
    }

    function _entitlement(uint256 round, uint256 actor) private pure returns (uint256) {
        return 1e18 + round * 100 + actor;
    }

    function _leaves(uint256 round) private view returns (bytes32[4] memory leaves) {
        for (uint256 i; i < 4; ++i) {
            leaves[i] = keccak256(abi.encode(actors[i], _entitlement(round, i)));
        }
    }

    function _pair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}

contract SwarmLifecycleInvariantTest is Test {
    SwarmLifecycleHandler private handler;

    function setUp() public {
        handler = new SwarmLifecycleHandler();
        handler.initialize();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.approve.selector;
        selectors[1] = handler.transfer.selector;
        selectors[2] = handler.harvest.selector;
        selectors[3] = handler.sellBatch.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_LifecycleConservesFixedSupplyRefundsAndFees() public view {
        handler.assertConservation();
    }

    /// @dev Pin meaningful transitions even if a particular random sequence is unlucky.
    function test_HandlerExercisesSuccessReplayRefundRevocationAndRollback() public {
        handler.harvest(0, 0, 1, false);
        handler.harvest(0, 0, 2, false);
        handler.harvest(1, 0, 0, true);
        handler.sellBatch(0, 1, 1000, 0, false, false);
        handler.approve(0, 2001, 1);
        handler.sellBatch(0, 2, 1000, 2, true, false);
        handler.sellBatch(1, 3, 1000, 0, true, true);
        handler.approve(1, 0, 0);
        handler.sellBatch(1, 3, 1000, 0, true, false);
        handler.transfer(2, 3, type(uint256).max);
        handler.assertConservation();
        assertEq(handler.successfulClaims(), 1);
        assertEq(handler.successfulBatches(), 2);
        assertEq(handler.revertedBatches(), 1);
        assertEq(handler.expectedAllowance(0), 0, "refunded pulls consume finite approvals");
    }
}
