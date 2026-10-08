// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

/// @dev Models v4's signed ledger and settlement; real v4 is exercised separately.
contract MockPoolManager {
    bool private unlocked;
    address private locker;
    address[] private touched;
    mapping(address => int256) public delta;
    mapping(bytes32 => uint8) public modes;
    Currency private synced;
    uint256 private reserve;
    uint8 public callbackMode;
    address public probeTarget;
    bytes public probeData;
    uint256 public rejectedReentries;

    function setMode(PoolKey memory key, uint8 mode) external {
        modes[keccak256(abi.encode(key))] = mode;
    }

    function setCallbackMode(uint8 mode) external {
        callbackMode = mode;
    }

    function setProbe(address target, bytes memory data) external {
        probeTarget = target;
        probeData = data;
    }

    modifier onlyLocker() {
        require(unlocked && msg.sender == locker, "locked");
        _;
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        require(!unlocked, "already unlocked");
        unlocked = true;
        locker = msg.sender;
        if (callbackMode == 1) return abi.encode(uint256(100));
        if (callbackMode == 2) return IUnlockCallback(msg.sender).unlockCallback(abi.encode(uint256(42)));
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        if (callbackMode == 3) IUnlockCallback(msg.sender).unlockCallback(data);
        for (uint256 i = 0; i < touched.length; ++i) {
            require(delta[touched[i]] == 0, "unsettled");
        }
        delete touched;
        unlocked = false;
        locker = address(0);
    }

    function swap(PoolKey memory key, IPoolManager.SwapParams memory params, bytes calldata)
        external
        onlyLocker
        returns (BalanceDelta)
    {
        uint8 mode = modes[keccak256(abi.encode(key))];
        require(mode != 1, "swap failed");
        if (mode == 4) {
            assembly { for {} 1 {} {} }
        }
        if (probeTarget != address(0)) {
            (bool ok,) = probeTarget.call(probeData);
            require(!ok, "reentry succeeded");
            ++rejectedReentries;
        }
        uint256 amount = uint256(-params.amountSpecified);
        if (mode == 2) amount /= 2;
        uint256 output = mode == 3 ? 0 : amount * 2;
        address input = Currency.unwrap(params.zeroForOne ? key.currency0 : key.currency1);
        address out = Currency.unwrap(params.zeroForOne ? key.currency1 : key.currency0);
        delta[input] -= int256(amount);
        delta[out] += int256(output);
        touched.push(input);
        touched.push(out);
        return params.zeroForOne
            ? toBalanceDelta(-int128(int256(amount)), int128(int256(output)))
            : toBalanceDelta(int128(int256(output)), -int128(int256(amount)));
    }

    function sync(Currency currency) external onlyLocker {
        synced = currency;
        reserve = IERC20(Currency.unwrap(currency)).balanceOf(address(this));
    }

    function settle() external payable onlyLocker returns (uint256 paid) {
        paid = IERC20(Currency.unwrap(synced)).balanceOf(address(this)) - reserve;
        delta[Currency.unwrap(synced)] += int256(paid);
    }

    function take(Currency currency, address to, uint256 amount) external onlyLocker {
        delta[Currency.unwrap(currency)] -= int256(amount);
        require(IERC20(Currency.unwrap(currency)).transfer(to, amount), "take failed");
    }
}
