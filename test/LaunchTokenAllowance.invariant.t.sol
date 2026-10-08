// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LaunchToken} from "src/LaunchToken.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

/// @dev Funding happens once. Balances and approvals are predicted from requested
/// operations, never copied from the token after a call.
contract LaunchTokenAllowanceHandler is Test {
    LaunchToken public immutable token;
    address[4] public actors;
    uint256[4] public balances;
    mapping(uint256 => mapping(uint256 => uint256)) public allowances;
    uint256 public delegatedTransfers;
    uint256 public rejectedTransfers;

    constructor() {
        token = new LaunchToken();
        for (uint256 i; i < 4; ++i) {
            actors[i] = makeAddr(string.concat("allowance actor ", vm.toString(i)));
            balances[i] = 1e27 / 4;
            token.transfer(actors[i], balances[i]);
        }
    }

    function approve(uint256 ownerSeed, uint256 spenderSeed, uint256 seed, uint8 mode) external {
        uint256 owner = ownerSeed % 4;
        uint256 spender = spenderSeed % 4;
        uint256 amount = mode % 3 == 0 ? 0 : mode % 3 == 1 ? bound(seed, 0, 1e27) : type(uint256).max;
        vm.prank(actors[owner]);
        assertTrue(token.approve(actors[spender], amount));
        allowances[owner][spender] = amount;
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 seed, uint8 mode) external {
        uint256 from = fromSeed % 4;
        uint256 to = toSeed % 4;
        uint256 amount =
            mode % 3 == 0 ? balances[from] : mode % 3 == 1 ? balances[from] + 1 : bound(seed, 0, balances[from]);
        vm.prank(actors[from]);
        if (amount > balances[from]) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IERC20Errors.ERC20InsufficientBalance.selector, actors[from], balances[from], amount
                )
            );
            token.transfer(actors[to], amount);
            ++rejectedTransfers;
        } else {
            assertTrue(token.transfer(actors[to], amount));
            balances[from] -= amount;
            balances[to] += amount;
        }
    }

    function transferFrom(uint256 ownerSeed, uint256 spenderSeed, uint256 toSeed, uint256 seed, uint8 mode) external {
        uint256 owner = ownerSeed % 4;
        uint256 spender = spenderSeed % 4;
        uint256 to = toSeed % 4;
        uint256 approved = allowances[owner][spender];
        uint256 available = balances[owner] < approved ? balances[owner] : approved;
        uint256 amount;
        mode %= 6;
        if (mode == 1) amount = bound(seed, 0, available);
        if (mode == 2) amount = balances[owner] + 1;
        if (mode == 3) amount = approved == type(uint256).max ? balances[owner] + 1 : approved + 1;
        if (mode == 4) amount = balances[owner];
        if (mode == 5) amount = type(uint256).max;

        vm.prank(actors[spender]);
        if (amount > approved) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IERC20Errors.ERC20InsufficientAllowance.selector, actors[spender], approved, amount
                )
            );
            token.transferFrom(actors[owner], actors[to], amount);
            ++rejectedTransfers;
        } else if (amount > balances[owner]) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IERC20Errors.ERC20InsufficientBalance.selector, actors[owner], balances[owner], amount
                )
            );
            token.transferFrom(actors[owner], actors[to], amount);
            ++rejectedTransfers;
        } else {
            assertTrue(token.transferFrom(actors[owner], actors[to], amount));
            balances[owner] -= amount;
            balances[to] += amount;
            if (approved != type(uint256).max) allowances[owner][spender] -= amount;
            ++delegatedTransfers;
        }
    }

    function rejectZeroRecipient(uint256 ownerSeed, uint256 spenderSeed, uint256 seed) external {
        uint256 owner = ownerSeed % 4;
        uint256 spender = spenderSeed % 4;
        uint256 approved = allowances[owner][spender];
        uint256 available = balances[owner] < approved ? balances[owner] : approved;
        uint256 amount = bound(seed, 0, available);
        vm.prank(actors[spender]);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        token.transferFrom(actors[owner], address(0), amount);
        ++rejectedTransfers;
    }

    function assertLedgers() external view {
        uint256 sum;
        for (uint256 i; i < 4; ++i) {
            assertEq(token.balanceOf(actors[i]), balances[i], "balance differs from operation ledger");
            sum += token.balanceOf(actors[i]);
            for (uint256 j; j < 4; ++j) {
                assertEq(token.allowance(actors[i], actors[j]), allowances[i][j], "approval changed unexpectedly");
            }
        }
        assertEq(sum, 1e27, "tokens created or lost");
        assertEq(token.totalSupply(), 1e27, "fixed supply changed");
        assertEq(token.balanceOf(address(this)), 0, "deployer retained supply");
        assertEq(token.balanceOf(address(0)), 0, "invalid transfer burned supply");
    }
}

