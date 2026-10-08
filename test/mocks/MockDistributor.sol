// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMerkleDistributor} from "../../src/interfaces/IMerkleDistributor.sol";

contract MockDistributor is IMerkleDistributor {
    address public immutable token;
    address public immutable treasury;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(uint256 => bytes32) public roots;

    constructor(address token_) {
        token = token_;
        treasury = msg.sender;
    }

    function setRoot(uint256 round, bytes32 root) external {
        roots[round] = root;
    }

    function claim(uint256 round, address account, uint256 amount, bytes32[] calldata proof) external {
        require(!claimed[round][account], "already claimed");
        bytes32 h = keccak256(abi.encode(account, amount));
        for (uint256 i = 0; i < proof.length; ++i) {
            h = h < proof[i] ? keccak256(abi.encodePacked(h, proof[i])) : keccak256(abi.encodePacked(proof[i], h));
        }
        require(h == roots[round], "invalid proof or round");
        claimed[round][account] = true;
        require(IERC20(token).transfer(account, amount), "transfer failed");
    }
}

contract GasGriefDistributor {
    function claim(uint256, address, uint256, bytes32[] calldata) external pure {
        assembly { for {} 1 {} {} }
    }
}

contract RevertBombDistributor {
    function claim(uint256, address, uint256, bytes32[] calldata) external pure {
        assembly { revert(0, 1000000) }
    }
}
