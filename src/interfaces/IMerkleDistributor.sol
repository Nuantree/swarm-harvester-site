// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IMerkleDistributor {
    function claim(uint256 round, address account, uint256 amount, bytes32[] calldata proof) external;
    function claimed(uint256 round, address account) external view returns (bool);
    function token() external view returns (address);
    function treasury() external view returns (address);
}
