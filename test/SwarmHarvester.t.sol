// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SwarmHarvester} from "../src/SwarmHarvester.sol";
import {IMerkleDistributor} from "../src/interfaces/IMerkleDistributor.sol";
import {MockToken} from "./mocks/MockToken.sol";
import {MockDistributor, GasGriefDistributor, RevertBombDistributor} from "./mocks/MockDistributor.sol";

contract SwarmHarvesterTest is Test {
    SwarmHarvester private harvester;
    MockToken private token;
    MockDistributor private distributor;
    address private account;

    function setUp() public {
        harvester = new SwarmHarvester();
        token = new MockToken();
        distributor = new MockDistributor(address(token));
        token.mint(address(distributor), 1e30);
        account = makeAddr("beneficiary");
    }

    function _claim(uint256 round, uint256 amount) private returns (SwarmHarvester.Claim memory) {
        distributor.setRoot(round, keccak256(abi.encode(account, amount)));
        return SwarmHarvester.Claim(address(distributor), round, account, amount, new bytes32[](0));
    }

    function testSelectors() public pure {
        assertEq(IMerkleDistributor.claim.selector, bytes4(0x2e7ba6ef));
        assertEq(IMerkleDistributor.claimed.selector, bytes4(0x120aa877));
    }

    function testKeeperPaysAccountAndSkipsDuplicateBadProofAndWrongRound() public {
        SwarmHarvester.Claim[] memory claims = new SwarmHarvester.Claim[](5);
        claims[0] = _claim(7, 100);
        claims[1] = _claim(7, 100);
        claims[2] = _claim(8, 200);
        claims[2].amount = 201;
        claims[3] = _claim(9, 300);
        claims[3].round = 999;
        claims[4] = _claim(10, 400);
        vm.expectEmit(true, true, false, true);
        emit SwarmHarvester.ClaimResult(address(distributor), account, true);
        vm.expectEmit(true, true, false, true);
        emit SwarmHarvester.ClaimResult(address(distributor), account, false);
        vm.prank(makeAddr("keeper"));
        assertEq(harvester.claimMany(claims), 2);
        assertEq(token.balanceOf(account), 500);
        assertEq(token.balanceOf(address(harvester)), 0);
        assertTrue(distributor.claimed(7, account));
        assertFalse(distributor.claimed(8, account));
        assertFalse(distributor.claimed(9, account));
    }

    function testGasGriefRevertBombAndEOADoNotStopFollowingClaim() public {
        SwarmHarvester.Claim[] memory claims = new SwarmHarvester.Claim[](4);
        claims[0] = _claim(1, 10);
        claims[0].distributor = address(new GasGriefDistributor());
        claims[1] = _claim(2, 10);
        claims[1].distributor = address(new RevertBombDistributor());
        claims[2] = _claim(3, 10);
        claims[2].distributor = makeAddr("eoa");
        claims[3] = _claim(4, 10);
        assertEq(harvester.claimMany(claims), 1);
        assertEq(token.balanceOf(account), 10);
    }

    function testRejectsSelfAndZeroAccount() public {
        SwarmHarvester.Claim[] memory claims = new SwarmHarvester.Claim[](2);
        claims[0] = _claim(1, 10);
        claims[0].account = address(harvester);
        distributor.setRoot(1, keccak256(abi.encode(address(harvester), uint256(10))));
        claims[1] = _claim(2, 10);
        claims[1].account = address(0);
        assertEq(harvester.claimMany(claims), 0);
        assertEq(token.balanceOf(address(harvester)), 0);
    }

    function testEmptyBatch() public {
        assertEq(harvester.claimMany(new SwarmHarvester.Claim[](0)), 0);
    }

    function testFuzzConservation(uint96 amount, uint32 round) public {
        SwarmHarvester.Claim[] memory claims = new SwarmHarvester.Claim[](1);
        claims[0] = _claim(round, amount);
        assertEq(harvester.claimMany(claims), 1);
        assertEq(harvester.claimMany(claims), 0);
        assertEq(token.balanceOf(account), amount);
        assertEq(token.balanceOf(address(distributor)) + token.balanceOf(account), 1e30);
        assertEq(token.balanceOf(address(harvester)), 0);
    }
}
