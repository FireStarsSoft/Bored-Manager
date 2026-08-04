# Release trust root

The first production signing ceremony must add exactly these public files:

- `release-public-key.pem` — Ed25519 public key in PEM format.
- `release-public-key.sha256` — lowercase SHA-256 of its DER representation plus a newline.

No private key belongs in this directory, Git, GitHub secrets, Actions variables, a release asset,
or a developer workstation. Release and promotion workflows intentionally fail until the public
trust root is committed and reviewed.

Generate the fingerprint from the reviewed public key:

```bash
openssl pkey -pubin -in release-public-key.pem -outform DER | sha256sum | awk '{print $1}'
```

Do not add a temporary or example key with a production filename. Key creation/rotation follows
`docs/release/signing.md` and requires an ADR.
