package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"math"
	"strings"
	"time"
)

const totpDigits = 6
const totpPeriod = 30 // seconds

// GenerateTOTPSecret creates a new random 20-byte base32-encoded secret.
func GenerateTOTPSecret() (string, error) {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b), nil
}

// TOTPProvisioningURI returns the otpauth:// URI for QR code display.
func TOTPProvisioningURI(secret, username, issuer string) string {
	return fmt.Sprintf(
		"otpauth://totp/%s:%s?secret=%s&issuer=%s&algorithm=SHA1&digits=%d&period=%d",
		issuer, username, secret, issuer, totpDigits, totpPeriod,
	)
}

// ValidateTOTP checks whether code matches the TOTP for the given secret at
// the current time. Accepts one step of clock drift (±30 s).
func ValidateTOTP(secret, code string) bool {
	// Normalise: strip spaces, uppercase.
	code = strings.ReplaceAll(code, " ", "")
	if len(code) != totpDigits {
		return false
	}

	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(
		strings.ToUpper(secret),
	)
	if err != nil {
		return false
	}

	now := time.Now().Unix()
	for _, offset := range []int64{-1, 0, 1} {
		counter := uint64((now / totpPeriod) + offset)
		expected := computeTOTP(key, counter)
		if code == expected {
			return true
		}
	}
	return false
}

// computeTOTP computes a TOTP code for the given key and counter (RFC 6238 §5.2).
func computeTOTP(key []byte, counter uint64) string {
	msg := make([]byte, 8)
	binary.BigEndian.PutUint64(msg, counter)

	mac := hmac.New(sha1.New, key)
	mac.Write(msg)
	h := mac.Sum(nil)

	// Dynamic truncation (RFC 4226 §5.3).
	offset := h[len(h)-1] & 0x0f
	binCode := (uint32(h[offset]&0x7f) << 24) |
		(uint32(h[offset+1]) << 16) |
		(uint32(h[offset+2]) << 8) |
		uint32(h[offset+3])

	otp := binCode % uint32(math.Pow10(totpDigits))
	return fmt.Sprintf("%06d", otp)
}
