# S3C: Portable S3 Connection String

**Status:** Experimental BitLogin format
**Document version:** 0.1
**Date:** July 22, 2026
**Implementation status:** Not implemented

## 1. Summary

S3C is a proposed portable string format for importing and exporting credentials
for S3-compatible object storage.

It is designed to work with:

- Amazon S3
- Cloudflare R2
- MinIO
- Backblaze B2 S3-compatible API
- Wasabi
- Synology and other self-hosted S3-compatible services
- Generic S3-compatible providers

An S3C string contains enough information for a compatible application to
connect to one bucket or bucket prefix using an S3-compatible SDK.

The format is provider-neutral. Provider-specific behavior is represented only
as hints and must not override the explicit endpoint, region, bucket, and
credential fields.

## 2. Security warning

An S3C string is **encoded, not encrypted**.

Anyone who obtains the complete string can decode the credentials and perform
every operation permitted by the provider-side policy.

Applications must treat an S3C string like a password or private key. It must
never be placed in:

- Public Nostr events.
- URLs or query strings.
- Browser history.
- Logs or analytics.
- Crash reports.
- Screenshots by default.
- Unencrypted local storage.
- Source-control repositories.

BitLogin stores imported S3C credentials only inside encrypted Connection Vault
records. See `connection-vault.md`.

## 3. String syntax

Version 1 uses this syntax:

```text
s3c1:<base64url-encoded-canonical-json>
```

The prefix is exactly:

```text
s3c1:
```

The payload is:

1. A JSON object conforming to this document.
2. Canonically serialized using RFC 8785 JSON Canonicalization Scheme.
3. Encoded as UTF-8.
4. Encoded using unpadded base64url.

Padding characters (`=`) are not permitted in the canonical exported form.
Importers may accept padded base64url for compatibility, but must emit the
unpadded canonical form.

## 4. Minimal payload

```json
{
  "access_key_id": "AKIAEXAMPLE",
  "bucket": "my-bucket",
  "endpoint": "https://s3.example.com",
  "region": "us-east-1",
  "secret_access_key": "example-secret-key",
  "v": 1
}
```

Required fields:

- `v`
- `endpoint`
- `region`
- `bucket`
- `access_key_id`
- `secret_access_key`

## 5. Complete payload

```json
{
  "access_key_id": "AKIAEXAMPLE",
  "addressing_style": "path",
  "bucket": "adam-bitdrive",
  "endpoint": "https://1234567890abcdef.r2.cloudflarestorage.com",
  "expires_at": null,
  "label": "BitDrive R2",
  "object_prefix": "bitdrive/",
  "provider": "cloudflare-r2",
  "public_base_url": "https://files.example.com",
  "region": "auto",
  "secret_access_key": "example-secret-key",
  "session_token": null,
  "v": 1
}
```

The object may contain only fields defined by this version unless an importer
explicitly supports extension fields. Unknown fields must not be silently
reinterpreted.

## 6. Field definitions

### 6.1 `v`

```json
"v": 1
```

Required integer. Must equal `1` for this version.

### 6.2 `endpoint`

```json
"endpoint": "https://s3.example.com"
```

Required absolute URL for the S3-compatible API endpoint.

Requirements:

- Must use `https://` in normal operation.
- Must not contain a username or password.
- Must not contain a fragment.
- Should not contain a query string.
- Must not include the bucket name unless the provider specifically requires a
  bucket-bound endpoint.
- A trailing slash should be removed during normalization, except for the root
  slash inherent to the URL.

`http://` may be accepted only behind an explicit local-development option for
localhost, loopback addresses, or private-network deployments.

### 6.3 `region`

```json
"region": "us-east-1"
```

Required string passed to the S3 signing implementation.

Examples:

```text
us-east-1
eu-west-1
auto
```

The string is provider-defined. Importers must not assume that every provider
uses AWS region names.

### 6.4 `bucket`

```json
"bucket": "adam-bitdrive"
```

Required non-empty bucket name.

The importer should preserve case exactly, although many providers restrict
bucket names to lowercase.

