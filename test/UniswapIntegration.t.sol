// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwarmSeller} from "../src/SwarmSeller.sol";
import {MockToken} from "./mocks/MockToken.sol";

/// @notice Network-free integration against the actual v4.0.0 core implementation.
contract UniswapIntegrationTest is Test, IUnlockCallback {
    PoolManager private manager;
    MockToken private token;
    MockToken private imd;
    SwarmSeller private seller;
    address private alice;
    address private recipient;

    function setUp() public {
        manager = new PoolManager(address(this));
        token = new MockToken();
        imd = new MockToken();
        seller = new SwarmSeller(address(manager), address(imd));
        alice = makeAddr("alice");
        recipient = makeAddr("recipient");
        token.mint(address(this), 1e30);
        imd.mint(address(this), 1e30);
        token.mint(alice, 1e24);
        vm.prank(alice);
        token.approve(address(seller), 1e24);
        vm.deal(address(this), 1e30);
        _seed(_key(address(token), address(imd)));
        _seed(_key(address(0), address(token)));
        _seed(_key(address(0), address(imd)));
    }

    function _key(address a, address b) private pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(a < b ? a : b), Currency.wrap(a < b ? b : a), 3000, 60, IHooks(address(0)));
    }

    function _seed(PoolKey memory key) private {
        manager.initialize(key, 79228162514264337593543950336);
        manager.unlock(abi.encode(key));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager));
        PoolKey memory key = abi.decode(data, (PoolKey));
        (BalanceDelta delta,) = manager.modifyLiquidity(
            key, IPoolManager.ModifyLiquidityParams(-887220, 887220, 1e24, bytes32(0)), bytes("")
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

    function _sale(bool viaEth) private view returns (SwarmSeller.Sale memory) {
        PoolKey[] memory route = new PoolKey[](viaEth ? 2 : 1);
        route[0] = _key(address(token), viaEth ? address(0) : address(imd));
        if (viaEth) route[1] = _key(address(0), address(imd));
        return SwarmSeller.Sale(address(token), 1 ether, 0.98 ether, route);
    }

    function testRealV4DirectAndNativeRoutes() public {
        SwarmSeller.Sale[] memory sales = new SwarmSeller.Sale[](2);
        sales[0] = _sale(false);
        sales[1] = _sale(true);
        uint256 managerBefore = imd.balanceOf(address(manager));
        vm.prank(alice);
        uint256 net = seller.sellMany(sales, recipient, 1.97 ether, block.timestamp);
        uint256 gross = managerBefore - imd.balanceOf(address(manager));
        assertGt(gross, 1.98 ether);
        assertLt(gross, 2 ether);
        assertEq(imd.balanceOf(seller.BURN_SINK()), gross / 200);
        assertEq(imd.balanceOf(recipient), net);
        assertEq(net + gross / 200, gross);
        assertEq(token.balanceOf(alice), 1e24 - 2 ether);
        assertEq(token.balanceOf(address(seller)), 0);
        assertEq(imd.balanceOf(address(seller)), 0);
        assertEq(address(seller).balance, 0);
    }

    function testRealV4MissingPoolIsRefundedAndNextSaleSucceeds() public {
        SwarmSeller.Sale[] memory sales = new SwarmSeller.Sale[](2);
        sales[0] = _sale(false);
        sales[0].route[0].fee = 500;
        sales[1] = _sale(true);
        vm.prank(alice);
        uint256 net = seller.sellMany(sales, recipient, 0.98 ether, block.timestamp);
        assertGt(net, 0.98 ether);
        assertEq(token.balanceOf(alice), 1e24 - 1 ether);
        assertEq(token.balanceOf(address(seller)), 0);
        assertEq(imd.balanceOf(address(seller)), 0);
    }

    function testRealV4PerSaleMinimumRollsBackPoolAndRefunds() public {
        SwarmSeller.Sale[] memory sales = new SwarmSeller.Sale[](1);
        sales[0] = _sale(true);
        sales[0].minOut = 2 ether;
        uint256 beforeInput = token.balanceOf(address(manager));
        uint256 beforeOutput = imd.balanceOf(address(manager));
        vm.prank(alice);
        assertEq(seller.sellMany(sales, recipient, 0, block.timestamp), 0);
        assertEq(token.balanceOf(alice), 1e24);
        assertEq(token.balanceOf(address(manager)), beforeInput);
        assertEq(imd.balanceOf(address(manager)), beforeOutput);
        assertEq(token.balanceOf(address(seller)), 0);
    }
}
