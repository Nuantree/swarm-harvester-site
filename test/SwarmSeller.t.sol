// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SwarmSeller} from "../src/SwarmSeller.sol";
import {MockToken} from "./mocks/MockToken.sol";
import {MockPoolManager} from "./mocks/MockPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

contract SwarmSellerTest is Test {
    SwarmSeller private seller;
    MockToken private token;
    MockToken private imd;
    MockPoolManager private manager;
    address private alice;
    address private recipient;

    function setUp() public {
        token = new MockToken();
        imd = new MockToken();
        manager = new MockPoolManager();
        seller = new SwarmSeller(address(manager), address(imd));
        alice = makeAddr("alice");
        recipient = makeAddr("recipient");
        token.mint(alice, 1e27);
        imd.mint(address(manager), 1e30);
        vm.prank(alice);
        token.approve(address(seller), 1e27);
    }

    function _key(address a, address b) private pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(a < b ? a : b), Currency.wrap(a < b ? b : a), 3000, 60, IHooks(address(0)));
    }

    function _sales(uint256 amount, bool viaEth) private view returns (SwarmSeller.Sale[] memory sales) {
        sales = new SwarmSeller.Sale[](1);
        PoolKey[] memory route = new PoolKey[](viaEth ? 2 : 1);
        route[0] = _key(address(token), viaEth ? address(0) : address(imd));
        if (viaEth) route[1] = _key(address(0), address(imd));
        sales[0] = SwarmSeller.Sale(address(token), amount, 1, route);
    }

    function _run(SwarmSeller.Sale[] memory sales, uint256 minimum) private returns (uint256) {
        vm.prank(alice);
        return seller.sellMany(sales, recipient, minimum, block.timestamp);
    }

    function _emptyCustody() private view {
        assertEq(token.balanceOf(address(seller)), 0);
        assertEq(imd.balanceOf(address(seller)), 0);
        assertEq(address(seller).balance, 0);
        assertEq(manager.delta(address(token)), 0);
        assertEq(manager.delta(address(imd)), 0);
        assertEq(manager.delta(address(0)), 0);
    }

    function testDirectFeeAndRecipient() public {
        assertEq(_run(_sales(10_000, false), 19_900), 19_900);
        assertEq(imd.balanceOf(recipient), 19_900);
        assertEq(imd.balanceOf(seller.BURN_SINK()), 100);
        assertEq(token.balanceOf(alice), 1e27 - 10_000);
        assertEq(token.balanceOf(address(manager)), 10_000);
        _emptyCustody();
    }

    function testNativeIntermediateNetsInsideManager() public {
        assertEq(_run(_sales(10_000, true), 39_800), 39_800);
        assertEq(imd.balanceOf(seller.BURN_SINK()), 200);
        _emptyCustody();
    }

    function testOtherSortDirection() public {
        SwarmSeller reverse = new SwarmSeller(address(manager), address(token));
        imd.mint(alice, 10_000);
        token.mint(address(manager), 20_000);
        PoolKey[] memory route = new PoolKey[](1);
        route[0] = _key(address(imd), address(token));
        SwarmSeller.Sale[] memory sales = new SwarmSeller.Sale[](1);
        sales[0] = SwarmSeller.Sale(address(imd), 10_000, 20_000, route);
        vm.startPrank(alice);
        imd.approve(address(reverse), 10_000);
        assertEq(reverse.sellMany(sales, recipient, 19_900, block.timestamp), 19_900);
        vm.stopPrank();
        assertEq(token.balanceOf(recipient), 19_900);
        assertEq(imd.balanceOf(address(reverse)), 0);
        assertEq(token.balanceOf(address(reverse)), 0);
    }

    function testMixedBatchRefundsAndContinues() public {
        SwarmSeller.Sale[] memory sales = new SwarmSeller.Sale[](3);
        sales[0] = _sales(1000, false)[0];
        sales[0].minOut = 2001;
        sales[1] = _sales(2000, true)[0];
        sales[2] = _sales(3000, false)[0];
        vm.expectEmit(true, true, false, true);
        emit SwarmSeller.SaleResult(0, address(token), false, 0);
        assertEq(_run(sales, 13_930), 13_930);
        assertEq(token.balanceOf(alice), 1e27 - 5000);
        assertEq(imd.balanceOf(seller.BURN_SINK()), 70);
        _emptyCustody();
    }

    function testFirstAndSecondHopFailuresRefund() public {
        SwarmSeller.Sale[] memory sales = _sales(1000, true);
        manager.setMode(sales[0].route[1], 1);
        assertEq(_run(sales, 0), 0);
        assertEq(token.balanceOf(alice), 1e27);
        manager.setMode(sales[0].route[1], 0);
        manager.setMode(sales[0].route[0], 1);
        assertEq(_run(sales, 0), 0);
        _emptyCustody();
    }

    function testPartialFillsZeroOutputAndOutOfGasAreRefunded() public {
        SwarmSeller.Sale[] memory sales = _sales(1000, false);
        for (uint8 mode = 2; mode <= 4; ++mode) {
            manager.setMode(sales[0].route[0], mode);
            assertEq(_run(sales, 0), 0);
            assertEq(token.balanceOf(alice), 1e27);
            _emptyCustody();
        }
    }

    function testSecondHopPartialFillRollsBackBothSwaps() public {
        SwarmSeller.Sale[] memory sales = _sales(1000, true);
        manager.setMode(sales[0].route[1], 2);
        assertEq(_run(sales, 0), 0);
        assertEq(token.balanceOf(alice), 1e27);
        _emptyCustody();
    }

    function testAggregateMinimumRollsBackEverySaleAndFee() public {
        vm.expectRevert(SwarmSeller.MinimumOutputNotMet.selector);
        _run(_sales(1000, false), 1991);
        assertEq(token.balanceOf(alice), 1e27);
        assertEq(token.allowance(alice, address(seller)), 1e27);
        assertEq(imd.balanceOf(recipient), 0);
        assertEq(imd.balanceOf(seller.BURN_SINK()), 0);
        _emptyCustody();
    }

    function testCallerCannotUseVictimsApprovalOrSelfHelper() public {
        SwarmSeller.Sale[] memory sales = _sales(1000, false);
        vm.prank(makeAddr("attacker"));
        assertEq(seller.sellMany(sales, recipient, 0, block.timestamp), 0);
        vm.expectRevert(SwarmSeller.OnlySelf.selector);
        seller.executeSale(sales[0]);
        assertEq(token.balanceOf(alice), 1e27);
        assertEq(token.allowance(alice, address(seller)), 1e27);
        _emptyCustody();
    }

    function testForgedIdleAndReplayedCallbacksRejected() public {
        SwarmSeller.Sale[] memory sales = _sales(1000, false);
        bytes memory data = abi.encode(sales[0]);
        vm.expectRevert(SwarmSeller.InvalidCallback.selector);
        seller.unlockCallback(data);
        vm.prank(address(manager));
        vm.expectRevert(SwarmSeller.InvalidCallback.selector);
        seller.unlockCallback(data);
        for (uint8 mode = 1; mode <= 3; ++mode) {
            manager.setCallbackMode(mode);
            assertEq(_run(sales, 0), 0);
            _emptyCustody();
        }
        manager.setCallbackMode(0);
        assertEq(_run(sales, 0), 1990);
    }

    function testReentrantTokenPullSettlementAndOutputRejected() public {
        bytes memory attack =
            abi.encodeCall(seller.sellMany, (new SwarmSeller.Sale[](0), recipient, 0, block.timestamp));
        token.setProbe(address(seller), attack);
        imd.setProbe(address(seller), attack);
        assertEq(_run(_sales(1000, false), 1990), 1990);
        assertGe(token.rejectedReentries(), 2);
        assertGe(imd.rejectedReentries(), 3);
        _emptyCustody();
    }

    function testReentrantSwapCannotSellOrInvokeCallback() public {
        SwarmSeller.Sale[] memory sales = _sales(1000, true);
        manager.setProbe(address(seller), abi.encodeCall(seller.sellMany, (sales, recipient, 0, block.timestamp)));
        assertEq(_run(sales, 0), 3980);
        manager.setProbe(address(seller), abi.encodeCall(seller.unlockCallback, (abi.encode(sales[0]))));
        assertEq(_run(sales, 0), 3980);
        assertEq(manager.rejectedReentries(), 4);
        _emptyCustody();
    }

    function testRefundFailureRestoresOriginalBalanceAndAllowance() public {
        SwarmSeller.Sale[] memory sales = _sales(1000, false);
        sales[0].minOut = 2001;
        token.setRejectedRecipient(alice);
        vm.expectRevert();
        _run(sales, 0);
        assertEq(token.balanceOf(alice), 1e27);
        assertEq(token.allowance(alice, address(seller)), 1e27);
        _emptyCustody();
    }

    function testOutputAndBurnTransferFailureRollBack() public {
        imd.setRejectedRecipient(recipient);
        vm.expectRevert();
        _run(_sales(1000, false), 0);
        assertEq(token.balanceOf(alice), 1e27);
        _emptyCustody();
        imd.setRejectedRecipient(seller.BURN_SINK());
        vm.expectRevert();
        _run(_sales(1000, false), 0);
        assertEq(imd.balanceOf(recipient), 0);
        _emptyCustody();
    }

    function testSettlementFailureRefunds() public {
        token.setRejectedRecipient(address(manager));
        assertEq(_run(_sales(1000, false), 0), 0);
        assertEq(token.balanceOf(alice), 1e27);
        _emptyCustody();
    }

    function testTaxedTokenCannotStrandFunds() public {
        token.setTaxed(true);
        vm.expectRevert();
        _run(_sales(1000, false), 0);
        assertEq(token.balanceOf(alice), 1e27);
        _emptyCustody();
    }

    function testNoReturnTokenAcceptedButFalseOrMalformedSuccessIsAtomic() public {
        token.setReturnMode(1);
        assertEq(_run(_sales(1000, false), 0), 1990);
        _emptyCustody();
        for (uint8 mode = 2; mode <= 3; ++mode) {
            token.setReturnMode(mode);
            vm.expectRevert(SwarmSeller.UnexpectedTokenReturn.selector);
            _run(_sales(1000, false), 0);
            assertEq(token.balanceOf(alice), 1e27 - 1000);
            _emptyCustody();
        }
    }

    function testRevertedPullIsSkipped() public {
        token.setRejectPull(true);
        assertEq(_run(_sales(1000, false), 0), 0);
        assertEq(token.balanceOf(alice), 1e27);
        _emptyCustody();
    }

    function testInvalidRoutesAndAmountsNeverPull() public {
        SwarmSeller.Sale[] memory sales = new SwarmSeller.Sale[](7);
        for (uint256 i = 0; i < sales.length; ++i) {
            sales[i] = _sales(1000, false)[0];
        }
        sales[0].route = new PoolKey[](0);
        sales[1].route[0] = _key(address(token), makeAddr("wrong output"));
        (sales[2].route[0].currency0, sales[2].route[0].currency1) =
        (sales[2].route[0].currency1, sales[2].route[0].currency0);
        sales[3].amountIn = 0;
        sales[4].amountIn = uint256(type(int256).max);
        sales[5].token = address(imd);
        sales[6] = _sales(1000, true)[0];
        sales[6].route[1] = _key(address(token), address(imd));
        assertEq(_run(sales, 0), 0);
        assertEq(token.allowance(alice, address(seller)), 1e27);
        _emptyCustody();
    }

    function testDeadlineRecipientAndConstructorValidation() public {
        vm.warp(100);
        SwarmSeller.Sale[] memory sales = _sales(1000, false);
        address sink = seller.BURN_SINK();
        vm.expectRevert(SwarmSeller.DeadlineExpired.selector);
        seller.sellMany(sales, recipient, 0, 99);
        vm.expectRevert(SwarmSeller.InvalidRecipient.selector);
        seller.sellMany(sales, address(0), 0, 100);
        vm.expectRevert(SwarmSeller.InvalidRecipient.selector);
        seller.sellMany(sales, address(seller), 0, 100);
        vm.expectRevert(SwarmSeller.InvalidRecipient.selector);
        seller.sellMany(sales, sink, 0, 100);
        vm.expectRevert(SwarmSeller.InvalidConfiguration.selector);
        new SwarmSeller(address(0), address(imd));
        vm.expectRevert(SwarmSeller.InvalidConfiguration.selector);
        new SwarmSeller(address(manager), address(manager));
    }

    function testEmptyBatchAndNoNativePayment() public {
        assertEq(_run(new SwarmSeller.Sale[](0), 0), 0);
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(seller).call{value: 1}("");
        assertFalse(ok);
    }

    function testDonationsCannotBeSweptOrCountedAsOutput() public {
        token.mint(address(seller), 123);
        imd.mint(address(seller), 456);
        assertEq(_run(_sales(1000, false), 0), 1990);
        assertEq(token.balanceOf(address(seller)), 123);
        assertEq(imd.balanceOf(address(seller)), 456);
        assertEq(imd.balanceOf(recipient), 1990);
    }

    function testFeeRoundsOnceAcrossDuplicateTokenRows() public {
        SwarmSeller.Sale[] memory sales = new SwarmSeller.Sale[](2);
        sales[0] = _sales(99, false)[0];
        sales[1] = _sales(1, false)[0];
        assertEq(_run(sales, 199), 199);
        assertEq(imd.balanceOf(seller.BURN_SINK()), 1);
        _emptyCustody();
    }

    function testFuzzConservationAndExactRoundedFee(uint96 rawAmount, bool viaEth) public {
        uint256 amount = bound(rawAmount, 1, 1e25);
        uint256 gross = amount * (viaEth ? 4 : 2);
        uint256 net = gross - gross / 200;
        assertEq(_run(_sales(amount, viaEth), net), net);
        assertEq(imd.balanceOf(recipient) + imd.balanceOf(seller.BURN_SINK()), gross);
        assertEq(imd.balanceOf(seller.BURN_SINK()), gross / 200);
        assertEq(token.balanceOf(alice) + token.balanceOf(address(manager)), 1e27);
        assertEq(imd.balanceOf(address(manager)) + gross, 1e30);
        _emptyCustody();
    }
}
