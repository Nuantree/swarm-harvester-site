// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @notice Sells the caller's launch tokens to IMD through one or two Uniswap v4 pools.
/// @dev Exact-transfer ERC20s only. No owner, approvals to third parties, or balance-based sweeping.
contract SwarmSeller is ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;
    IERC20 public immutable imd;
    address public constant BURN_SINK = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant FEE_BPS = 50;
    uint256 public constant BPS = 10_000;
    uint256 public constant TOKEN_CALL_GAS_LIMIT = 200_000;
    uint256 public constant SALE_GAS_LIMIT = 2_000_000;

    bytes32 private pendingCallback;

    struct Sale {
        address token;
        uint256 amountIn;
        uint256 minOut;
        PoolKey[] route;
    }

    error InvalidConfiguration();
    error InvalidRecipient();
    error DeadlineExpired();
    error InvalidSale();
    error OnlySelf();
    error InvalidCallback();
    error IncompleteSwap();
    error MinimumOutputNotMet();
    error UnexpectedTokenReturn();
    error SettlementMismatch();

    event SaleResult(uint256 indexed index, address indexed token, bool ok, uint256 grossImdOut);
    event BatchSold(address indexed caller, address indexed recipient, uint256 netImdOut, uint256 burned);

    /// @param poolManager_ Mainnet Uniswap v4 PoolManager from the approved workflow.
    /// @param imd_ Mainnet IMD from the approved workflow. Neither address can be changed.
    constructor(address poolManager_, address imd_) {
        if (poolManager_ == address(0) || imd_ == address(0) || poolManager_ == imd_) {
            revert InvalidConfiguration();
        }
        poolManager = IPoolManager(poolManager_);
        imd = IERC20(imd_);
    }

    /// @notice Pull only msg.sender's tokens. Each failed swap is rolled back and its input refunded.
    /// @param minImdOut Minimum NET output after the single batch fee; failure rolls back everything.
    /// @param deadline Last allowed block timestamp (inclusive).
    /// @return netImdOut IMD paid to recipient, excluding the burned fee.
    function sellMany(Sale[] calldata sales, address recipient, uint256 minImdOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 netImdOut)
    {
        if (recipient == address(0) || recipient == address(this) || recipient == BURN_SINK) {
            revert InvalidRecipient();
        }
        if (block.timestamp > deadline) revert DeadlineExpired();
        uint256 gross = 0;
        for (uint256 i = 0; i < sales.length; ++i) {
            Sale calldata sale = sales[i];
            // Validation precedes any token call. Bad rows do not obstruct valid rows.
            if (!_validSale(sale) || !_pullCallerToken(sale.token, sale.amountIn)) {
                emit SaleResult(i, sale.token, false, 0);
                continue;
            }
            // This call never receives or chooses a payer. Only already-pulled funds are available.
            try this.executeSale{gas: SALE_GAS_LIMIT}(sale) returns (uint256 amountOut) {
                gross += amountOut;
                emit SaleResult(i, sale.token, true, amountOut);
            } catch {
                // A refund failure reverts the batch, restoring all prior transfers and swaps.
                IERC20(sale.token).safeTransfer(msg.sender, sale.amountIn);
                emit SaleResult(i, sale.token, false, 0);
            }
        }
        // floor(gross * 50 / 10_000), written without multiplication overflow.
        uint256 fee = gross / (BPS / FEE_BPS);
        netImdOut = gross - fee;
        if (netImdOut < minImdOut) revert MinimumOutputNotMet();
        if (fee != 0) imd.safeTransfer(BURN_SINK, fee);
        if (netImdOut != 0) imd.safeTransfer(recipient, netImdOut);
        emit BatchSold(msg.sender, recipient, netImdOut, fee);
    }

    /// @dev External solely to give each swap an atomic rollback boundary. Cannot spend allowances.
    function executeSale(Sale calldata sale) external returns (uint256 amountOut) {
        if (msg.sender != address(this)) revert OnlySelf();
        bytes memory data = abi.encode(sale);
        pendingCallback = keccak256(data);
        amountOut = abi.decode(poolManager.unlock(data), (uint256));
        if (pendingCallback != bytes32(0)) revert InvalidCallback();
        if (amountOut < sale.minOut) revert MinimumOutputNotMet();
    }

    /// @dev Authenticates and consumes the one pending callback before any external interaction.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || pendingCallback == bytes32(0) || keccak256(data) != pendingCallback) {
            revert InvalidCallback();
        }
        pendingCallback = bytes32(0);
        Sale memory sale = abi.decode(data, (Sale));
        uint256 amountOut = _swap(sale.route[0], sale.token, sale.amountIn);
        if (sale.route.length == 2) {
            // ETH credit from hop one pays hop two inside the manager. No native transfer is needed.
            amountOut = _swap(sale.route[1], address(0), amountOut);
        }
        if (amountOut < sale.minOut) revert MinimumOutputNotMet();
        poolManager.sync(Currency.wrap(sale.token));
        IERC20(sale.token).safeTransfer(address(poolManager), sale.amountIn);
        if (poolManager.settle() != sale.amountIn) revert SettlementMismatch();
        poolManager.take(Currency.wrap(address(imd)), address(this), amountOut);
        return abi.encode(amountOut);
    }

    function _swap(PoolKey memory key, address input, uint256 amount) private returns (uint256) {
        bool zeroForOne = Currency.unwrap(key.currency0) == input;
        BalanceDelta delta = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            bytes("")
        );
        int128 spent = zeroForOne ? delta.amount0() : delta.amount1();
        int128 received = zeroForOne ? delta.amount1() : delta.amount0();
        // Reject partial fills, zero output and unexpected hook deltas. No dust or native credit remains.
        if (int256(spent) != -int256(amount) || received <= 0) revert IncompleteSwap();
        return uint256(uint128(received));
    }

    function _validSale(Sale calldata sale) private view returns (bool) {
        if (
            sale.token == address(0) || sale.token == address(imd) || sale.token.code.length == 0 || sale.amountIn == 0
                || sale.amountIn > uint256(uint128(type(int128).max))
        ) return false;
        if (sale.route.length == 1) return _matches(sale.route[0], sale.token, address(imd));
        if (sale.route.length == 2) {
            return _matches(sale.route[0], sale.token, address(0)) && _matches(sale.route[1], address(0), address(imd));
        }
        return false;
    }

    function _matches(PoolKey calldata key, address a, address b) private pure returns (bool) {
        return Currency.unwrap(key.currency0) == (a < b ? a : b) && Currency.unwrap(key.currency1) == (a < b ? b : a)
            && key.tickSpacing > 0;
    }

    /// @dev Reverted pulls are safely skipped. Optional return values support ordinary and no-return
    /// ERC20s. A false/malformed successful return aborts the batch: it may have moved tokens already.
    /// Copy at most one word so malicious return/revert data cannot consume batch memory.
    function _pullCallerToken(address token, uint256 amount) private returns (bool success) {
        bytes memory data = abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), amount));
        uint256 size = 0;
        uint256 returned = 0;
        uint256 callGas = TOKEN_CALL_GAS_LIMIT;
        assembly ("memory-safe") {
            success := call(callGas, token, 0, add(data, 32), mload(data), 0, 32)
            size := returndatasize()
            returned := mload(0)
        }
        if (success && size != 0 && (size < 32 || returned != 1)) revert UnexpectedTokenReturn();
    }
}
