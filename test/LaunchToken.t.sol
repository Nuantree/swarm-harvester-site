// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LaunchToken} from "../src/LaunchToken.sol";

contract LaunchTokenTest is Test {
    LaunchToken private token;

    function setUp() public {
        token = new LaunchToken();
    }

    function testMetadataFactorySupplyAndTransfer() public {
        assertEq(token.name(), "Swarm Harvester");
        assertEq(token.symbol(), "HARVEST");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), 1e27);
        assertEq(token.balanceOf(address(this)), 1e27);
        address recipient = makeAddr("recipient");
        assertTrue(token.transfer(recipient, 123));
        assertEq(token.balanceOf(recipient), 123);
        assertEq(token.balanceOf(address(this)), 1e27 - 123);
        assertEq(token.totalSupply(), 1e27);
    }

    function testFuzzTransferAndAllowance(uint256 amount) public {
        amount = bound(amount, 1, 1e27);
        address user = makeAddr("user");
        token.approve(user, amount);
        vm.prank(user);
        token.transferFrom(address(this), user, amount);
        assertEq(token.balanceOf(user), amount);
        assertEq(token.balanceOf(address(this)), 1e27 - amount);
        assertEq(token.allowance(address(this), user), 0);
        vm.prank(user);
        vm.expectRevert();
        token.transferFrom(address(this), user, 1);
        assertEq(token.totalSupply(), 1e27);
    }

    function testTransferRejectsZeroAndExcessBalance() public {
        vm.expectRevert();
        token.transfer(address(0), 1);
        vm.expectRevert();
        token.transfer(makeAddr("user"), 1e27 + 1);
    }

    function testNoMintOrOwnershipEntrypoints() public {
        (bool mintOk,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", address(this), 1));
        (bool ownerOk,) = address(token).call(abi.encodeWithSignature("transferOwnership(address)", address(this)));
        assertFalse(mintOk);
        assertFalse(ownerOk);
        assertEq(token.totalSupply(), 1e27);
    }
}
