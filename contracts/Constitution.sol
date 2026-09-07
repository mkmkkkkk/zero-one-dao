// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The constitution of Zero One as an on-chain constant: the keccak256 of the exact bytes of
/// docs/CONSTITUTION.md and a URL where that text can be read. Set once at construction; there is
/// no setter, no owner and no amendment path (DESIGN.md §10, constitution Art. VII).
/// @dev `textUrl` is a string and Solidity cannot mark strings immutable; it is written once in the
/// constructor and no function in this contract writes storage afterwards, so it is immutable in fact.
contract Constitution {
    /// @notice keccak256 over the exact bytes of docs/CONSTITUTION.md.
    bytes32 public immutable textHash;
    /// @notice Where the text lives (documentation only; the hash is the authority).
    string public textUrl;

    error EmptyHash();
    error EmptyUrl();

    event ConstitutionAdopted(bytes32 indexed textHash, string textUrl);

    /// @param textHash_ keccak256 of the constitution text bytes.
    /// @param textUrl_ Location of the text (any non-empty string).
    constructor(bytes32 textHash_, string memory textUrl_) {
        if (textHash_ == bytes32(0)) revert EmptyHash();
        if (bytes(textUrl_).length == 0) revert EmptyUrl();
        textHash = textHash_;
        textUrl = textUrl_;
        emit ConstitutionAdopted(textHash_, textUrl_);
    }

    /// @notice True when `text` is byte-for-byte the adopted constitution.
    /// @param text Candidate text bytes.
    /// @return matches Whether keccak256(text) equals the adopted hash.
    function verify(bytes calldata text) external view returns (bool matches) {
        return keccak256(text) == textHash;
    }
}
