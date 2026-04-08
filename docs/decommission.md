# Chirm — Decommissioning & At-Rest Security Guide

This document covers key management for at-rest encryption (S2), the wipe
procedure for decommissioning a server, and what each control does and does
not guarantee.

---

## At-Rest Encryption (S2)

Chirm's at-rest protection encrypts message content, channel descriptions, user
profile fields (bio, links), and user-uploaded files using AES-256-GCM. The
master key is held only in the running process environment — an adversary who
obtains the database files and uploads directory without the running environment
cannot read protected content.

### Setting the Encryption Key

Generate a 32-byte (256-bit) key and set it as an environment variable:

```sh
openssl rand -hex 32
# example output: a3f1...64 hex characters
```

Add it to your environment or `.env` file:

```
CHIRM_ENCRYPTION_KEY=<64-hex-char key>
```

Encryption is **opt-in**. If `CHIRM_ENCRYPTION_KEY` is absent, the server runs
without at-rest encryption and existing plaintext data remains readable. Set the
key before first use on a new server, or run the migration tool on an existing
one (see below).

### Key Storage

Store `CHIRM_ENCRYPTION_KEY` as a system service secret, not in the repository
or any version-controlled file. Options:

- **systemd**: `EnvironmentFile=/etc/chirm/secrets` (mode 0600, root-owned)
- **Docker/Compose**: secret mount or `--env-file` (never `ENV` in a Dockerfile)
- **Secrets manager**: pass the key at runtime via environment injection

### What Is Encrypted

| Data | Encrypted |
|------|-----------|
| Message content | Yes |
| Channel descriptions | Yes |
| User bio, links | Yes |
| User email | No (used as auth lookup key) |
| Usernames, avatars, status | No (public identifiers) |
| User-uploaded files (attachments, avatars, banners) | Yes |
| Server icon, login background, custom emoji | No (public assets) |
| Message metadata (timestamps, sender IDs, reaction counts) | No |

The metadata layer (who talked to whom, when) is structurally visible in the
database and is not encrypted by S2. S3 (End-to-End Encryption) addresses
content confidentiality from the server itself.

### What S2 Does Not Protect Against

- **Runtime compromise**: if the server process or host environment is
  compromised, `CHIRM_ENCRYPTION_KEY` is accessible and all data is decryptable.
- **Targeted adversaries with legal compulsion**: Chirm's threat model covers
  ambient surveillance and casual institutional access, not targeted actors with
  the ability to compel key disclosure.
- **SSD physical data recovery**: overwriting files at the OS layer does not
  guarantee physical erasure on flash storage due to wear levelling. Full-disk
  encryption (see below) is the correct mitigiation for hardware disposal.

---

## Migrating Existing Data

### Database fields

DB field encryption is lazy: new writes are always encrypted when the key is
set; existing plaintext rows are read transparently (the `enc:` prefix sentinel
distinguishes them). Message content that is never edited remains plaintext
until an eager migration is run (below) or the server is re-seeded.

### Uploaded files

Files written before the key was set remain as plaintext on disk. After setting
`CHIRM_ENCRYPTION_KEY`, run:

```sh
./chirm --migrate-uploads
```

This reads every user-content file in `{DATA_DIR}/uploads/`, encrypts it
in-place (write to `.tmp`, rename), and logs progress. Public assets
(`server_icon_*`, `login_bg_*`, `emoji_*`) are skipped. The operation is
idempotent — already-encrypted files are detected and skipped. The server can
remain running during migration; `ServeUpload` handles both encrypted and
legacy plaintext files transparently.

---

## Key Rotation

To rotate the master key:

1. Stop the server.
2. Decrypt all stored data with the old key (requires a custom migration pass —
   contact the maintainers for a rotation tool if needed).
3. Set the new `CHIRM_ENCRYPTION_KEY`.
4. Re-encrypt all data with the new key.
5. Start the server.

A one-pass rotation tool (`--rotate-key OLD_KEY NEW_KEY`) is planned for a
future release. Until then, rotation requires data export + re-import or a
purpose-built script.

---

## Decommissioning the Server

### Wipe via API

The owner account can trigger a full data wipe through the API:

```sh
curl -X POST https://your-server/api/v1/admin/wipe \
  -H "Content-Type: application/json" \
  -b "your-auth-cookie" \
  -d '{"confirm":"WIPE ALL DATA"}'
```

This will:
1. Overwrite and delete all files in `{DATA_DIR}/uploads/`
2. Overwrite and delete all per-channel database files in `{DATA_DIR}/channels/`
3. Overwrite and delete `auth.db`, `members.db`, and `server.db` plus their
   WAL/SHM sidecar files

**The confirmation string `"WIPE ALL DATA"` is required** to prevent accidental
triggers.

### What the Wipe Does Not Guarantee

The wipe overwrites file contents with zeros before deletion. However:

- **SSDs and flash storage** use wear levelling, which means the OS write may
  not overwrite the same physical cell that held the original data. The previous
  data may remain in flash cells until they are reused by the controller.
- **This is a known limitation of software-level wiping on modern storage.**

The recommended approach for hardware disposal is **full-disk encryption at
the OS layer**. If the disk is encrypted with LUKS (Linux), destroying or
rotating the LUKS key renders all data unrecoverable regardless of whether
individual files were overwritten.

### Recommended Decommission Procedure (Linux)

1. Run the API wipe to zero-overwrite and delete all application data.
2. Stop the Chirm process.
3. Destroy the LUKS encryption key for the data partition:
   ```sh
   cryptsetup luksErase /dev/sdX
   ```
   This renders the encrypted partition permanently unreadable without needing
   to overwrite the disk.
4. If disposing of the hardware, physically destroy the storage medium for
   highest assurance (shredder, degausser, or manufacturer secure erase if
   supported by the drive firmware).

### Backup Security

Backups of an unencrypted database are as sensitive as the database itself.

- Encrypt all backups at rest (e.g. `gpg --symmetric` or `age`).
- If using S2 encryption: backups of an encrypted database are only as safe as
  the backup storage — the `CHIRM_ENCRYPTION_KEY` is still required to read them.
- Never store `CHIRM_ENCRYPTION_KEY` alongside the backup.
- Test restore procedures; a backup that has never been restored is not a backup.

---

## Summary

| Threat | S2 Protection | Recommended Complement |
|--------|--------------|----------------------|
| Disk exfiltration (DB + uploads, no running env) | Mitigated | — |
| Runtime/process compromise | Not mitigated | Host hardening, minimal process permissions |
| SSD physical recovery after wipe | Partial (software overwrite only) | LUKS full-disk encryption |
| Targeted adversary with legal compulsion | Not mitigated | Out of Chirm's scope |
| Backup exfiltration | Partial (key still required) | Encrypted offsite backups; separate key storage |