contract LaunchTokenAllowanceInvariantTest is Test {
    LaunchTokenAllowanceHandler private handler;

    function setUp() public {
        handler = new LaunchTokenAllowanceHandler();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.approve.selector;
        selectors[1] = handler.transfer.selector;
        selectors[2] = handler.transferFrom.selector;
        selectors[3] = handler.rejectZeroRecipient.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_TransfersPreserveSupplyAndRequireCurrentApproval() public view {
        handler.assertLedgers();
    }

    function test_RevocationOverwriteSelfTransferAndFailedSpendSequence() public {
        handler.approve(0, 1, 10, 1);
        handler.transferFrom(0, 1, 2, 4, 1);
        handler.assertLedgers();
        assertEq(handler.allowances(0, 1), 6);
        handler.approve(0, 1, 2, 1); // Approval replaces the remaining six.
        handler.transferFrom(0, 1, 2, 0, 3); // Attempt to spend three.
        handler.rejectZeroRecipient(0, 1, 1); // Revert must restore the allowance.
        handler.assertLedgers();
        assertEq(handler.allowances(0, 1), 2);
        handler.approve(0, 1, 0, 0);
        handler.transferFrom(0, 1, 2, 0, 3);
        handler.approve(0, 1, 0, 2);
        handler.transferFrom(0, 1, 0, 1, 1); // Delegated self-transfer.
        handler.transferFrom(0, 1, 2, 0, 2); // Enough approval, insufficient balance.
        handler.assertLedgers();
        assertEq(handler.allowances(0, 1), type(uint256).max);
        assertEq(handler.delegatedTransfers(), 2);
        assertEq(handler.rejectedTransfers(), 4);
    }

    function test_FullSupplyRoundTripAndZeroTransfers() public {
        LaunchToken token = new LaunchToken();
        address spender = makeAddr("full supply spender");
        token.approve(spender, type(uint256).max);
        vm.startPrank(spender);
        assertTrue(token.transferFrom(address(this), spender, 1e27));
        assertTrue(token.transfer(address(this), 1e27));
        // A zero transfer from an empty wallet must still succeed.
        assertTrue(token.transfer(address(this), 0));
        assertTrue(token.transferFrom(address(this), address(this), 0));
        vm.stopPrank();
        assertEq(token.balanceOf(address(this)), 1e27);
        assertEq(token.balanceOf(spender), 0);
        assertEq(token.allowance(address(this), spender), type(uint256).max);
        assertEq(token.totalSupply(), 1e27);
    }

    function test_FiniteApprovalSurvivesInsufficientBalanceAndInvalidRecipient() public {
        LaunchToken token = new LaunchToken();
        address spender = makeAddr("finite spender");
        token.approve(spender, 1e27 + 1);
        vm.prank(spender);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(this), 1e27, 1e27 + 1)
        );
        token.transferFrom(address(this), spender, 1e27 + 1);
        assertEq(token.allowance(address(this), spender), 1e27 + 1);
        vm.prank(spender);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        token.transferFrom(address(this), address(0), 1);
        assertEq(token.allowance(address(this), spender), 1e27 + 1);
        assertEq(token.balanceOf(address(this)), 1e27);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidSpender.selector, address(0)));
        token.approve(address(0), type(uint256).max);
        assertEq(token.allowance(address(this), address(0)), 0);
        assertEq(token.totalSupply(), 1e27);
    }
}
