# crum_bls JavaScript port

This directory mirrors useful browser-safe pieces of `crumble/lib/crum_bls`.

Implemented functions preserve Rust names and semantics where they have been
checked against Rust vectors:

- `hash_to_curve`
- `make_signing_key_from_seed`
- `make_public_key_from_signing_key`
- `compressed_public_key_from_signing_key`
- compressed public key/signature decoders
- `derive_private_poker_bls_identity`
- `wallet_signature_material`
- `encrypt_signal_for_peer`
- `decrypt_signal_from_peer`
- `xor_with_keccak_stream`
- `sign`
- `mask`
- `unmask`
- `verify`
- `verify_unmasking`
- `verify_shuffle`
- `verify_shuffle_traced`
- `combine`
- `recover`

`frontend_compat.js` is intentionally separate. It supports the older frontend
G1/AES-GCM payload shape from `private-poker/lib/crypto.js`; it is not Rust
`signal_crypto`, which uses compressed G2 ephemeral keys plus XOR over a Keccak
stream.
