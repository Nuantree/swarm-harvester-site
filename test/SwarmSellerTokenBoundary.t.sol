// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SwarmSeller} from "src/SwarmSeller.sol";
import {MockToken} from "./mocks/MockToken.sol";
import {MockPoolManager} from "./mocks/MockPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

/// @dev Changes balances before returning arbitrary data, so a rejected return
/// must roll back real transfers and finite allowance consumption.
contract BoundaryReturnToken is ERC20 {
    uint256 private returnLength = 32;
    uint256 private returnWord = 1;
    bool private revertPull;
    bool private silentTransfer;
    address private settlementRecipient;
    uint8 private settlementMode;

    constructor() ERC20("Boundary token", "BOUND") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function configureReturn(uint256 length, uint256 word, bool reverts, bool silent) external {
        require(length <= 65_536);
        returnLength = length;
        returnWord = word;
        revertPull = reverts;
        silentTransfer = silent;
    }

    function configureSettlement(address recipient, uint8 mode) external {
        settlementRecipient = recipient;
        settlementMode = mode;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        super.transferFrom(from, to, amount);
        uint256 length = returnLength;
        uint256 word = returnWord;
        bool reverts = revertPull;
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, word)
            if reverts { revert(ptr, length) }
            return(ptr, length)
        }
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (to == settlementRecipient && settlementMode != 0) {
            if (settlementMode == 1) {
                // Charge only the settlement transfer, leaving the initial pull exact.
                _burn(msg.sender, 1);
                super.transfer(to, amount - 1);
            } else {
                super.transfer(to, amount);
                _mint(to, 1);
            }
        } else {
            super.transfer(to, amount);
        }
        if (silentTransfer) {
            assembly { return(0, 0) }
        }
        return true;
    }
}

