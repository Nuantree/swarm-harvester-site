// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IMerkleDistributor} from "./interfaces/IMerkleDistributor.sol";

/// @notice Permissionless claim submission. Distributors pay the named account directly.
contract SwarmHarvester {
    uint256 public constant CLAIM_GAS_LIMIT = 200_000;

    struct Claim {
        address distributor;
        uint256 round;
        address account;
        uint256 amount;
        bytes32[] proof;
    }

    event ClaimResult(address indexed distributor, address indexed account, bool ok);

    /// @return successes Number of calls that completed without reverting.
    /// @dev Each distributor gets bounded gas; no revert data is copied. Supply enough batch gas.
    function claimMany(Claim[] calldata claims) external returns (uint256 successes) {
        for (uint256 i = 0; i < claims.length; ++i) {
            Claim calldata c = claims[i];
            bool ok = false;
            if (c.distributor.code.length != 0 && c.account != address(0) && c.account != address(this)) {
                try IMerkleDistributor(c.distributor).claim{gas: CLAIM_GAS_LIMIT}(
                    c.round, c.account, c.amount, c.proof
                ) {
                    ok = true;
                    ++successes;
                } catch {}
            }
            emit ClaimResult(c.distributor, c.account, ok);
        }
    }
}
