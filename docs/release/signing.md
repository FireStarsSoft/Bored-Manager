# Release signing policy

The production Ed25519 private key is generated and held offline. The repository contains only the
public key and its independently published SHA-256 fingerprint after the first signing ceremony.
Until then, installer templates retain an explicit marker and fail closed.

Signatures are raw Ed25519 signatures over the exact bytes of the canonical file. The verifier
uses OpenSSL `pkeyutl -verify -rawin`; no implicit JSON canonicalization or newline conversion is
allowed. Both `release-manifest-v1.json` and `SHA256SUMS` are signed.

Key rotation requires an ADR, a release signed by the old key that authorizes the new fingerprint,
an out-of-band announcement, an overlap window, and negative tests against unauthorized keys.
