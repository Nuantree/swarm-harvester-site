// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SwarmHarvester} from "../src/SwarmHarvester.sol";
import {IMerkleDistributor} from "../src/interfaces/IMerkleDistributor.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Optional archive-RPC replay; excluded from the default offline test directory.
contract DistributorForkTest is Test {
    function testDeployedRoundAccountAndDuplicateSemantics() public {
        vm.createSelectFork("https://rpc.mevblocker.io", 26145141);
        assertEq(block.chainid, 1);
        address deployed = address(bytes20(hex"dc542889a9799a8b52d5b41285444dd12c4f916f"));
        IMerkleDistributor distributor = IMerkleDistributor(deployed);
        assertGt(deployed.code.length, 0);
        assertEq(distributor.token(), address(bytes20(hex"450e5910decee15c3ac056e3ed66cb5ea3dd33be")));
        assertEq(distributor.treasury(), address(bytes20(hex"047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7")));
        SwarmHarvester harvester = new SwarmHarvester();
        SwarmHarvester.Claim[] memory claims = new SwarmHarvester.Claim[](1);
        claims[0] = this.decodeHistoricalClaim(
            deployed,
            hex"2e7ba6ef0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c60c81b48bdf107e1651e8ebee971e84885febda00000000000000000000000000000000000000000000407eb16744e982e74f43000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000093602f0c68fa3140d50c060ab5f9cc958e29fc4b0d096e96ed52bdb24d3bb260ca9c836b8afdc45364ce55e6edd8f3e5a216ea6f3d27cb3820679c71b588a191a102e79a807eca8845197842c1d4616eeff7dd053593790f1794c682d9a5c24caef83eb428fd9ba2bb3756cee40b81d78bf544ca60c413f5c7fb1382bc414a17bdf39daa4f26493b1c0bae96a599199143ca138b5513a50a85c47a3b8fa72780c368e5f1ccc78c1ca46e31d1d207a22bc152b0f64b22a01f599fe222ec611fcfb34525d155f884831ace4f5dba9bf029ae72bbfd19e6bfea15f88695b55443232cab28d215c8259e5884b3ea44a5ccdfb94fbaf5a68902d0837a6b93e14950e397eef064e2962d9b6b2d98f7d25198510ec0d9d24946c012940750bef7cb95649"
        );
        assertEq(claims[0].round, 0);
        assertTrue(claims[0].account != address(this));
        assertFalse(distributor.claimed(0, claims[0].account));
        IERC20 token = IERC20(distributor.token());
        uint256 beforeBalance = token.balanceOf(claims[0].account);
        // The same proof cannot be relabelled as another round.
        claims[0].round = 1;
        assertEq(harvester.claimMany(claims), 0);
        claims[0].round = 0;
        // Nor can it be redirected to the submitting keeper.
        address beneficiary = claims[0].account;
        claims[0].account = address(this);
        assertEq(harvester.claimMany(claims), 0);
        claims[0].account = beneficiary;
        assertEq(harvester.claimMany(claims), 1);
        assertTrue(distributor.claimed(0, beneficiary));
        assertEq(token.balanceOf(beneficiary), beforeBalance + claims[0].amount);
        assertEq(token.balanceOf(address(harvester)), 0);
        assertEq(harvester.claimMany(claims), 0);
        assertEq(token.balanceOf(beneficiary), beforeBalance + claims[0].amount);
    }

    function decodeHistoricalClaim(address distributor, bytes calldata data)
        external
        pure
        returns (SwarmHarvester.Claim memory c)
    {
        require(bytes4(data[:4]) == IMerkleDistributor.claim.selector);
        (c.round, c.account, c.amount, c.proof) = abi.decode(data[4:], (uint256, address, uint256, bytes32[]));
        c.distributor = distributor;
    }
}
