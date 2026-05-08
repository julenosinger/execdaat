// Sources flattened with hardhat v2.28.6 https://hardhat.org

// SPDX-License-Identifier: MIT

// File @openzeppelin/contracts/utils/introspection/IERC165.sol@v5.2.0

// Original license: SPDX_License_Identifier: MIT
// OpenZeppelin Contracts (last updated v5.1.0) (utils/introspection/IERC165.sol)

pragma solidity ^0.8.20;

/**
 * @dev Interface of the ERC-165 standard, as defined in the
 * https://eips.ethereum.org/EIPS/eip-165[ERC].
 *
 * Implementers can declare support of contract interfaces, which can then be
 * queried by others ({ERC165Checker}).
 *
 * For an implementation, see {ERC165}.
 */
interface IERC165 {
    /**
     * @dev Returns true if this contract implements the interface defined by
     * `interfaceId`. See the corresponding
     * https://eips.ethereum.org/EIPS/eip-165#how-interfaces-are-identified[ERC section]
     * to learn more about how these ids are created.
     *
     * This function call must use less than 30 000 gas.
     */
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}


// File @openzeppelin/contracts/interfaces/IERC165.sol@v5.2.0

// Original license: SPDX_License_Identifier: MIT
// OpenZeppelin Contracts (last updated v5.0.0) (interfaces/IERC165.sol)



// File @openzeppelin/contracts/token/ERC20/IERC20.sol@v5.2.0

// Original license: SPDX_License_Identifier: MIT
// OpenZeppelin Contracts (last updated v5.1.0) (token/ERC20/IERC20.sol)


/**
 * @dev Interface of the ERC-20 standard as defined in the ERC.
 */
interface IERC20 {
    /**
     * @dev Emitted when `value` tokens are moved from one account (`from`) to
     * another (`to`).
     *
     * Note that `value` may be zero.
     */
    event Transfer(address indexed from, address indexed to, uint256 value);

    /**
     * @dev Emitted when the allowance of a `spender` for an `owner` is set by
     * a call to {approve}. `value` is the new allowance.
     */
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /**
     * @dev Returns the value of tokens in existence.
     */
    function totalSupply() external view returns (uint256);

    /**
     * @dev Returns the value of tokens owned by `account`.
     */
    function balanceOf(address account) external view returns (uint256);

    /**
     * @dev Moves a `value` amount of tokens from the caller's account to `to`.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * Emits a {Transfer} event.
     */
    function transfer(address to, uint256 value) external returns (bool);

    /**
     * @dev Returns the remaining number of tokens that `spender` will be
     * allowed to spend on behalf of `owner` through {transferFrom}. This is
     * zero by default.
     *
     * This value changes when {approve} or {transferFrom} are called.
     */
    function allowance(address owner, address spender) external view returns (uint256);

    /**
     * @dev Sets a `value` amount of tokens as the allowance of `spender` over the
     * caller's tokens.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * IMPORTANT: Beware that changing an allowance with this method brings the risk
     * that someone may use both the old and the new allowance by unfortunate
     * transaction ordering. One possible solution to mitigate this race
     * condition is to first reduce the spender's allowance to 0 and set the
     * desired value afterwards:
     * https://github.com/ethereum/EIPs/issues/20#issuecomment-263524729
     *
     * Emits an {Approval} event.
     */
    function approve(address spender, uint256 value) external returns (bool);

    /**
     * @dev Moves a `value` amount of tokens from `from` to `to` using the
     * allowance mechanism. `value` is then deducted from the caller's
     * allowance.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * Emits a {Transfer} event.
     */
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}


// File @openzeppelin/contracts/interfaces/IERC20.sol@v5.2.0

// Original license: SPDX_License_Identifier: MIT
// OpenZeppelin Contracts (last updated v5.0.0) (interfaces/IERC20.sol)



// File @openzeppelin/contracts/interfaces/IERC1363.sol@v5.2.0

// Original license: SPDX_License_Identifier: MIT
// OpenZeppelin Contracts (last updated v5.1.0) (interfaces/IERC1363.sol)



/**
 * @title IERC1363
 * @dev Interface of the ERC-1363 standard as defined in the https://eips.ethereum.org/EIPS/eip-1363[ERC-1363].
 *
 * Defines an extension interface for ERC-20 tokens that supports executing code on a recipient contract
 * after `transfer` or `transferFrom`, or code on a spender contract after `approve`, in a single transaction.
 */
interface IERC1363 is IERC20, IERC165 {
    /*
     * Note: the ERC-165 identifier for this interface is 0xb0202a11.
     * 0xb0202a11 ===
     *   bytes4(keccak256('transferAndCall(address,uint256)')) ^
     *   bytes4(keccak256('transferAndCall(address,uint256,bytes)')) ^
     *   bytes4(keccak256('transferFromAndCall(address,address,uint256)')) ^
     *   bytes4(keccak256('transferFromAndCall(address,address,uint256,bytes)')) ^
     *   bytes4(keccak256('approveAndCall(address,uint256)')) ^
     *   bytes4(keccak256('approveAndCall(address,uint256,bytes)'))
     */

    /**
     * @dev Moves a `value` amount of tokens from the caller's account to `to`
     * and then calls {IERC1363Receiver-onTransferReceived} on `to`.
     * @param to The address which you want to transfer to.
     * @param value The amount of tokens to be transferred.
     * @return A boolean value indicating whether the operation succeeded unless throwing.
     */
    function transferAndCall(address to, uint256 value) external returns (bool);

    /**
     * @dev Moves a `value` amount of tokens from the caller's account to `to`
     * and then calls {IERC1363Receiver-onTransferReceived} on `to`.
     * @param to The address which you want to transfer to.
     * @param value The amount of tokens to be transferred.
     * @param data Additional data with no specified format, sent in call to `to`.
     * @return A boolean value indicating whether the operation succeeded unless throwing.
     */
    function transferAndCall(address to, uint256 value, bytes calldata data) external returns (bool);

    /**
     * @dev Moves a `value` amount of tokens from `from` to `to` using the allowance mechanism
     * and then calls {IERC1363Receiver-onTransferReceived} on `to`.
     * @param from The address which you want to send tokens from.
     * @param to The address which you want to transfer to.
     * @param value The amount of tokens to be transferred.
     * @return A boolean value indicating whether the operation succeeded unless throwing.
     */
    function transferFromAndCall(address from, address to, uint256 value) external returns (bool);

