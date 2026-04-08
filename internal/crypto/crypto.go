package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/crypto/hkdf"
	"crypto/sha256"
)

// ErrNotEncrypted is returned when a value does not carry the enc: prefix.
var ErrNotEncrypted = errors.New("value is not encrypted")

// encPrefix is prepended to every encrypted DB field value.
// Its presence is the lazy-migration sentinel: old plaintext rows lack it.
const encPrefix = "enc:"

// KeyFromEnv reads CHIRM_ENCRYPTION_KEY from the environment.
// The value must be exactly 64 hex characters (32 bytes).
// Returns (nil, nil) when the env var is absent — encryption is optional.
// Returns an error when the var is present but malformed.
func KeyFromEnv() (*[32]byte, error) {
	raw := os.Getenv("CHIRM_ENCRYPTION_KEY")
	if raw == "" {
		return nil, nil
	}
	b, err := hex.DecodeString(raw)
	if err != nil || len(b) != 32 {
		return nil, fmt.Errorf("must be exactly 64 hex characters (32 bytes); got %d bytes", len(b))
	}
	var key [32]byte
	copy(key[:], b)
	return &key, nil
}

// DeriveKey produces a per-context 32-byte key using HKDF-SHA256.
//
//   masterKey — the server master secret
//   salt      — per-record entropy (record ID bytes); reused across fields of the same record
//   info      — field discriminator, e.g. "message-content" or "file"
func DeriveKey(masterKey *[32]byte, salt []byte, info string) [32]byte {
	h := hkdf.New(sha256.New, masterKey[:], salt, []byte(info))
	var key [32]byte
	if _, err := io.ReadFull(h, key[:]); err != nil {
		// HKDF over a fixed-size output never fails — panic is appropriate here.
		panic("crypto.DeriveKey: hkdf read failed: " + err.Error())
	}
	return key
}

// Encrypt encrypts plaintext under key using AES-256-GCM.
// Returns [12-byte nonce || ciphertext || 16-byte GCM tag].
func Encrypt(key [32]byte, plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize()) // 12 bytes
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	ciphertext := gcm.Seal(nonce, nonce, plaintext, nil)
	return ciphertext, nil
}

// Decrypt reverses Encrypt.
// Returns ErrNotEncrypted if blob is shorter than the nonce+tag minimum.
func Decrypt(key [32]byte, blob []byte) ([]byte, error) {
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(blob) < gcm.NonceSize()+gcm.Overhead() {
		return nil, ErrNotEncrypted
	}
	nonce := blob[:gcm.NonceSize()]
	ciphertext := blob[gcm.NonceSize():]
	return gcm.Open(nil, nonce, ciphertext, nil)
}

// EncryptField encrypts a DB field value and returns the result as a string
// of the form "enc:<base64url(nonce||ciphertext||tag)>".
//
//   masterKey  — server master secret
//   recordID   — the record's ID (used as the HKDF salt)
//   fieldName  — field discriminator (used as the HKDF info)
//   plaintext  — the field value to encrypt
func EncryptField(masterKey *[32]byte, recordID, fieldName, plaintext string) (string, error) {
	key := DeriveKey(masterKey, []byte(recordID), fieldName)
	blob, err := Encrypt(key, []byte(plaintext))
	if err != nil {
		return "", err
	}
	return encPrefix + base64.RawURLEncoding.EncodeToString(blob), nil
}

// DecryptField reverses EncryptField.
// Returns ErrNotEncrypted if value does not carry the enc: prefix
// (i.e., it is a legacy plaintext value).
func DecryptField(masterKey *[32]byte, recordID, fieldName, value string) (string, error) {
	if !strings.HasPrefix(value, encPrefix) {
		return "", ErrNotEncrypted
	}
	blob, err := base64.RawURLEncoding.DecodeString(value[len(encPrefix):])
	if err != nil {
		return "", fmt.Errorf("base64 decode: %w", err)
	}
	key := DeriveKey(masterKey, []byte(recordID), fieldName)
	plaintext, err := Decrypt(key, blob)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

// IsEncryptedField reports whether value carries the enc: prefix.
func IsEncryptedField(value string) bool {
	return strings.HasPrefix(value, encPrefix)
}

// EncryptFile encrypts src bytes for on-disk storage.
// The returned blob has the format:
//
//	[32-byte random salt || 12-byte nonce || AES-256-GCM ciphertext+tag]
//
// The salt is random (not derived from a record ID) because the file's record
// ID may not be available at write time.
func EncryptFile(masterKey *[32]byte, plaintext []byte) ([]byte, error) {
	salt := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, err
	}
	key := DeriveKey(masterKey, salt, "file")
	blob, err := Encrypt(key, plaintext)
	if err != nil {
		return nil, err
	}
	return append(salt, blob...), nil
}

// DecryptFile reverses EncryptFile.
// Returns ErrNotEncrypted if blob is too short to contain the salt+nonce+tag minimum.
func DecryptFile(masterKey *[32]byte, blob []byte) ([]byte, error) {
	const saltLen = 32
	// Minimum: salt(32) + nonce(12) + tag(16) = 60 bytes
	if len(blob) < saltLen+12+16 {
		return nil, ErrNotEncrypted
	}
	salt := blob[:saltLen]
	key := DeriveKey(masterKey, salt, "file")
	return Decrypt(key, blob[saltLen:])
}
