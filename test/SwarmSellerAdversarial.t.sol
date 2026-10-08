// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SwarmSeller} from "src/SwarmSeller.sol";
import {MockToken} from "./mocks/MockToken.sol";
import {MockPoolManager} from "./mocks/MockPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

contract GriefingPullToken {
    bool private immutable exhaustGas;

    constructor(bool exhaustGas_) {
        exhaustGas = exhaustGas_;
    }

    function transferFrom(address, address, uint256) public view returns (bool) {
        if (exhaustGas) {
            assembly { for {} 1 {} {} }
        }
        assembly { revert(0, 100000) }
    }
}

contract SwarmSellerAdversarialTest is Test {
    uint256 private constant FUNDING = 1e40;
    SwarmSeller private seller;
    MockPoolManager private manager;
    MockToken private token;
    MockToken private second;
    MockToken private imd;
    address private alice;
    address private recipient;

    function setUp() public {
        manager = new MockPoolManager();
        token = new MockToken();
        second = new MockToken();
        imd = new MockToken();
        seller = new SwarmSeller(address(manager), address(imd));
        alice = makeAddr("sale alice");
        recipient = makeAddr("sale recipient");
        token.mint(alice, FUNDING);
        second.mint(alice, FUNDING);
        imd.mint(address(manager), FUNDING);
        vm.startPrank(alice);
        token.approve(address(seller), FUNDING);
        second.approve(address(seller), FUNDING);
        vm.stopPrank();
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_MixedTokenBatchRefundsAndChargesOnlySettledOutput(
        uint128 amountSeed,
        uint128 secondSeed,
        uint8 failures
    ) public {
        uint256 amount = bound(amountSeed, 1, 1e24);
        uint256 otherAmount = bound(secondSeed, 1, 1e24);
        SwarmSeller.Sale[] memory sales = new SwarmSeller.Sale[](3);
        sales[0] = _sale(token, amount, false);
        sales[1] = _sale(second, otherAmount, true);
        sales[2] = _sale(token, 1, false);
        bool failFirst = failures & 1 != 0;
        bool failSecond = failures & 2 != 0;
        if (failFirst) sales[0].minOut = amount * 2 + 1;
        if (failSecond) sales[1].minOut = otherAmount * 4 + 1;
        uint256 gross = (failFirst ? 0 : amount * 2) + (failSecond ? 0 : otherAmount * 4) + 2;
        uint256 fee = gross * 50 / 10_000;
        uint256 net = gross - fee;

        vm.expectEmit(true, true, false, true, address(seller));
        emit SwarmSeller.SaleResult(0, address(token), !failFirst, failFirst ? 0 : amount * 2);
        vm.expectEmit(true, true, false, true, address(seller));
        emit SwarmSeller.SaleResult(1, address(second), !failSecond, failSecond ? 0 : otherAmount * 4);
        vm.expectEmit(true, true, false, true, address(seller));
        emit SwarmSeller.SaleResult(2, address(token), true, 2);
        vm.expectEmit(true, true, false, true, address(seller));
        emit SwarmSeller.BatchSold(alice, recipient, net, fee);
        assertEq(_run(sales, net), net);
        assertEq(token.balanceOf(alice), FUNDING - (failFirst ? 0 : amount) - 1);
        assertEq(second.balanceOf(alice), FUNDING - (failSecond ? 0 : otherAmount));
        assertEq(token.allowance(alice, address(seller)), FUNDING - amount - 1);
        assertEq(second.allowance(alice, address(seller)), FUNDING - otherAmount);
        assertEq(imd.balanceOf(recipient), net);
        assertEq(imd.balanceOf(seller.BURN_SINK()), fee);
        assertEq(imd.balanceOf(address(manager)) + net + fee, FUNDING);
        _empty();
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_FeeArithmeticUpToSignedDeltaLimit(uint256 seed, bool viaEth) public {
        uint256 multiplier = viaEth ? 4 : 2;
        uint256 amount = bound(seed, 1, uint256(uint128(type(int128).max)) / multiplier);
        SwarmSeller.Sale[] memory sales = new SwarmSeller.Sale[](1);
        sales[0] = _sale(token, amount, viaEth);
        uint256 gross = amount * multiplier;
        uint256 net = _run(sales, 0);
        uint256 fee = imd.balanceOf(seller.BURN_SINK());
        assertEq(net + fee, gross);
        assertEq(imd.balanceOf(recipient), net);
        assertEq(imd.balanceOf(address(manager)), FUNDING - gross);
        // These inequalities specify floor rounding without copying the fee formula.
        assertLe(fee * 10_000, gross * 50);
        assertLt(gross * 50, (fee + 1) * 10_000);
        assertEq(token.balanceOf(alice), FUNDING - amount);
        _empty();
    }

    function test_OneWeiAndFeeThresholds() public {
        uint256[4] memory amounts = [uint256(1), 99, 100, 101];
        uint256[4] memory fees = [uint256(0), 0, 1, 1];
        for (uint256 i; i < amounts.length; ++i) {
            SwarmSeller.Sale[] memory sales = new SwarmSeller.Sale[](1);
            sales[0] = _sale(token, amounts[i], false);
            uint256 beforeBurn = imd.balanceOf(seller.BURN_SINK());
            assertEq(_run(sales, amounts[i] * 2 - fees[i]), amounts[i] * 2 - fees[i]);
            assertEq(imd.balanceOf(seller.BURN_SINK()) - beforeBurn, fees[i]);
        }
        _empty();
    }

    function test_MaximumInputIsPulledAndRefundedButLargerInputsNeverPull() public {
        uint256 maximum = uint256(uint128(type(int128).max));
        SwarmSeller.Sale[] memory sales = new SwarmSeller.Sale[](3);
        sales[0] = _sale(token, maximum, false);
        sales[1] = _sale(token, maximum + 1, false);
        sales[2] = _sale(token, type(uint256).max, false);
        // Reject at the pool, so this tests validation independently of a rate
        // that would require an unrepresentable int128 output in the mock.
        manager.setMode(sales[0].route[0], 1);
        assertEq(_run(sales, 0), 0);
        assertEq(token.balanceOf(alice), FUNDING);
        assertEq(token.allowance(alice, address(seller)), FUNDING - maximum);
        _empty();
    }

    function test_InvalidRouteShapesNeverConsumeApprovalAndNextRowSucceeds() public {
        SwarmSeller.Sale[] memory sales = new SwarmSeller.Sale[](7);
        for (uint256 i; i < sales.length; ++i) {
            sales[i] = _sale(token, 100, false);
        }
        sales[0].route[0].tickSpacing = 0;
        sales[1].route[0].tickSpacing = -1;
        sales[2].route = new PoolKey[](3);
        sales[3].token = address(0);
        sales[4].token = makeAddr("not a token");
        sales[5] = _sale(token, 100, true);
        sales[5].route[0] = _key(address(token), address(second));
        assertEq(_run(sales, 199), 199);
        assertEq(token.allowance(alice, address(seller)), FUNDING - 100);
        assertEq(token.balanceOf(alice), FUNDING - 100);
        _empty();
    }

    function test_FalseOrMalformedLaterPullRollsBackEarlierSwapAndApproval() public {
        SwarmSeller.Sale[] memory sales = _twoSales();
        for (uint8 mode = 2; mode <= 3; ++mode) {
            second.setReturnMode(mode);
            vm.expectRevert(SwarmSeller.UnexpectedTokenReturn.selector);
            _run(sales, 0);
            _unchanged();
        }
        second.setReturnMode(0);
        assertEq(_run(sales, 0), 5970, "callback state must recover after rollback");
        _empty();
    }

    function test_LaterRefundFailureRollsBackEarlierSwapAndAllApprovals() public {
        SwarmSeller.Sale[] memory sales = _twoSales();
        sales[1].minOut = 4001;
        second.setRejectedRecipient(alice);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "transfer rejected"));
        _run(sales, 0);
        _unchanged();
        second.setRejectedRecipient(address(0));
        assertEq(_run(sales, 0), 1990);
        assertEq(second.balanceOf(alice), FUNDING);
        _empty();
    }

    function test_AggregateMinimumRestoresSuccessfulAndRefundedRows() public {
        SwarmSeller.Sale[] memory sales = _twoSales();
        sales[1].minOut = 4001;
        vm.expectRevert(SwarmSeller.MinimumOutputNotMet.selector);
        _run(sales, 1991);
        _unchanged();
    }

    function test_ExhaustedDuplicateAllowanceSkipsOnlyTheUnfundedRow() public {
        vm.prank(alice);
        token.approve(address(seller), 1000);
        SwarmSeller.Sale[] memory sales = new SwarmSeller.Sale[](3);
        sales[0] = _sale(token, 1000, false);
        sales[0].minOut = 2001;
        sales[1] = _sale(token, 1, false);
        sales[2] = _sale(second, 100, false);
        assertEq(_run(sales, 199), 199);
        assertEq(token.balanceOf(alice), FUNDING);
        assertEq(token.allowance(alice, address(seller)), 0);
        assertEq(second.balanceOf(alice), FUNDING - 100);
        _empty();
    }

    function test_GasExhaustingAndLargeRevertPullsDoNotBlockLaterSales() public {
        MockToken gasBomb = MockToken(address(new GriefingPullToken(true)));
        MockToken revertBomb = MockToken(address(new GriefingPullToken(false)));
        SwarmSeller.Sale[] memory sales = new SwarmSeller.Sale[](3);
        sales[0] = _sale(gasBomb, 100, false);
        sales[1] = _sale(revertBomb, 100, false);
        sales[2] = _sale(token, 100, false);
        assertEq(_run(sales, 199), 199);
        assertEq(token.balanceOf(alice), FUNDING - 100);
        assertEq(imd.balanceOf(recipient), 199);
        _empty();
    }

    function test_DeadlineBoundaryAllowsCallerAsRecipientAndRejectsNextSecond() public {
        vm.warp(10_000);
        SwarmSeller.Sale[] memory sales = _twoSales();
        vm.prank(alice);
        assertEq(seller.sellMany(sales, alice, 5970, 10_000), 5970);
        assertEq(imd.balanceOf(alice), 5970);
        uint256 allowanceBefore = token.allowance(alice, address(seller));
        vm.warp(10_001);
        vm.prank(alice);
        vm.expectRevert(SwarmSeller.DeadlineExpired.selector);
        seller.sellMany(sales, alice, 0, 10_000);
        assertEq(token.allowance(alice, address(seller)), allowanceBefore);
        assertEq(imd.balanceOf(alice), 5970);
        _empty();
    }

    function _unchanged() private view {
        assertEq(token.balanceOf(alice), FUNDING);
        assertEq(second.balanceOf(alice), FUNDING);
        assertEq(token.allowance(alice, address(seller)), FUNDING);
        assertEq(second.allowance(alice, address(seller)), FUNDING);
        assertEq(token.balanceOf(address(manager)), 0);
        assertEq(second.balanceOf(address(manager)), 0);
        assertEq(imd.balanceOf(address(manager)), FUNDING);
        assertEq(imd.balanceOf(recipient), 0);
        assertEq(imd.balanceOf(seller.BURN_SINK()), 0);
        _empty();
    }

    function _empty() private view {
        assertEq(token.balanceOf(address(seller)), 0);
        assertEq(second.balanceOf(address(seller)), 0);
        assertEq(imd.balanceOf(address(seller)), 0);
        assertEq(address(seller).balance, 0);
        assertEq(manager.delta(address(token)), 0);
        assertEq(manager.delta(address(second)), 0);
        assertEq(manager.delta(address(imd)), 0);
        assertEq(manager.delta(address(0)), 0);
    }

    function _twoSales() private view returns (SwarmSeller.Sale[] memory sales) {
        sales = new SwarmSeller.Sale[](2);
        sales[0] = _sale(token, 1000, false);
        sales[1] = _sale(second, 1000, true);
    }

    function _run(SwarmSeller.Sale[] memory sales, uint256 minimum) private returns (uint256) {
        vm.prank(alice);
        return seller.sellMany(sales, recipient, minimum, block.timestamp);
    }

    function _sale(MockToken input, uint256 amount, bool viaEth) private view returns (SwarmSeller.Sale memory) {
        PoolKey[] memory route = new PoolKey[](viaEth ? 2 : 1);
        route[0] = _key(address(input), viaEth ? address(0) : address(imd));
        if (viaEth) route[1] = _key(address(0), address(imd));
        return SwarmSeller.Sale(address(input), amount, 1, route);
    }

    function _key(address a, address b) private pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(a < b ? a : b), Currency.wrap(a < b ? b : a), 3000, 60, IHooks(address(0)));
    }
}