### 6.5 `access_key_id`

```json
"access_key_id": "AKIAEXAMPLE"
```

Required non-empty access-key identifier.

### 6.6 `secret_access_key`

```json
"secret_access_key": "example-secret-key"
```

Required non-empty secret access key.

This is sensitive bearer credential material.

### 6.7 `session_token`

```json
"session_token": "temporary-session-token"
```

Optional string used with temporary S3 credentials.

When present, it must be exported together with the corresponding access-key ID
and secret access key. Omitting it from a temporary credential usually makes
the connection unusable.

### 6.8 `expires_at`

```json
"expires_at": 1787356800
```

Optional Unix timestamp in seconds indicating credential expiration.

The storage provider remains authoritative. This field is advisory and may be
stale.

### 6.9 `addressing_style`

```json
"addressing_style": "path"
```

Optional. Allowed values:

```text
auto
virtual
path
```

Meaning:

- `auto` — the client or SDK chooses.
- `virtual` — bucket appears in the host name.
- `path` — bucket appears in the URL path.

Examples:

```text
virtual: https://my-bucket.s3.example.com/object.jpg
path:    https://s3.example.com/my-bucket/object.jpg
```

Default: `auto`.

### 6.10 `object_prefix`

```json
"object_prefix": "apps/satisfied/"
```

Optional key prefix applications should treat as the root of their storage
namespace.

Normalization rules:

- Must not begin with `/`.
- Empty string means the bucket root.
- Non-empty values should end in `/`.
- `.` and `..` path segments are prohibited.
- Backslashes are prohibited.
- The prefix must be interpreted as an object-key prefix, not as a filesystem
  path.

This field is not an access-control mechanism. Provider-side IAM or token policy
must independently restrict the credential to the intended prefix.

### 6.11 `provider`

```json
"provider": "cloudflare-r2"
```

Optional user-interface hint.

Suggested values:

```text
aws-s3
cloudflare-r2
minio
backblaze-b2
wasabi
synology
generic
```

Unknown values are allowed as opaque lowercase identifiers matching:

```text
[a-z0-9][a-z0-9-]{0,63}
```

Clients must use explicit connection fields as the source of truth rather than
changing credentials or endpoints based solely on this hint.

### 6.12 `public_base_url`

```json
"public_base_url": "https://files.example.com"
```

Optional absolute HTTPS URL used to construct public or CDN delivery URLs after
an object has been uploaded.

This field does not imply that the bucket is public. Applications must not
assume that an object is readable without testing or receiving an explicit
provider response.

### 6.13 `label`

```json
"label": "BitDrive R2"
```

Optional human-readable label. It has no effect on authentication or signing.

For privacy, applications may omit labels from exported S3C strings and keep
them only as encrypted local or BitLogin metadata.

## 7. Canonical example

Canonical JSON:

```json
{"access_key_id":"AKIAEXAMPLE","addressing_style":"path","bucket":"adam-bitdrive","endpoint":"https://1234567890abcdef.r2.cloudflarestorage.com","object_prefix":"bitdrive/","provider":"cloudflare-r2","region":"auto","secret_access_key":"example-secret-key","v":1}
```

Canonical S3C string:

```text
s3c1:eyJhY2Nlc3Nfa2V5X2lkIjoiQUtJQUVYQU1QTEUiLCJhZGRyZXNzaW5nX3N0eWxlIjoicGF0aCIsImJ1Y2tldCI6ImFkYW0tYml0ZHJpdmUiLCJlbmRwb2ludCI6Imh0dHBzOi8vMTIzNDU2Nzg5MGFiY2RlZi5yMi5jbG91ZGZsYXJlc3RvcmFnZS5jb20iLCJvYmplY3RfcHJlZml4IjoiYml0ZHJpdmUvIiwicHJvdmlkZXIiOiJjbG91ZGZsYXJlLXIyIiwicmVnaW9uIjoiYXV0byIsInNlY3JldF9hY2Nlc3Nfa2V5IjoiZXhhbXBsZS1zZWNyZXQta2V5IiwidiI6MX0
```

