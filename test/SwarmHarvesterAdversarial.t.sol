// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {SwarmHarvester} from "src/SwarmHarvester.sol";
import {MockToken} from "./mocks/MockToken.sol";
import {MockDistributor} from "./mocks/MockDistributor.sol";

contract SwarmHarvesterAdversarialTest is Test {
    SwarmHarvester private harvester;
    MockToken private token;
    MockDistributor private distributor;
    address private alice;
    address private bob;
    address private keeper;

    function setUp() public {
        harvester = new SwarmHarvester();
        token = new MockToken();
        distributor = new MockDistributor(address(token));
        alice = makeAddr("claim alice");
        bob = makeAddr("claim bob");
        keeper = makeAddr("unrelated keeper");
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_NonemptyProofCannotBeRedirectedOrRelabelled(
        uint96 aliceAmount,
        uint96 bobAmount,
        uint256 round,
        uint8 mutationSeed
    ) public {
        bytes32 a = _leaf(alice, aliceAmount);
        bytes32 b = _leaf(bob, bobAmount);
        distributor.setRoot(round, _pair(a, b));
        uint256 funding = uint256(aliceAmount) + bobAmount;
        token.mint(address(distributor), funding);
        SwarmHarvester.Claim[] memory claims = new SwarmHarvester.Claim[](3);
        claims[0] = _claim(distributor, round, alice, aliceAmount, b);
        uint8 mutation = mutationSeed % 4;
        if (mutation == 0) claims[0].account = keeper;
        if (mutation == 1) claims[0].amount += 1;
        if (mutation == 2) claims[0].round = round ^ 1;
        if (mutation == 3) claims[0].proof[0] = bytes32(uint256(b) ^ 1);
        claims[1] = _claim(distributor, round, alice, aliceAmount, b);
        claims[2] = _claim(distributor, round, bob, bobAmount, a);

        vm.recordLogs();
        vm.prank(keeper);
        assertEq(harvester.claimMany(claims), 2);
        bool[] memory expected = new bool[](3);
        expected[1] = true;
        expected[2] = true;
        _checkEvents(vm.getRecordedLogs(), claims, expected);
        assertEq(token.balanceOf(alice), aliceAmount);
        assertEq(token.balanceOf(bob), bobAmount);
        assertEq(token.balanceOf(keeper), 0);
        assertEq(token.balanceOf(address(harvester)), 0);
        assertEq(token.balanceOf(address(distributor)), 0);
        assertTrue(distributor.claimed(round, alice));
        assertTrue(distributor.claimed(round, bob));
        assertFalse(distributor.claimed(round, keeper));
        assertFalse(distributor.claimed(round ^ 1, alice));

        vm.prank(bob);
        assertEq(harvester.claimMany(claims), 0, "replay must not pay anyone again");
        assertEq(token.balanceOf(alice) + token.balanceOf(bob), funding);
    }

    function test_ZeroAndMaximumRoundAreIndependentAcrossDistributorsAndWallets() public {
        MockDistributor other = new MockDistributor(address(token));
        bytes32 a = _leaf(alice, 1);
        bytes32 b = _leaf(bob, 2);
        bytes32 root = _pair(a, b);
        distributor.setRoot(0, root);
        distributor.setRoot(type(uint256).max, root);
        other.setRoot(0, root);
        token.mint(address(distributor), 6);
        token.mint(address(other), 3);
        SwarmHarvester.Claim[] memory claims = new SwarmHarvester.Claim[](6);
        claims[0] = _claim(distributor, 0, alice, 1, b);
        claims[1] = _claim(distributor, type(uint256).max, alice, 1, b);
        claims[2] = _claim(other, 0, alice, 1, b);
        claims[3] = _claim(distributor, 0, bob, 2, a);
        claims[4] = _claim(distributor, type(uint256).max, bob, 2, a);
        claims[5] = _claim(other, 0, bob, 2, a);
        vm.prank(keeper);
        assertEq(harvester.claimMany(claims), 6);
        assertEq(harvester.claimMany(claims), 0);
        assertEq(token.balanceOf(alice), 3);
        assertEq(token.balanceOf(bob), 6);
        assertEq(token.balanceOf(address(distributor)), 0);
        assertEq(token.balanceOf(address(other)), 0);
        assertEq(token.balanceOf(address(harvester)), 0);
    }

    function test_UnderfundedClaimRemainsRetryableAndDoesNotBlockNextDistributor() public {
        MockDistributor funded = new MockDistributor(address(token));
        distributor.setRoot(7, _leaf(alice, 100));
        funded.setRoot(7, _leaf(bob, 200));
        token.mint(address(funded), 200);
        SwarmHarvester.Claim[] memory claims = new SwarmHarvester.Claim[](2);
        claims[0] = SwarmHarvester.Claim(address(distributor), 7, alice, 100, new bytes32[](0));
        claims[1] = SwarmHarvester.Claim(address(funded), 7, bob, 200, new bytes32[](0));
        vm.recordLogs();
        vm.prank(keeper);
        assertEq(harvester.claimMany(claims), 1);
        bool[] memory expected = new bool[](2);
        expected[1] = true;
        _checkEvents(vm.getRecordedLogs(), claims, expected);
        assertFalse(distributor.claimed(7, alice), "failed payout consumed claim");
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.balanceOf(bob), 200);

        token.mint(address(distributor), 100);
        vm.prank(keeper);
        assertEq(harvester.claimMany(claims), 1);
        assertTrue(distributor.claimed(7, alice));
        assertEq(token.balanceOf(alice), 100);
        assertEq(token.balanceOf(bob), 200);
        assertEq(token.balanceOf(address(harvester)), 0);
    }

    function test_RejectedPayoutRollsBackOnlyItsOwnClaimFlag() public {
        bytes32 a = _leaf(alice, 100);
        bytes32 b = _leaf(bob, 200);
        distributor.setRoot(1, _pair(a, b));
        token.mint(address(distributor), 300);
        token.setRejectedRecipient(alice);
        SwarmHarvester.Claim[] memory claims = new SwarmHarvester.Claim[](2);
        claims[0] = _claim(distributor, 1, alice, 100, b);
        claims[1] = _claim(distributor, 1, bob, 200, a);
        assertEq(harvester.claimMany(claims), 1);
        assertFalse(distributor.claimed(1, alice));
        assertTrue(distributor.claimed(1, bob));
        assertEq(token.balanceOf(address(distributor)), 100);
        token.setRejectedRecipient(address(0));
        assertEq(harvester.claimMany(claims), 1);
        assertEq(token.balanceOf(alice), 100);
        assertEq(token.balanceOf(bob), 200);
        assertEq(token.balanceOf(address(harvester)), 0);
    }

    function test_SixtyFourClaimsIncludeZeroAmountAndReportEveryDuplicate() public {
        SwarmHarvester.Claim[] memory claims = new SwarmHarvester.Claim[](64);
        bool[] memory expected = new bool[](64);
        uint256 total;
        for (uint256 i; i < 64; ++i) {
            uint256 round = i / 2;
            distributor.setRoot(round, _leaf(alice, round));
            claims[i] = SwarmHarvester.Claim(address(distributor), round, alice, round, new bytes32[](0));
            if (i % 2 == 0) {
                expected[i] = true;
                total += round;
            }
        }
        token.mint(address(distributor), total);
        vm.recordLogs();
        vm.prank(keeper);
        assertEq(harvester.claimMany(claims), 32);
        _checkEvents(vm.getRecordedLogs(), claims, expected);
        assertTrue(distributor.claimed(0, alice), "zero amount claim has a valid terminal state");
        assertEq(token.balanceOf(alice), total);
        assertEq(token.balanceOf(address(distributor)), 0);
        assertEq(token.balanceOf(address(harvester)), 0);
    }

    function _checkEvents(Vm.Log[] memory logs, SwarmHarvester.Claim[] memory claims, bool[] memory expected)
        private
        view
    {
        uint256 next;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(harvester)) continue;
            assertLt(next, claims.length, "extra result event");
            assertEq(logs[i].topics.length, 3);
            assertEq(logs[i].topics[0], keccak256("ClaimResult(address,address,bool)"));
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(claims[next].distributor))));
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(claims[next].account))));
            assertEq(abi.decode(logs[i].data, (bool)), expected[next], "wrong result or event order");
            ++next;
        }
        assertEq(next, claims.length, "missing result event");
    }

    function _claim(MockDistributor d, uint256 round, address account, uint256 amount, bytes32 sibling)
        private
        pure
        returns (SwarmHarvester.Claim memory)
    {
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;
        return SwarmHarvester.Claim(address(d), round, account, amount, proof);
    }

    function _leaf(address account, uint256 amount) private pure returns (bytes32) {
        return keccak256(abi.encode(account, amount));
    }

    function _pair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