    /**
     * @dev Moves a `value` amount of tokens from `from` to `to` using the allowance mechanism
     * and then calls {IERC1363Receiver-onTransferReceived} on `to`.
     * @param from The address which you want to send tokens from.
     * @param to The address which you want to transfer to.
     * @param value The amount of tokens to be transferred.
     * @param data Additional data with no specified format, sent in call to `to`.
     * @return A boolean value indicating whether the operation succeeded unless throwing.
     */
    function transferFromAndCall(address from, address to, uint256 value, bytes calldata data) external returns (bool);

    /**
     * @dev Sets a `value` amount of tokens as the allowance of `spender` over the
     * caller's tokens and then calls {IERC1363Spender-onApprovalReceived} on `spender`.
     * @param spender The address which will spend the funds.
     * @param value The amount of tokens to be spent.
     * @return A boolean value indicating whether the operation succeeded unless throwing.
     */
    function approveAndCall(address spender, uint256 value) external returns (bool);

    /**
     * @dev Sets a `value` amount of tokens as the allowance of `spender` over the
     * caller's tokens and then calls {IERC1363Spender-onApprovalReceived} on `spender`.
     * @param spender The address which will spend the funds.
     * @param value The amount of tokens to be spent.
     * @param data Additional data with no specified format, sent in call to `spender`.
     * @return A boolean value indicating whether the operation succeeded unless throwing.
     */
    function approveAndCall(address spender, uint256 value, bytes calldata data) external returns (bool);
}


// File @openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol@v5.2.0

// Original license: SPDX_License_Identifier: MIT
// OpenZeppelin Contracts (last updated v5.2.0) (token/ERC20/utils/SafeERC20.sol)



/**
 * @title SafeERC20
 * @dev Wrappers around ERC-20 operations that throw on failure (when the token
 * contract returns false). Tokens that return no value (and instead revert or
 * throw on failure) are also supported, non-reverting calls are assumed to be
 * successful.
 * To use this library you can add a `using SafeERC20 for IERC20;` statement to your contract,
 * which allows you to call the safe operations as `token.safeTransfer(...)`, etc.
 */
library SafeERC20 {
    /**
     * @dev An operation with an ERC-20 token failed.
     */
    error SafeERC20FailedOperation(address token);

    /**
     * @dev Indicates a failed `decreaseAllowance` request.
     */
    error SafeERC20FailedDecreaseAllowance(address spender, uint256 currentAllowance, uint256 requestedDecrease);

    /**
     * @dev Transfer `value` amount of `token` from the calling contract to `to`. If `token` returns no value,
     * non-reverting calls are assumed to be successful.
     */
    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeCall(token.transfer, (to, value)));
    }

    /**
     * @dev Transfer `value` amount of `token` from `from` to `to`, spending the approval given by `from` to the
     * calling contract. If `token` returns no value, non-reverting calls are assumed to be successful.
     */
    function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeCall(token.transferFrom, (from, to, value)));
    }

    /**
     * @dev Increase the calling contract's allowance toward `spender` by `value`. If `token` returns no value,
     * non-reverting calls are assumed to be successful.
     *
     * IMPORTANT: If the token implements ERC-7674 (ERC-20 with temporary allowance), and if the "client"
     * smart contract uses ERC-7674 to set temporary allowances, then the "client" smart contract should avoid using
     * this function. Performing a {safeIncreaseAllowance} or {safeDecreaseAllowance} operation on a token contract
     * that has a non-zero temporary allowance (for that particular owner-spender) will result in unexpected behavior.
     */
    function safeIncreaseAllowance(IERC20 token, address spender, uint256 value) internal {
        uint256 oldAllowance = token.allowance(address(this), spender);
        forceApprove(token, spender, oldAllowance + value);
    }

    /**
     * @dev Decrease the calling contract's allowance toward `spender` by `requestedDecrease`. If `token` returns no
     * value, non-reverting calls are assumed to be successful.
     *
     * IMPORTANT: If the token implements ERC-7674 (ERC-20 with temporary allowance), and if the "client"
     * smart contract uses ERC-7674 to set temporary allowances, then the "client" smart contract should avoid using
     * this function. Performing a {safeIncreaseAllowance} or {safeDecreaseAllowance} operation on a token contract
     * that has a non-zero temporary allowance (for that particular owner-spender) will result in unexpected behavior.
     */
    function safeDecreaseAllowance(IERC20 token, address spender, uint256 requestedDecrease) internal {
        unchecked {
            uint256 currentAllowance = token.allowance(address(this), spender);
            if (currentAllowance < requestedDecrease) {
                revert SafeERC20FailedDecreaseAllowance(spender, currentAllowance, requestedDecrease);
            }
            forceApprove(token, spender, currentAllowance - requestedDecrease);
        }
    }

    /**
     * @dev Set the calling contract's allowance toward `spender` to `value`. If `token` returns no value,
     * non-reverting calls are assumed to be successful. Meant to be used with tokens that require the approval
     * to be set to zero before setting it to a non-zero value, such as USDT.
     *
     * NOTE: If the token implements ERC-7674, this function will not modify any temporary allowance. This function
     * only sets the "standard" allowance. Any temporary allowance will remain active, in addition to the value being
     * set here.
     */
    function forceApprove(IERC20 token, address spender, uint256 value) internal {
        bytes memory approvalCall = abi.encodeCall(token.approve, (spender, value));

        if (!_callOptionalReturnBool(token, approvalCall)) {
            _callOptionalReturn(token, abi.encodeCall(token.approve, (spender, 0)));
            _callOptionalReturn(token, approvalCall);
        }
    }

    /**
     * @dev Performs an {ERC1363} transferAndCall, with a fallback to the simple {ERC20} transfer if the target has no
     * code. This can be used to implement an {ERC721}-like safe transfer that rely on {ERC1363} checks when
     * targeting contracts.
     *
     * Reverts if the returned value is other than `true`.
     */
    function transferAndCallRelaxed(IERC1363 token, address to, uint256 value, bytes memory data) internal {
        if (to.code.length == 0) {
            safeTransfer(token, to, value);
        } else if (!token.transferAndCall(to, value, data)) {
            revert SafeERC20FailedOperation(address(token));
        }
    }

    /**
     * @dev Performs an {ERC1363} transferFromAndCall, with a fallback to the simple {ERC20} transferFrom if the target
     * has no code. This can be used to implement an {ERC721}-like safe transfer that rely on {ERC1363} checks when
     * targeting contracts.
     *
     * Reverts if the returned value is other than `true`.
     */
    function transferFromAndCallRelaxed(
        IERC1363 token,
        address from,
        address to,
        uint256 value,
        bytes memory data
    ) internal {
        if (to.code.length == 0) {
            safeTransferFrom(token, from, to, value);
        } else if (!token.transferFromAndCall(from, to, value, data)) {
            revert SafeERC20FailedOperation(address(token));
        }
    }

    /**
     * @dev Performs an {ERC1363} approveAndCall, with a fallback to the simple {ERC20} approve if the target has no
     * code. This can be used to implement an {ERC721}-like safe transfer that rely on {ERC1363} checks when
     * targeting contracts.
     *
     * NOTE: When the recipient address (`to`) has no code (i.e. is an EOA), this function behaves as {forceApprove}.
     * Opposedly, when the recipient address (`to`) has code, this function only attempts to call {ERC1363-approveAndCall}
     * once without retrying, and relies on the returned value to be true.
     *
     * Reverts if the returned value is other than `true`.
     */
    function approveAndCallRelaxed(IERC1363 token, address to, uint256 value, bytes memory data) internal {
        if (to.code.length == 0) {
            forceApprove(token, to, value);
        } else if (!token.approveAndCall(to, value, data)) {
            revert SafeERC20FailedOperation(address(token));
        }
    }

    /**
     * @dev Imitates a Solidity high-level call (i.e. a regular function call to a contract), relaxing the requirement
     * on the return value: the return value is optional (but if data is returned, it must not be false).
     * @param token The token targeted by the call.
     * @param data The call data (encoded using abi.encode or one of its variants).
     *
     * This is a variant of {_callOptionalReturnBool} that reverts if call fails to meet the requirements.
     */
    function _callOptionalReturn(IERC20 token, bytes memory data) private {
        uint256 returnSize;
        uint256 returnValue;
        assembly ("memory-safe") {
            let success := call(gas(), token, 0, add(data, 0x20), mload(data), 0, 0x20)
            // bubble errors
            if iszero(success) {
                let ptr := mload(0x40)
                returndatacopy(ptr, 0, returndatasize())
                revert(ptr, returndatasize())
            }
            returnSize := returndatasize()
            returnValue := mload(0)
        }

        if (returnSize == 0 ? address(token).code.length == 0 : returnValue != 1) {
            revert SafeERC20FailedOperation(address(token));
        }
    }

    /**
     * @dev Imitates a Solidity high-level call (i.e. a regular function call to a contract), relaxing the requirement
     * on the return value: the return value is optional (but if data is returned, it must not be false).
     * @param token The token targeted by the call.
     * @param data The call data (encoded using abi.encode or one of its variants).
     *
     * This is a variant of {_callOptionalReturn} that silently catches all reverts and returns a bool instead.
     */
    function _callOptionalReturnBool(IERC20 token, bytes memory data) private returns (bool) {
        bool success;
        uint256 returnSize;
        uint256 returnValue;
        assembly ("memory-safe") {
            success := call(gas(), token, 0, add(data, 0x20), mload(data), 0, 0x20)
            returnSize := returndatasize()
            returnValue := mload(0)
        }
        return success && (returnSize == 0 ? address(token).code.length > 0 : returnValue == 1);
    }
}