contract SwarmSellerTokenBoundaryTest is Test {
    uint256 private constant FUNDS = 1e12;
    MockPoolManager private manager;
    MockToken private ordinary;
    MockToken private imd;
    BoundaryReturnToken private unusual;
    SwarmSeller private seller;
    address private alice;
    address private recipient;

    function setUp() public {
        manager = new MockPoolManager();
        ordinary = new MockToken();
        imd = new MockToken();
        unusual = new BoundaryReturnToken();
        seller = new SwarmSeller(address(manager), address(imd));
        alice = makeAddr("boundary caller");
        recipient = makeAddr("boundary recipient");
        ordinary.mint(alice, FUNDS);
        unusual.mint(alice, FUNDS);
        imd.mint(address(manager), FUNDS);
        vm.startPrank(alice);
        ordinary.approve(address(seller), FUNDS);
        unusual.approve(address(seller), FUNDS);
        vm.stopPrank();
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_ShortSuccessfulReturnRevertsAllEarlierEffects(uint8 sizeSeed, uint256 word) public {
        unusual.configureReturn(bound(sizeSeed, 1, 31), word, false, false);
        _assertMalformedBatchReverts();
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_NonBooleanWordRevertsEvenWithLongReturnData(uint32 sizeSeed, uint256 wordSeed) public {
        unusual.configureReturn(bound(sizeSeed, 32, 65_536), bound(wordSeed, 2, type(uint256).max), false, false);
        _assertMalformedBatchReverts();
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_TrueWithTrailingDataPreservesExactSixDecimalAmounts(uint32 sizeSeed) public {
        unusual.configureReturn(bound(sizeSeed, 32, 65_536), 1, false, false);
        _assertBothSalesPay();
    }

    function test_FalseWordWithMaximumReturnDataIsAtomicAndRetryable() public {
        unusual.configureReturn(65_536, 0, false, false);
        _assertMalformedBatchReverts();
        unusual.configureReturn(32, 1, false, false);
        _assertBothSalesPay();
    }

    function test_NoReturnOnPullSettlementAndRefund() public {
        unusual.configureReturn(0, 0, false, true);
        SwarmSeller.Sale[] memory sales = new SwarmSeller.Sale[](3);
        sales[0] = _sale(address(unusual), 100);
        sales[0].minOut = 201; // Exercises a SafeERC20 refund with no return data.
        sales[1] = _sale(address(unusual), 101);
        sales[2] = _sale(address(ordinary), 99);
        assertEq(_run(sales, 398), 398);
        assertEq(unusual.balanceOf(alice), FUNDS - 101);
        assertEq(unusual.allowance(alice, address(seller)), FUNDS - 201);
        assertEq(unusual.balanceOf(address(manager)), 101);
        assertEq(ordinary.balanceOf(alice), FUNDS - 99);
        assertEq(imd.balanceOf(recipient), 398);
        assertEq(imd.balanceOf(seller.BURN_SINK()), 2);
        _assertEmptyAndSettled();
    }

    function test_RevertAfterMovingTokensRestoresPullAndContinuesBatch() public {
        unusual.configureReturn(65_536, type(uint256).max, true, false);
        SwarmSeller.Sale[] memory sales = _batch();
        (sales[0], sales[1]) = (sales[1], sales[0]);
        vm.expectEmit(true, true, false, true, address(seller));
        emit SwarmSeller.SaleResult(0, address(unusual), false, 0);
        vm.expectEmit(true, true, false, true, address(seller));
        emit SwarmSeller.SaleResult(1, address(ordinary), true, 200);
        assertEq(_run(sales, 199), 199);
        assertEq(unusual.balanceOf(alice), FUNDS);
        assertEq(unusual.allowance(alice, address(seller)), FUNDS);
        assertEq(unusual.balanceOf(address(manager)), 0);
        assertEq(ordinary.balanceOf(alice), FUNDS - 100);
        assertEq(imd.balanceOf(recipient), 199);
        assertEq(imd.balanceOf(seller.BURN_SINK()), 1);
        _assertEmptyAndSettled();
    }

    function test_ShortAndExcessSettlementRefundOnlyTheirRow() public {
        for (uint8 mode = 1; mode <= 2; ++mode) {
            unusual.configureSettlement(address(manager), mode);
            SwarmSeller.Sale[] memory sales = _batch();
            vm.expectEmit(true, true, false, true, address(seller));
            emit SwarmSeller.SaleResult(0, address(ordinary), true, 200);
            vm.expectEmit(true, true, false, true, address(seller));
            emit SwarmSeller.SaleResult(1, address(unusual), false, 0);
            assertEq(_run(sales, 199), 199);
            assertEq(unusual.balanceOf(alice), FUNDS);
            assertEq(unusual.balanceOf(address(manager)), 0);
            assertEq(unusual.totalSupply(), FUNDS, "settlement mint/burn escaped rollback");
            assertEq(unusual.allowance(alice, address(seller)), FUNDS - uint256(mode) * 101);
            assertEq(ordinary.balanceOf(alice), FUNDS - uint256(mode) * 100);
            assertEq(imd.balanceOf(recipient), uint256(mode) * 199);
            assertEq(imd.balanceOf(seller.BURN_SINK()), uint256(mode));
            _assertEmptyAndSettled();
        }
        unusual.configureSettlement(address(manager), 0);
        assertEq(_run(_batch(), 400), 400, "callback state must recover for the next batch");
        assertEq(unusual.balanceOf(alice), FUNDS - 101);
        _assertEmptyAndSettled();
    }

    function _assertMalformedBatchReverts() private {
        vm.expectRevert(SwarmSeller.UnexpectedTokenReturn.selector);
        _run(_batch(), 0);
        assertEq(ordinary.balanceOf(alice), FUNDS);
        assertEq(unusual.balanceOf(alice), FUNDS);
        assertEq(ordinary.allowance(alice, address(seller)), FUNDS);
        assertEq(unusual.allowance(alice, address(seller)), FUNDS);
        assertEq(ordinary.balanceOf(address(manager)), 0);
        assertEq(unusual.balanceOf(address(manager)), 0);
        assertEq(imd.balanceOf(address(manager)), FUNDS);
        assertEq(imd.balanceOf(recipient), 0);
        assertEq(imd.balanceOf(seller.BURN_SINK()), 0);
        _assertEmptyAndSettled();
    }

    function _assertBothSalesPay() private {
        assertEq(_run(_batch(), 400), 400);
        assertEq(ordinary.balanceOf(alice), FUNDS - 100);
        assertEq(unusual.balanceOf(alice), FUNDS - 101);
        assertEq(ordinary.allowance(alice, address(seller)), FUNDS - 100);
        assertEq(unusual.allowance(alice, address(seller)), FUNDS - 101);
        assertEq(ordinary.balanceOf(address(manager)), 100);
        assertEq(unusual.balanceOf(address(manager)), 101);
        assertEq(imd.balanceOf(address(manager)), FUNDS - 402);
        assertEq(imd.balanceOf(recipient), 400);
        assertEq(imd.balanceOf(seller.BURN_SINK()), 2);
        _assertEmptyAndSettled();
    }

    function _assertEmptyAndSettled() private view {
        assertEq(ordinary.balanceOf(address(seller)), 0);
        assertEq(unusual.balanceOf(address(seller)), 0);
        assertEq(imd.balanceOf(address(seller)), 0);
        assertEq(address(seller).balance, 0);
        assertEq(manager.delta(address(ordinary)), 0);
        assertEq(manager.delta(address(unusual)), 0);
        assertEq(manager.delta(address(imd)), 0);
    }

    function _run(SwarmSeller.Sale[] memory sales, uint256 minimum) private returns (uint256) {
        vm.prank(alice);
        return seller.sellMany(sales, recipient, minimum, block.timestamp);
    }

    function _batch() private view returns (SwarmSeller.Sale[] memory sales) {
        sales = new SwarmSeller.Sale[](2);
        sales[0] = _sale(address(ordinary), 100);
        sales[1] = _sale(address(unusual), 101);
    }

    function _sale(address input, uint256 amount) private view returns (SwarmSeller.Sale memory) {
        address output = address(imd);
        PoolKey[] memory route = new PoolKey[](1);
        route[0] = PoolKey(
            Currency.wrap(input < output ? input : output),
            Currency.wrap(input < output ? output : input),
            3000,
            60,
            IHooks(address(0))
        );
        return SwarmSeller.Sale(input, amount, 1, route);
    }
}