All credentials in this example are intentionally non-functional placeholders.

## 8. Parsing algorithm

An importer should:

1. Verify the exact `s3c1:` prefix.
2. Reject unreasonable total string sizes before decoding.
3. Base64url-decode the payload.
4. Decode strict UTF-8.
5. Parse one JSON object with duplicate-key rejection.
6. Verify `v` equals `1`.
7. Reject missing required fields.
8. Validate every known field according to this document.
9. Reject unsupported critical or unknown fields under the implementation's
   compatibility policy.
10. Normalize endpoint, prefix, and addressing-style values.
11. Optionally verify the connection using a low-risk operation.
12. Store the structured fields in encrypted storage rather than retaining the
   plaintext string unnecessarily.

Parsers must never include the full S3C string or secret fields in thrown error
messages.

## 9. Connection verification

After user approval, a client may verify credentials using the least-privileged
operation likely to succeed.

Possible checks:

- `HeadBucket`
- A prefix-limited list request with a very small result limit
- A provider-specific account or capability check

Verification must not:

- Upload a visible object without explicit consent.
- Delete or overwrite an object.
- Assume a failed list request proves that reads or writes are unavailable.
- Claim exact permissions unless provider policy has been authoritatively
  inspected.

A write test, when explicitly requested, should use a random temporary object
under the configured prefix and immediately delete it. The interface must warn
that lifecycle rules, logging, replication, or versioning may retain traces.

## 10. Permission metadata

A BitLogin Connection Vault record may store descriptive permission metadata:

```json
{
  "declared_permissions": [
    "list",
    "read",
    "write",
    "delete"
  ]
}
```

Suggested operation names:

```text
list
read
write
delete
multipart
presign-read
presign-write
admin
```

These values are not part of the S3C v1 wire string unless a future version
explicitly adds them. They are display metadata and do not override
provider-side policy.

## 11. BitLogin internal credential profile

After import, BitLogin stores a structured object:

```json
{
  "schema": "bitlogin.connection.s3.v1",
  "endpoint": "https://1234567890abcdef.r2.cloudflarestorage.com",
  "region": "auto",
  "bucket": "adam-bitdrive",
  "access_key_id": "AKIAEXAMPLE",
  "secret_access_key": "example-secret-key",
  "session_token": null,
  "expires_at": null,
  "addressing_style": "path",
  "object_prefix": "bitdrive/",
  "provider": "cloudflare-r2",
  "public_base_url": "https://files.example.com",
  "declared_permissions": [
    "list",
    "read",
    "write",
    "delete"
  ]
}
```

Complete Connection Vault record:

```json
{
  "schema": "bitlogin.connection.v1",
  "connection_id": "Vx7LgdZCsVbT_2uvB0YoGA",
  "connection_type": "s3",
  "state": "active",
  "label": "BitDrive R2",
  "created_at": 1784750000,
  "updated_at": 1784750000,
  "credential": {
    "schema": "bitlogin.connection.s3.v1",
    "endpoint": "https://1234567890abcdef.r2.cloudflarestorage.com",
    "region": "auto",
    "bucket": "adam-bitdrive",
    "access_key_id": "AKIAEXAMPLE",
    "secret_access_key": "example-secret-key",
    "session_token": null,
    "expires_at": null,
    "addressing_style": "path",
    "object_prefix": "bitdrive/",
    "provider": "cloudflare-r2",
    "public_base_url": "https://files.example.com",
    "declared_permissions": ["list", "read", "write", "delete"]
  },
  "application_binding": {
    "origin": "https://drive.example",
    "app_pubkey": null
  },
  "notes": null
}
```

## 12. Application authorization

Applications should request a particular connection and operations:

```javascript
const grant = await bitlogin.storage.requestAccess({
  connectionId: "Vx7LgdZCsVbT_2uvB0YoGA",
  prefix: "apps/satisfied/",
  operations: ["list", "read", "write"],
  durationSeconds: 3600,
  mode: "broker"
});
```