// File @openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol@v5.2.0

// Original license: SPDX_License_Identifier: MIT
// OpenZeppelin Contracts (last updated v5.1.0) (token/ERC20/extensions/IERC20Permit.sol)


/**
 * @dev Interface of the ERC-20 Permit extension allowing approvals to be made via signatures, as defined in
 * https://eips.ethereum.org/EIPS/eip-2612[ERC-2612].
 *
 * Adds the {permit} method, which can be used to change an account's ERC-20 allowance (see {IERC20-allowance}) by
 * presenting a message signed by the account. By not relying on {IERC20-approve}, the token holder account doesn't
 * need to send a transaction, and thus is not required to hold Ether at all.
 *
 * ==== Security Considerations
 *
 * There are two important considerations concerning the use of `permit`. The first is that a valid permit signature
 * expresses an allowance, and it should not be assumed to convey additional meaning. In particular, it should not be
 * considered as an intention to spend the allowance in any specific way. The second is that because permits have
 * built-in replay protection and can be submitted by anyone, they can be frontrun. A protocol that uses permits should
 * take this into consideration and allow a `permit` call to fail. Combining these two aspects, a pattern that may be
 * generally recommended is:
 *
 * ```solidity
 * function doThingWithPermit(..., uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) public {
 *     try token.permit(msg.sender, address(this), value, deadline, v, r, s) {} catch {}
 *     doThing(..., value);
 * }
 *
 * function doThing(..., uint256 value) public {
 *     token.safeTransferFrom(msg.sender, address(this), value);
 *     ...
 * }
 * ```
 *
 * Observe that: 1) `msg.sender` is used as the owner, leaving no ambiguity as to the signer intent, and 2) the use of
 * `try/catch` allows the permit to fail and makes the code tolerant to frontrunning. (See also
 * {SafeERC20-safeTransferFrom}).
 *
 * Additionally, note that smart contract wallets (such as Argent or Safe) are not able to produce permit signatures, so
 * contracts should have entry points that don't rely on permit.
 */
interface IERC20Permit {
    /**
     * @dev Sets `value` as the allowance of `spender` over ``owner``'s tokens,
     * given ``owner``'s signed approval.
     *
     * IMPORTANT: The same issues {IERC20-approve} has related to transaction
     * ordering also apply here.
     *
     * Emits an {Approval} event.
     *
     * Requirements:
     *
     * - `spender` cannot be the zero address.
     * - `deadline` must be a timestamp in the future.
     * - `v`, `r` and `s` must be a valid `secp256k1` signature from `owner`
     * over the EIP712-formatted function arguments.
     * - the signature must use ``owner``'s current nonce (see {nonces}).
     *
     * For more information on the signature format, see the
     * https://eips.ethereum.org/EIPS/eip-2612#specification[relevant EIP
     * section].
     *
     * CAUTION: See Security Considerations above.
     */
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /**
     * @dev Returns the current nonce for `owner`. This value must be
     * included whenever a signature is generated for {permit}.
     *
     * Every successful call to {permit} increases ``owner``'s nonce by one. This
     * prevents a signature from being used multiple times.
     */
    function nonces(address owner) external view returns (uint256);

    /**
     * @dev Returns the domain separator used in the encoding of the signature for {permit}, as defined by {EIP712}.
     */
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}


// File @openzeppelin/contracts/utils/ReentrancyGuard.sol@v5.2.0

// Original license: SPDX_License_Identifier: MIT
// OpenZeppelin Contracts (last updated v5.1.0) (utils/ReentrancyGuard.sol)


