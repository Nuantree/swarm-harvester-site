// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockToken is ERC20 {
    uint8 public returnMode;
    bool public rejectPull;
    address public rejectedRecipient;
    address public probeTarget;
    bytes public probeData;
    uint256 public rejectedReentries;
    bool public taxed;

    constructor() ERC20("Test token", "TEST") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setReturnMode(uint8 mode) external {
        returnMode = mode;
    }

    function setRejectPull(bool reject) external {
        rejectPull = reject;
    }

    function setRejectedRecipient(address recipient) external {
        rejectedRecipient = recipient;
    }

    function setTaxed(bool value) external {
        taxed = value;
    }

    function setProbe(address target, bytes memory data) external {
        probeTarget = target;
        probeData = data;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        require(!rejectPull, "pull rejected");
        _probe();
        super.transferFrom(from, to, amount);
        if (returnMode == 1) {
            assembly ("memory-safe") { return(0, 0) }
        }
        if (returnMode == 2) return false;
        if (returnMode == 3) {
            assembly ("memory-safe") {
                mstore(0, 1)
                return(31, 1)
            }
        }
        return true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        require(to != rejectedRecipient, "transfer rejected");
        _probe();
        return super.transfer(to, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (taxed && from != address(0) && to != address(0) && amount >= 100) {
            super._update(from, address(0), amount / 100);
            amount -= amount / 100;
        }
        super._update(from, to, amount);
    }

    function _probe() private {
        if (probeTarget != address(0)) {
            (bool ok,) = probeTarget.call(probeData);
            require(!ok, "reentry unexpectedly succeeded");
            ++rejectedReentries;
        }
    }
}
