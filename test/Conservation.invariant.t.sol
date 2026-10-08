// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SwarmSeller} from "../src/SwarmSeller.sol";
import {SwarmHarvester} from "../src/SwarmHarvester.sol";
import {MockToken} from "./mocks/MockToken.sol";
import {MockDistributor} from "./mocks/MockDistributor.sol";
import {MockPoolManager} from "./mocks/MockPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

contract ConservationHandler {
    MockToken public token;
    MockToken public imd;
    MockPoolManager public manager;
    SwarmSeller public seller;
    SwarmHarvester public harvester;
    MockDistributor public distributor;
    uint256 public expectedBurn;
    uint256 public expectedNet;
    uint256 public expectedInputSpent;
    uint256 public mintedInput;
    uint256 public nextRound;

    constructor() {
        token = new MockToken();
        imd = new MockToken();
        manager = new MockPoolManager();
        seller = new SwarmSeller(address(manager), address(imd));
        harvester = new SwarmHarvester();
        distributor = new MockDistributor(address(token));
        imd.mint(address(manager), 1e32);
    }

    function sell(uint96 seed, bool fail, bool viaEth) external {
        uint256 amount = uint256(seed) % 1e24 + 1;
        token.mint(address(this), amount);
        mintedInput += amount;
        token.approve(address(seller), amount);
        uint256 gross = amount * (viaEth ? 4 : 2);
        PoolKey[] memory route = new PoolKey[](viaEth ? 2 : 1);
        route[0] = _key(address(token), viaEth ? address(0) : address(imd));
        if (viaEth) route[1] = _key(address(0), address(imd));
        SwarmSeller.Sale[] memory sales = new SwarmSeller.Sale[](1);
        sales[0] = SwarmSeller.Sale(address(token), amount, fail ? gross + 1 : gross, route);
        uint256 net = seller.sellMany(sales, address(this), 0, block.timestamp);
        if (!fail) {
            expectedBurn += gross / 200;
            expectedNet += gross - gross / 200;
            expectedInputSpent += amount;
            require(net == gross - gross / 200);
        } else {
            require(net == 0);
        }
    }

    function harvest(uint96 seed) external {
        uint256 amount = uint256(seed) % 1e24;
        token.mint(address(distributor), amount);
        mintedInput += amount;
        uint256 round = nextRound++;
        distributor.setRoot(round, keccak256(abi.encode(address(this), amount)));
        SwarmHarvester.Claim[] memory claims = new SwarmHarvester.Claim[](1);
        claims[0] = SwarmHarvester.Claim(address(distributor), round, address(this), amount, new bytes32[](0));
        require(harvester.claimMany(claims) == 1);
        require(harvester.claimMany(claims) == 0);
    }

    function _key(address a, address b) private pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(a < b ? a : b), Currency.wrap(a < b ? b : a), 3000, 60, IHooks(address(0)));
    }
}

contract ConservationInvariantTest is Test {
    ConservationHandler private handler;

    function setUp() public {
        handler = new ConservationHandler();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = handler.sell.selector;
        selectors[1] = handler.harvest.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }

    function invariantNoCustodyAndExactFeeConservation() public view {
        MockToken token = handler.token();
        MockToken imd = handler.imd();
        SwarmSeller seller = handler.seller();
        assertEq(token.balanceOf(address(seller)), 0);
        assertEq(imd.balanceOf(address(seller)), 0);
        assertEq(address(seller).balance, 0);
        assertEq(token.balanceOf(address(handler.harvester())), 0);
        assertEq(token.balanceOf(address(handler.distributor())), 0);
        assertEq(imd.balanceOf(seller.BURN_SINK()), handler.expectedBurn());
        assertEq(imd.balanceOf(address(handler)), handler.expectedNet());
        assertEq(token.balanceOf(address(handler.manager())), handler.expectedInputSpent());
        assertEq(token.balanceOf(address(handler)) + handler.expectedInputSpent(), handler.mintedInput());
        assertEq(imd.balanceOf(address(handler.manager())) + handler.expectedBurn() + handler.expectedNet(), 1e32);
    }
}