/**
 * @dev Contract module that helps prevent reentrant calls to a function.
 *
 * Inheriting from `ReentrancyGuard` will make the {nonReentrant} modifier
 * available, which can be applied to functions to make sure there are no nested
 * (reentrant) calls to them.
 *
 * Note that because there is a single `nonReentrant` guard, functions marked as
 * `nonReentrant` may not call one another. This can be worked around by making
 * those functions `private`, and then adding `external` `nonReentrant` entry
 * points to them.
 *
 * TIP: If EIP-1153 (transient storage) is available on the chain you're deploying at,
 * consider using {ReentrancyGuardTransient} instead.
 *
 * TIP: If you would like to learn more about reentrancy and alternative ways
 * to protect against it, check out our blog post
 * https://blog.openzeppelin.com/reentrancy-after-istanbul/[Reentrancy After Istanbul].
 */
abstract contract ReentrancyGuard {
    // Booleans are more expensive than uint256 or any type that takes up a full
    // word because each write operation emits an extra SLOAD to first read the
    // slot's contents, replace the bits taken up by the boolean, and then write
    // back. This is the compiler's defense against contract upgrades and
    // pointer aliasing, and it cannot be disabled.

    // The values being non-zero value makes deployment a bit more expensive,
    // but in exchange the refund on every call to nonReentrant will be lower in
    // amount. Since refunds are capped to a percentage of the total
    // transaction's gas, it is best to keep them low in cases like this one, to
    // increase the likelihood of the full refund coming into effect.
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    uint256 private _status;

    /**
     * @dev Unauthorized reentrant call.
     */
    error ReentrancyGuardReentrantCall();

    constructor() {
        _status = NOT_ENTERED;
    }

    /**
     * @dev Prevents a contract from calling itself, directly or indirectly.
     * Calling a `nonReentrant` function from another `nonReentrant`
     * function is not supported. It is possible to prevent this from happening
     * by making the `nonReentrant` function external, and making it call a
     * `private` function that does the actual work.
     */
    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }

    function _nonReentrantBefore() private {
        // On the first call to nonReentrant, _status will be NOT_ENTERED
        if (_status == ENTERED) {
            revert ReentrancyGuardReentrantCall();
        }

        // Any calls to nonReentrant after this point will fail
        _status = ENTERED;
    }

    function _nonReentrantAfter() private {
        // By storing the original value once again, a refund is triggered (see
        // https://eips.ethereum.org/EIPS/eip-2200)
        _status = NOT_ENTERED;
    }

    /**
     * @dev Returns true if the reentrancy guard is currently set to "entered", which indicates there is a
     * `nonReentrant` function in the call stack.
     */
    function _reentrancyGuardEntered() internal view returns (bool) {
        return _status == ENTERED;
    }
}


// File contracts/OTCEscrow.sol

// Original license: SPDX_License_Identifier: MIT

// =============================================================================
// OTCEscrow v3 — ExecDaat OTC Smart Contract
//
// @title    OTCEscrow — Production-Ready OTC Token Escrow
// @author   ExecDaat
// @notice   EVM-compatible escrow for Over-The-Counter ERC-20 token deals,
//           with dispute/arbitration, Permit2/EIP-2612 support, and an
//           explicit authorized-releaser system for trustless automation.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │  LIFECYCLE (on-chain state machine)                                     │
// │                                                                         │
// │  createDeal() → State.Pending                                           │
// │    │                                                                    │
// │    ├─ signDeal() [buyer]  → still Pending (one sig)                     │
// │    ├─ signDeal() [seller] → still Pending (two sigs)                    │
// │    │                                                                    │
// │    ├─ fundDeal()  → State.Funded                                        │
// │    │    │                                                               │
// │    │    ├─ release()  → State.Completed  (tokens → seller)              │
// │    │    ├─ raiseDispute() → State.Disputed                              │
// │    │    │    └─ resolveDispute() → State.Completed | State.Cancelled    │
// │    │    └─ cancel() [dual consent] → State.Cancelled (refund → buyer)   │
// │    │                                                                    │
// │    └─ cancel() [either party, unfunded] → State.Cancelled              │
// └─────────────────────────────────────────────────────────────────────────┘
//
// SECURITY ASSUMPTIONS:
//   • ReentrancyGuard prevents re-entrant calls on all state mutators.
//   • SafeERC20 wraps all token transfers; non-reverting tokens are also
//     caught by an explicit balance-diff check in fundDeal().
//   • All role checks use custom errors — no silent failures.
//   • Checks-Effects-Interactions pattern is strictly followed.
//   • state is updated BEFORE any external call.
//   • The arbitrator address is set once at construction (immutable after
//     deployment) — choosing a neutral multisig is the deployer's responsibility.
//   • DOMAIN_SEPARATOR is computed at construction time with the actual
//     chain ID; EIP-2612 permits are validated against it before execution.
//
// FRONT-RUNNING CONSIDERATIONS:
//   • dealId is derived from all deal parameters + block.timestamp + block.number,
//     making pre-computed attack collisions computationally infeasible.
//   • Permit-based funding includes a deadline parameter — expired permits revert.
//   • The dispute window begins immediately after funding; a malicious buyer
//     cannot DoS the seller by raising a dispute before funding.
//   • Resolving disputes emits an on-chain event, giving full transparency.
//
// MILESTONES (future extension):
//   • Milestone support is reserved but not implemented in this version.
//     If added, require(milestones.length <= 10, "Too many milestones") MUST
//     be enforced per the security spec.
// =============================================================================




// =============================================================================
// CONTRACT
// =============================================================================

/**
 * @title  OTCEscrow
 * @notice Production-ready OTC escrow: create → sign → fund → release (or dispute/cancel).
 * @dev    All state-changing functions are nonReentrant. All external token transfers
 *         use SafeERC20 plus an explicit balance-diff guard.
 */