The user prompt should show:

- Requesting application origin or identity.
- Provider, bucket, and prefix.
- Requested operations.
- Requested duration.
- Whether long-lived credentials will be revealed.
- Whether the request can delete or overwrite data.

## 13. Preferred authorization hierarchy

From safest to least isolated:

1. **Presigned single-object URL** for one upload or download.
2. **Temporary scoped credentials** limited by bucket, prefix, methods, and
   expiration.
3. **Brokered operations** performed by an isolated BitLogin client.
4. **Revealed long-lived S3C credential** after explicit warning.

Not every S3-compatible provider supports every option. Applications must make
capability differences explicit rather than silently falling back to a more
powerful credential.

## 14. Provider-side restriction

Every production connection should use a dedicated credential restricted to:

- One bucket where possible.
- One application prefix where possible.
- Only required operations.
- A limited lifetime where supported.
- No provider account administration.

Recommended pattern:

```text
BitDrive   -> adam-bitdrive/bitdrive/*
BitVid     -> media/videos/*
BitRoad    -> commerce/products/*
Satisfied  -> satisfied/uploads/*
```

The `object_prefix` field is informative. Real restriction must be enforced by
IAM, token policy, bucket policy, access points, or another provider-side
mechanism.

## 15. Prohibited or discouraged credentials

A compatible interface should reject or strongly warn about:

- AWS root-account credentials.
- Provider-wide administrative keys.
- Credentials covering unrelated buckets without a clear reason.
- Credentials that can alter IAM or account billing.
- Plain HTTP endpoints outside explicit local development.
- One powerful shared credential reused by unrelated applications.
- Long-lived credentials where temporary credentials are available.

## 16. Export behavior

Before exporting an S3C string, BitLogin must show:

> This string contains storage credentials. Anyone who obtains it may read,
> upload, overwrite, or delete data allowed by the provider-side policy.

Export should require a fresh user action. A plaintext string should not remain
visible after navigation, logout, or a short inactivity interval.

Normal BitLogin account backups should contain only the encrypted Connection
Vault event, not the plaintext S3C string.

## 17. Revocation and deletion

Removing the BitLogin record does not invalidate the provider credential.

Safe flow:

1. Revoke or deactivate the key at the S3 provider.
2. Confirm that applications no longer need it.
3. Tombstone the Connection Vault record.
4. Publish a NIP-09 deletion request for the previous event.
5. Clear local decrypted copies and persistent grants.

Provider-specific adapters may help open the correct dashboard or automate key
rotation, but S3C itself defines no universal revocation endpoint.

## 18. Versioning

Future incompatible formats use a new textual prefix:

```text
s3c2:
```

A v1 parser must never silently reinterpret a different prefix or payload
version.

Compatible optional fields may be added only after defining how older parsers
handle them. Fields that change signing, endpoint selection, credential scope,
or security semantics require a new version unless an explicit extension
mechanism is standardized.

## 19. Standalone specification path

S3C begins as an experimental BitLogin format. It may move into a standalone
repository after:

- At least one working BitLogin implementation exists.
- At least one independent application imports or exports it.
- Test vectors and malformed-input fixtures are published.
- Security and interoperability feedback has been incorporated.

A future standalone repository should define only the portable format,
validation, fixtures, and reference codecs. BitLogin's relay encryption and
Connection Vault behavior remain BitLogin-specific.

## 20. Required test vectors

Before implementation, publish fixtures for:

- Minimal valid AWS-style configuration.
- Cloudflare R2 with region `auto`.
- MinIO using path-style addressing.
- Temporary credentials with session token and expiration.
- Empty and non-empty object prefixes.
- Unicode labels.
- Invalid base64url.
- Invalid UTF-8.
- Duplicate JSON keys.
- Missing required fields.
- Insecure endpoints.
- Endpoint credentials or fragments.
- Invalid addressing styles.
- Prefix traversal attempts.
- Canonical decode and re-encode equality.

All published fixtures must use non-functional placeholder credentials.