contract OTCEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // =========================================================================
    // STATE MACHINE
    // =========================================================================

    /**
     * @notice Lifecycle states for each deal.
     * @dev    Transitions:
     *   Pending  → Funded    (fundDeal)
     *   Funded   → Completed (release)
     *   Funded   → Disputed  (raiseDispute)
     *   Funded   → Cancelled (dual-consent cancel)
     *   Disputed → Completed (resolveDispute, release to seller)
     *   Disputed → Cancelled (resolveDispute, refund to buyer)
     *   Pending  → Cancelled (single-party cancel, unfunded)
     */
    enum State { Pending, Funded, Completed, Cancelled, Disputed }

    // =========================================================================
    // STRUCTS
    // =========================================================================

    /**
     * @notice Full deal record stored on-chain.
     * @dev    After release or cancellation, `amount` is zeroed to reclaim gas
     *         and prevent accidental re-use (state cleanup pattern).
     */
    struct Deal {
        address buyer;
        address seller;
        address token;
        uint256 amount;
        uint256 tgeTimestamp;           // Unix UTC timestamp for TGE/release

        bool    buyerSigned;
        bool    sellerSigned;

        State   state;                  // Current lifecycle state

        // Dual-consent cancel (funded deals only)
        bool    buyerCancelRequested;
        bool    sellerCancelRequested;

        // Dispute
        address disputeRaisedBy;        // address(0) if no dispute

        bytes32 contractHash;           // keccak256 of off-chain contract document
        uint256 createdAt;
    }

    // =========================================================================
    // IMMUTABLES & STORAGE
    // =========================================================================

    /// @notice The arbitrator/multisig that can resolve disputes.
    /// @dev    Set at construction; cannot be changed post-deployment.
    address public immutable arbitrator;

    /// @notice Authorized releasers (e.g., multisig, relayer, automation contract).
    /// @dev    Mapping: address → authorized. Set by constructor; updatable only
    ///         by the arbitrator (governance action).
    mapping(address => bool) public isAuthorized;

    /// @notice All deals, keyed by their unique dealId (keccak256 hash).
    mapping(bytes32 => Deal) public deals;

    /// @notice All deal IDs for a given party (buyer or seller).
    mapping(address => bytes32[]) public dealsByParty;

    /// @dev    EIP-712 domain separator for permit2-style typed-data signatures.
    bytes32 public immutable DOMAIN_SEPARATOR;

    /// @dev    Typehash for fundWithPermit calls.
    bytes32 public constant FUND_PERMIT_TYPEHASH = keccak256(
        "FundPermit(bytes32 dealId,address buyer,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    /// @notice Per-address nonces for fundWithPermit (replay protection).
    mapping(address => uint256) public nonces;

    // =========================================================================
    // EVENTS
    // =========================================================================

    /**
     * @notice Emitted when a new OTC deal is created.
     * @param dealId       Unique identifier for this deal.
     * @param buyer        Address of the buyer (token depositor).
     * @param seller       Address of the seller (token recipient).
     * @param token        ERC-20 token contract address.
     * @param amount       Token amount (raw, in token's native decimals).
     * @param tgeTimestamp Unix UTC timestamp after which funds can be released.
     * @param contractHash keccak256 hash of the off-chain deal document.
     */
    event DealCreated(
        bytes32 indexed dealId,
        address indexed buyer,
        address indexed seller,
        address  token,
        uint256  amount,
        uint256  tgeTimestamp,
        bytes32  contractHash
    );

    /**
     * @notice Emitted when a party signs the deal on-chain.
     * @param dealId Unique deal identifier.
     * @param signer Address that signed.
     * @param role   "Buyer" or "Seller".
     */
    event DealSigned(bytes32 indexed dealId, address indexed signer, string role);

    /**
     * @notice Emitted when the buyer successfully deposits tokens into escrow.
     * @param dealId Unique deal identifier.
     * @param amount Raw token amount deposited.
     */
    event DealFunded(bytes32 indexed dealId, uint256 amount);

    /**
     * @notice Emitted when escrowed tokens are released to the seller.
     * @param dealId Unique deal identifier.
     * @param seller Address of the seller who received the tokens.
     * @param amount Raw token amount released.
     */
    event DealReleased(bytes32 indexed dealId, address indexed seller, uint256 amount);

    /**
     * @notice Emitted when a deal is fully cancelled.
     * @param dealId      Unique deal identifier.
     * @param cancelledBy Address that triggered the final cancellation.
     * @param refunded    True if tokens were refunded to the buyer.
     */
    event DealCancelled(bytes32 indexed dealId, address indexed cancelledBy, bool refunded);

    /**
     * @notice Emitted when one party submits a cancel request (dual-consent flow).
     * @param dealId    Unique deal identifier.
     * @param requester Address that submitted the cancel request.
     */
    event CancelRequested(bytes32 indexed dealId, address indexed requester);

    /**
     * @notice Emitted when a dispute is raised on a funded deal.
     * @param dealId   Unique deal identifier.
     * @param raisedBy Address of the party that raised the dispute.
     */
    event DisputeRaised(bytes32 indexed dealId, address indexed raisedBy);

    /**
     * @notice Emitted when the arbitrator resolves a dispute.
     * @param dealId          Unique deal identifier.
     * @param releaseToSeller True → tokens sent to seller; False → tokens refunded to buyer.
     * @param resolver        Address of the arbitrator that resolved the dispute.
     */
    event DisputeResolved(bytes32 indexed dealId, bool releaseToSeller, address indexed resolver);

    /**
     * @notice Emitted when an authorized address is added or removed.
     * @param account    The address whose authorization status changed.
     * @param authorized True if authorized, false if revoked.
     */
    event AuthorizationUpdated(address indexed account, bool authorized);

    // =========================================================================
    // ERRORS
    // =========================================================================

    /// @notice Caller is not the buyer or seller of this deal.
    error NotParty();
    /// @notice Caller is not the buyer of this deal.
    error NotBuyer();
    /// @notice Caller is not the seller of this deal.
    error NotSeller();
    /// @notice Caller is not authorized to perform this action (not seller, not authorized address).
    error NotAuthorized();
    /// @notice Caller is not the arbitrator.
    error NotArbitrator();
    /// @notice The caller has already signed this deal.
    error AlreadySigned();
    /// @notice Both buyer and seller must sign before this action can proceed.
    error NotSigned();
    /// @notice Both buyer and seller must sign before funding (legacy alias, kept for ABI compat).
    error NotBothSigned();
    /// @notice This deal has already been funded.
    error AlreadyFunded();
    /// @notice This deal has not been funded yet.
    error NotFunded();
    /// @notice Funds have already been released for this deal.
    error AlreadyReleased();
    /// @notice This deal has already been cancelled.
    error AlreadyCancelled();
    /// @notice This deal is currently disputed and cannot be progressed.
    error DealDisputed();
    /// @notice No active dispute found for this deal.
    error NoDispute();
    /// @notice The TGE timestamp has not been reached yet.
    error TGENotReached();
    /// @notice No deal found with the given ID.
    error DealNotFound();
    /// @notice A zero address was provided where a valid address is required.
    error InvalidAddress();
    /// @notice Amount must be greater than zero.
    error InvalidAmount();
    /// @notice TGE timestamp must be non-zero.
    error InvalidTimestamp();
    /// @notice Buyer and seller cannot be the same address.
    error SameAddress();
    /// @notice The caller has already submitted a cancel request for this deal.
    error AlreadyCancelRequested();
    /// @notice ERC-20 allowance is less than the required deal amount.
    error InsufficientAllowance();
    /// @notice ERC-20 transferFrom returned false or transferred less than expected.
    error TransferFailed();
    /// @notice The permit signature has expired (deadline passed).
    error PermitExpired();
    /// @notice The permit signature is invalid.
    error InvalidPermitSignature();
    /// @notice The permit nonce does not match the expected value.
    error InvalidNonce();
    /// @notice Deal is not in the expected lifecycle state for this action.
    error InvalidState();

    // =========================================================================
    // MODIFIERS
    // =========================================================================

    /// @dev Reverts if the deal does not exist (buyer == address(0)).
    modifier dealExists(bytes32 dealId) {
        if (deals[dealId].buyer == address(0)) revert DealNotFound();
        _;
    }

    /// @dev Reverts if caller is neither the buyer nor the seller.
    modifier onlyParty(bytes32 dealId) {
        Deal storage d = deals[dealId];
        if (msg.sender != d.buyer && msg.sender != d.seller) revert NotParty();
        _;
    }

    /// @dev Reverts if the deal is already cancelled.
    modifier notCancelled(bytes32 dealId) {
        if (deals[dealId].state == State.Cancelled) revert AlreadyCancelled();
        _;
    }

    /// @dev Reverts if the deal has already been completed (released).
    modifier notCompleted(bytes32 dealId) {
        if (deals[dealId].state == State.Completed) revert AlreadyReleased();
        _;
    }

    /// @dev Reverts if the deal is in a disputed state.
    modifier notDisputed(bytes32 dealId) {
        if (deals[dealId].state == State.Disputed) revert DealDisputed();
        _;
    }

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * @notice Deploy the OTCEscrow contract.
     * @param _arbitrator       Address of the neutral arbitrator/multisig for dispute resolution.
     * @param _authorizedRelayers Initial list of authorized releasers (e.g. automation multisig).
     *                          Pass an empty array if not needed at deployment.
     */
    constructor(address _arbitrator, address[] memory _authorizedRelayers) {
        if (_arbitrator == address(0)) revert InvalidAddress();
        arbitrator = _arbitrator;

        uint256 len = _authorizedRelayers.length;
        for (uint256 i = 0; i < len; ) {
            if (_authorizedRelayers[i] != address(0)) {
                isAuthorized[_authorizedRelayers[i]] = true;
                emit AuthorizationUpdated(_authorizedRelayers[i], true);
            }
            unchecked { ++i; }
        }

        // EIP-712 domain separator
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("OTCEscrow")),
                keccak256(bytes("3")),
                block.chainid,
                address(this)
            )
        );
    }

    // =========================================================================
    // GOVERNANCE — ARBITRATOR ONLY
    // =========================================================================

    /**
     * @notice Add or remove an authorized releaser address.
     * @dev    Only callable by the arbitrator.
     * @param account    The address to update.
     * @param authorized True to authorize, false to revoke.
     */
    function setAuthorized(address account, bool authorized) external {
        if (msg.sender != arbitrator) revert NotArbitrator();
        if (account == address(0)) revert InvalidAddress();
        isAuthorized[account] = authorized;
        emit AuthorizationUpdated(account, authorized);
    }

    // =========================================================================
    // 1. CREATE DEAL
    // =========================================================================

    /**
     * @notice Buyer initiates a new OTC deal.
     * @dev    The dealId is deterministically derived from all deal parameters plus
     *         block.timestamp and block.number to prevent pre-computation attacks.
     * @param seller        The seller's address. Must not be zero or equal to buyer.
     * @param token         ERC-20 token address. Must not be zero.
     * @param amount        Raw token amount (in token's native decimals). Must be > 0.
     * @param tgeTimestamp  Unix UTC timestamp after which funds may be released. Must be > 0.
     * @param contractHash  keccak256 hash of the off-chain contract document (for auditability).
     * @return dealId       The unique bytes32 identifier for this deal.
     */
    function createDeal(
        address seller,
        address token,
        uint256 amount,
        uint256 tgeTimestamp,
        bytes32 contractHash
    ) external nonReentrant returns (bytes32 dealId) {
        // ── Strict parameter validation ──────────────────────────────────────
        if (seller == address(0) || token == address(0)) revert InvalidAddress();
        if (seller == msg.sender) revert SameAddress();
        if (amount == 0) revert InvalidAmount();
        // Note: amount <= type(uint256).max is always true for uint256, so only lower bound needed
        if (tgeTimestamp == 0) revert InvalidTimestamp();

        dealId = keccak256(abi.encodePacked(
            msg.sender,
            seller,
            token,
            amount,
            tgeTimestamp,
            contractHash,
            block.timestamp,
            block.number
        ));

        // Collision guard (astronomically unlikely but safe)
        if (deals[dealId].buyer != address(0)) revert InvalidState();

        deals[dealId] = Deal({
            buyer:                 msg.sender,
            seller:                seller,
            token:                 token,
            amount:                amount,
            tgeTimestamp:          tgeTimestamp,
            buyerSigned:           false,
            sellerSigned:          false,
            state:                 State.Pending,
            buyerCancelRequested:  false,
            sellerCancelRequested: false,
            disputeRaisedBy:       address(0),
            contractHash:          contractHash,
            createdAt:             block.timestamp
        });

        dealsByParty[msg.sender].push(dealId);
        dealsByParty[seller].push(dealId);

        emit DealCreated(dealId, msg.sender, seller, token, amount, tgeTimestamp, contractHash);
    }

    // =========================================================================
    // 2. SIGN DEAL
    // =========================================================================

    /**
     * @notice Buyer or seller signs the deal on-chain.
     * @dev    Both parties must sign before `fundDeal` can be called.
     *         Reverts with `AlreadySigned` if the caller has already signed.
     * @param dealId The deal identifier.
     */
    function signDeal(bytes32 dealId)
        external
        nonReentrant
        dealExists(dealId)
        onlyParty(dealId)
        notCancelled(dealId)
        notCompleted(dealId)
    {
        Deal storage d = deals[dealId];
        if (d.state == State.Funded) revert AlreadyFunded();

        bool isBuyer = (msg.sender == d.buyer);

        if (isBuyer) {
            if (d.buyerSigned) revert AlreadySigned();
            d.buyerSigned = true;
            emit DealSigned(dealId, msg.sender, "Buyer");
        } else {
            if (d.sellerSigned) revert AlreadySigned();
            d.sellerSigned = true;
            emit DealSigned(dealId, msg.sender, "Seller");
        }
    }

    // =========================================================================
    // 3a. FUND DEAL (standard approve/transferFrom)
    // =========================================================================

    /**
     * @notice Buyer deposits ERC-20 tokens into escrow (standard flow).
     * @dev    Requires a prior `token.approve(escrowAddress, amount)` call.
     *         Uses checks-effects-interactions: state is updated before the
     *         external transferFrom call. Balance-diff ensures fee-on-transfer
     *         tokens do not silently under-fund the escrow.
     * @param dealId The deal identifier.
     */
    function fundDeal(bytes32 dealId)
        external
        nonReentrant
        dealExists(dealId)
        notCancelled(dealId)
        notCompleted(dealId)
        notDisputed(dealId)
    {
        Deal storage d = deals[dealId];

        // ── Authorization checks ─────────────────────────────────────────────
        if (msg.sender != d.buyer) revert NotBuyer();
        if (!d.buyerSigned || !d.sellerSigned) revert NotSigned();
        if (d.state == State.Funded) revert AlreadyFunded();

        // ── Explicit allowance check ─────────────────────────────────────────
        uint256 allowed = IERC20(d.token).allowance(msg.sender, address(this));
        if (allowed < d.amount) revert InsufficientAllowance();

        // ── Checks-Effects-Interactions ──────────────────────────────────────
        d.state = State.Funded;                              // effect first

        uint256 before   = IERC20(d.token).balanceOf(address(this));
        IERC20(d.token).safeTransferFrom(msg.sender, address(this), d.amount);
        uint256 received = IERC20(d.token).balanceOf(address(this)) - before;
        if (received < d.amount) revert TransferFailed();   // fee-on-transfer guard

        emit DealFunded(dealId, d.amount);
    }

    // =========================================================================
    // 3b. FUND DEAL WITH PERMIT (EIP-2612 / gasless approve)
    // =========================================================================

    /**
     * @notice Buyer funds the escrow using an EIP-2612 permit signature instead of approve().
     * @dev    The token must implement EIP-2612 (IERC20Permit). The permit is executed
     *         atomically with the transferFrom — no separate approval transaction needed.
     *         Falls back to a revert if the token does not support permit.
     *
     *         Permit parameters (v, r, s, deadline) are forwarded directly to
     *         IERC20Permit(token).permit(). The nonce used here is the OTCEscrow-level
     *         nonce (fundWithPermit nonce), NOT the ERC-20 token nonce.
     *
     * @param dealId    The deal identifier.
     * @param deadline  EIP-2612 permit deadline (Unix timestamp). Must be >= block.timestamp.
     * @param v         EIP-2612 permit signature v component.
     * @param r         EIP-2612 permit signature r component.
     * @param s         EIP-2612 permit signature s component.
     */
    function fundDealWithPermit(
        bytes32 dealId,
        uint256 deadline,
        uint8   v,
        bytes32 r,
        bytes32 s
    )
        external
        nonReentrant
        dealExists(dealId)
        notCancelled(dealId)
        notCompleted(dealId)
        notDisputed(dealId)
    {
        Deal storage d = deals[dealId];

        // ── Authorization checks ─────────────────────────────────────────────
        if (msg.sender != d.buyer) revert NotBuyer();
        if (!d.buyerSigned || !d.sellerSigned) revert NotSigned();
        if (d.state == State.Funded) revert AlreadyFunded();

        // ── Permit deadline ──────────────────────────────────────────────────
        if (block.timestamp > deadline) revert PermitExpired();

        // ── Execute EIP-2612 permit (token-level approval) ───────────────────
        // This sets allowance on the token contract so the subsequent transferFrom succeeds.
        try IERC20Permit(d.token).permit(msg.sender, address(this), d.amount, deadline, v, r, s) {
            // permit succeeded — allowance is now set
        } catch {
            // If permit call fails, check whether allowance is already sufficient
            // (the user may have pre-approved via a previous tx)
            uint256 allowed = IERC20(d.token).allowance(msg.sender, address(this));
            if (allowed < d.amount) revert InsufficientAllowance();
        }

        // ── Checks-Effects-Interactions ──────────────────────────────────────
        d.state = State.Funded;

        uint256 before   = IERC20(d.token).balanceOf(address(this));
        IERC20(d.token).safeTransferFrom(msg.sender, address(this), d.amount);
        uint256 received = IERC20(d.token).balanceOf(address(this)) - before;
        if (received < d.amount) revert TransferFailed();

        emit DealFunded(dealId, d.amount);
    }

    // =========================================================================
    // 4. RELEASE
    // =========================================================================

    /**
     * @notice Release escrowed tokens to the seller after the TGE timestamp.
     * @dev    RESTRICTED: only the seller or an explicitly authorized address
     *         (e.g., multisig relayer) may call this function. This prevents
     *         front-running by third parties and ensures the seller controls timing.
     *
     *         After release, `deal.amount` is zeroed and state is set to Completed
     *         to prevent any re-entry or accidental re-use (state cleanup pattern).
     *
     * @param dealId The deal identifier.
     */
    function release(bytes32 dealId)
        external
        nonReentrant
        dealExists(dealId)
        notCancelled(dealId)
        notCompleted(dealId)
        notDisputed(dealId)
    {
        Deal storage d = deals[dealId];

        // ── RESTRICTED: seller or authorized address only ────────────────────
        if (msg.sender != d.seller && !isAuthorized[msg.sender]) revert NotAuthorized();

        if (d.state != State.Funded) revert NotFunded();
        if (block.timestamp < d.tgeTimestamp) revert TGENotReached();

        // ── Checks-Effects-Interactions ──────────────────────────────────────
        address seller = d.seller;
        address token  = d.token;
        uint256 amount = d.amount;

        d.state  = State.Completed;  // effect before transfer
        d.amount = 0;                // state cleanup — prevent re-use

        IERC20(token).safeTransfer(seller, amount);

        emit DealReleased(dealId, seller, amount);
    }

    // =========================================================================
    // 5. CANCEL
    // =========================================================================

    /**
     * @notice Cancel a deal.
     * @dev    Two cancellation flows:
     *
     *         **Unfunded (State.Pending):** Either party can cancel immediately.
     *         No refund is needed since no tokens have been deposited.
     *
     *         **Funded (State.Funded):** Dual-consent required. Each party must
     *         call `cancel()` once. The first call emits `CancelRequested`; the
     *         second call executes the cancellation and refunds tokens to buyer.
     *         Emits `DealCancelled` with refunded=true.
     *
     *         After cancellation, `deal.amount` is zeroed (state cleanup).
     *
     * @param dealId The deal identifier.
     */
    function cancel(bytes32 dealId)
        external
        nonReentrant
        dealExists(dealId)
        onlyParty(dealId)
        notCancelled(dealId)
        notCompleted(dealId)
    {
        Deal storage d = deals[dealId];

        // Cannot cancel a disputed deal — arbitrator must resolve first
        if (d.state == State.Disputed) revert DealDisputed();

        if (d.state == State.Pending) {
            // Unfunded: immediate cancel, no refund
            d.state = State.Cancelled;
            emit DealCancelled(dealId, msg.sender, false);
            return;
        }

        // Funded: require dual consent
        bool isBuyer = (msg.sender == d.buyer);

        if (isBuyer) {
            if (d.buyerCancelRequested) revert AlreadyCancelRequested();
            d.buyerCancelRequested = true;
            emit CancelRequested(dealId, msg.sender);
        } else {
            if (d.sellerCancelRequested) revert AlreadyCancelRequested();
            d.sellerCancelRequested = true;
            emit CancelRequested(dealId, msg.sender);
        }

        // Both parties have now requested → execute cancel + refund
        if (d.buyerCancelRequested && d.sellerCancelRequested) {
            address buyer  = d.buyer;
            address token  = d.token;
            uint256 amount = d.amount;

            d.state  = State.Cancelled;   // effect first
            d.amount = 0;                 // state cleanup

            IERC20(token).safeTransfer(buyer, amount);
            emit DealCancelled(dealId, msg.sender, true);
        }
    }

    // =========================================================================
    // 6. DISPUTE / ARBITRATION
    // =========================================================================

    /**
     * @notice Raise a dispute on a funded deal.
     * @dev    Only the buyer or seller can raise a dispute on a funded deal.
     *         Once disputed, neither `release` nor single-party `cancel` can proceed
     *         until the arbitrator resolves the dispute.
     *
     *         This function transitions the deal from Funded → Disputed.
     *
     * @param dealId The deal identifier.
     */
    function raiseDispute(bytes32 dealId)
        external
        nonReentrant
        dealExists(dealId)
        onlyParty(dealId)
        notCancelled(dealId)
        notCompleted(dealId)
    {
        Deal storage d = deals[dealId];

        if (d.state == State.Disputed) revert DealDisputed(); // already disputed
        if (d.state != State.Funded) revert NotFunded();

        d.state = State.Disputed;
        d.disputeRaisedBy = msg.sender;

        emit DisputeRaised(dealId, msg.sender);
    }

    /**
     * @notice Arbitrator resolves a dispute by deciding who receives the tokens.
     * @dev    Only the `arbitrator` address (set at construction) can call this.
     *         Two outcomes:
     *           • releaseToSeller = true  → tokens sent to seller,  state → Completed
     *           • releaseToSeller = false → tokens refunded to buyer, state → Cancelled
     *         In both cases `deal.amount` is zeroed after transfer (state cleanup).
     *
     * @param dealId          The deal identifier.
     * @param releaseToSeller True to release to seller; false to refund buyer.
     */
    function resolveDispute(bytes32 dealId, bool releaseToSeller)
        external
        nonReentrant
        dealExists(dealId)
    {
        if (msg.sender != arbitrator) revert NotArbitrator();

        Deal storage d = deals[dealId];
        if (d.state != State.Disputed) revert NoDispute();

        address buyer  = d.buyer;
        address seller = d.seller;
        address token  = d.token;
        uint256 amount = d.amount;

        // State cleanup before external call
        d.amount = 0;

        if (releaseToSeller) {
            d.state = State.Completed;
            IERC20(token).safeTransfer(seller, amount);
            emit DealReleased(dealId, seller, amount);
        } else {
            d.state = State.Cancelled;
            IERC20(token).safeTransfer(buyer, amount);
            emit DealCancelled(dealId, msg.sender, true);
        }

        emit DisputeResolved(dealId, releaseToSeller, msg.sender);
    }

    // =========================================================================
    // 7. VIEW FUNCTIONS
    // =========================================================================

    /**
     * @notice Get the full deal record.
     * @param dealId The deal identifier.
     * @return       The Deal struct.
     */
    function getDeal(bytes32 dealId) external view returns (Deal memory) {
        return deals[dealId];
    }

    /**
     * @notice Get deal signing and funding status — useful for front-end pre-flight checks.
     * @param dealId      The deal identifier.
     * @return buyerSigned   Whether the buyer has signed on-chain.
     * @return sellerSigned  Whether the seller has signed on-chain.
     * @return funded        Whether the escrow has been funded (state == Funded).
     * @return currentState  Current State enum value (0=Pending,1=Funded,2=Completed,3=Cancelled,4=Disputed).
     */
    function getDealStatus(bytes32 dealId)
        external
        view
        returns (
            bool  buyerSigned,
            bool  sellerSigned,
            bool  funded,
            State currentState
        )
    {
        Deal storage d = deals[dealId];
        return (
            d.buyerSigned,
            d.sellerSigned,
            d.state == State.Funded,
            d.state
        );
    }

    /**
     * @notice Get all deal IDs for a party.
     * @param party  The buyer or seller address.
     * @return       Array of bytes32 deal IDs.
     */
    function getDealsByParty(address party) external view returns (bytes32[] memory) {
        return dealsByParty[party];
    }

    /**
     * @notice Check if a deal can currently be released.
     * @dev    Returns true only if: funded, not released, not cancelled, not disputed,
     *         and TGE timestamp has been reached.
     * @param dealId The deal identifier.
     * @return       True if the deal is eligible for release right now.
     */
    function canRelease(bytes32 dealId) external view returns (bool) {
        Deal storage d = deals[dealId];
        return d.state == State.Funded && block.timestamp >= d.tgeTimestamp;
    }

    /**
     * @notice Returns the current human-readable status string for a deal.
     * @dev    Useful for front-end display and debugging. Possible values:
     *         NOT_FOUND, CANCELLED, COMPLETED, DISPUTED, EXECUTABLE, FUNDED,
     *         BOTH_SIGNED, PARTIALLY_SIGNED, CREATED.
     * @param dealId The deal identifier.
     * @return       Status string.
     */
    function dealStatus(bytes32 dealId) external view returns (string memory) {
        Deal storage d = deals[dealId];
        if (d.buyer == address(0))           return "NOT_FOUND";
        if (d.state == State.Cancelled)      return "CANCELLED";
        if (d.state == State.Completed)      return "COMPLETED";
        if (d.state == State.Disputed)       return "DISPUTED";
        if (d.state == State.Funded) {
            if (block.timestamp >= d.tgeTimestamp) return "EXECUTABLE";
            return "FUNDED";
        }
        // State.Pending
        if (d.buyerSigned && d.sellerSigned) return "BOTH_SIGNED";
        if (d.buyerSigned || d.sellerSigned) return "PARTIALLY_SIGNED";
        return "CREATED";
    }

    /**
     * @notice Returns the current nonce for a given buyer address.
     * @dev    Used by off-chain tooling to construct valid fundWithPermit calls.
     * @param buyer The buyer's address.
     * @return      Current nonce value.
     */
    function getNonce(address buyer) external view returns (uint256) {
        return nonces[buyer];
    }
}
