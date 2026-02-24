package handlers

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ─── VAPID Key Management ────────────────────────────────────────────────────

// VAPIDKeys holds the server's VAPID key pair.
type VAPIDKeys struct {
	mu         sync.RWMutex
	privateKey *ecdsa.PrivateKey
	publicKey  []byte // uncompressed P-256 point, URL-safe base64
}

var globalVAPID = &VAPIDKeys{}

// InitVAPID loads or generates VAPID keys, storing them via the DB settings.
func (h *Handler) InitVAPID() error {
	// Try to load existing keys from settings
	privB64, _ := h.db.GetSetting("vapid_private_key")
	pubB64, _  := h.db.GetSetting("vapid_public_key")

	if privB64 != "" && pubB64 != "" {
		privBytes, err1 := base64.RawURLEncoding.DecodeString(privB64)
		if err1 == nil && len(privBytes) == 32 {
			privKey := new(ecdsa.PrivateKey)
			privKey.Curve = elliptic.P256()
			privKey.D = new(big.Int).SetBytes(privBytes)
			privKey.PublicKey.X, privKey.PublicKey.Y = elliptic.P256().ScalarBaseMult(privBytes)

			globalVAPID.mu.Lock()
			globalVAPID.privateKey = privKey
			globalVAPID.publicKey, _ = base64.RawURLEncoding.DecodeString(pubB64)
			globalVAPID.mu.Unlock()
			return nil
		}
	}

	// Generate new VAPID key pair
	privKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("VAPID key gen: %w", err)
	}

	// Encode private key as raw 32-byte big-endian integer
	privBytes := privKey.D.Bytes()
	if len(privBytes) < 32 {
		padded := make([]byte, 32)
		copy(padded[32-len(privBytes):], privBytes)
		privBytes = padded
	}

	// Encode public key as uncompressed P-256 point (04 || X || Y)
	pubBytes := elliptic.Marshal(elliptic.P256(), privKey.PublicKey.X, privKey.PublicKey.Y)

	privB64Enc := base64.RawURLEncoding.EncodeToString(privBytes)
	pubB64Enc  := base64.RawURLEncoding.EncodeToString(pubBytes)

	_ = h.db.SetSetting("vapid_private_key", privB64Enc)
	_ = h.db.SetSetting("vapid_public_key",  pubB64Enc)

	globalVAPID.mu.Lock()
	globalVAPID.privateKey = privKey
	globalVAPID.publicKey  = pubBytes
	globalVAPID.mu.Unlock()

	return nil
}

// ─── HTTP Handlers ────────────────────────────────────────────────────────────

// GetVAPIDPublicKey returns the server's VAPID public key (URL-safe base64).
func (h *Handler) GetVAPIDPublicKey(w http.ResponseWriter, r *http.Request) {
	globalVAPID.mu.RLock()
	pub := globalVAPID.publicKey
	globalVAPID.mu.RUnlock()

	if len(pub) == 0 {
		errResp(w, http.StatusServiceUnavailable, "push not configured")
		return
	}
	ok(w, map[string]string{
		"public_key": base64.RawURLEncoding.EncodeToString(pub),
	})
}

// PushSubscribeRequest is the JSON body the client sends.
type PushSubscribeRequest struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

// SavePushSubscription stores a push subscription for the current user.
func (h *Handler) SavePushSubscription(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req PushSubscribeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Endpoint == "" {
		errResp(w, http.StatusBadRequest, "invalid subscription")
		return
	}

	raw, _ := json.Marshal(req)
	if err := h.db.SavePushSubscription(u.ID, string(raw)); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to save subscription")
		return
	}
	ok(w, map[string]string{"status": "subscribed"})
}

// RemovePushSubscription deletes a push subscription by endpoint.
func (h *Handler) RemovePushSubscription(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req struct {
		Endpoint string `json:"endpoint"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Endpoint == "" {
		errResp(w, http.StatusBadRequest, "endpoint required")
		return
	}
	_ = h.db.DeletePushSubscription(u.ID, req.Endpoint)
	ok(w, map[string]string{"status": "unsubscribed"})
}

// PollUnread is called by the Service Worker's periodic background sync.
func (h *Handler) PollUnread(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	ok(w, map[string]interface{}{"notifications": []interface{}{}})
}

// TestPush sends a test push notification to all of the current user's subscriptions.
// Useful for verifying the VAPID pipeline works end-to-end.
func (h *Handler) TestPush(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	globalVAPID.mu.RLock()
	privKey := globalVAPID.privateKey
	globalVAPID.mu.RUnlock()
	if privKey == nil {
		errResp(w, http.StatusServiceUnavailable, "VAPID not initialised")
		return
	}

	subs, err := h.db.GetChannelPushSubscriptions("")
	if err != nil {
		errResp(w, http.StatusInternalServerError, "db error")
		return
	}

	payload := PushPayload{
		Title: "🔔 Chirm test notification",
		Body:  "Push notifications are working!",
		Tag:   "chirm-test",
	}
	payloadBytes, _ := json.Marshal(payload)

	sent := 0
	var lastErr string
	for _, sub := range subs {
		if sub.UserID != u.ID {
			continue
		}
		var subscription PushSubscribeRequest
		if json.Unmarshal([]byte(sub.Data), &subscription) != nil {
			continue
		}
		if err := sendWebPush(subscription, payloadBytes, privKey); err != nil {
			lastErr = err.Error()
		} else {
			sent++
		}
	}

	if sent == 0 && lastErr != "" {
		ok(w, map[string]interface{}{"sent": 0, "error": lastErr})
	} else {
		ok(w, map[string]interface{}{"sent": sent, "subscriptions": len(subs)})
	}
}

// ─── Sending Push Notifications ──────────────────────────────────────────────

// PushPayload is what we send to subscribers when a new message arrives.
type PushPayload struct {
	Title     string `json:"title"`
	Body      string `json:"body"`
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
	Tag       string `json:"tag"`
}

// BroadcastPush sends a Web Push notification to all subscribers of the
// specified channel (except the message author).
// This is called non-blocking from SendMessage.
func (h *Handler) BroadcastPush(channelName, authorUserID string, payload PushPayload) {
	go func() {
		subs, err := h.db.GetChannelPushSubscriptions(channelName)
		if err != nil || len(subs) == 0 {
			return
		}

		payloadBytes, _ := json.Marshal(payload)

		globalVAPID.mu.RLock()
		privKey := globalVAPID.privateKey
		globalVAPID.mu.RUnlock()

		if privKey == nil {
			return
		}

		for _, sub := range subs {
			if sub.UserID == authorUserID {
				continue // don't notify the sender
			}
			var subscription PushSubscribeRequest
			if err := json.Unmarshal([]byte(sub.Data), &subscription); err != nil {
				continue
			}
			sendWebPush(subscription, payloadBytes, privKey)
		}
	}()
}

// ─── RFC 8030 / RFC 8291 / RFC 8292 Web Push Implementation ─────────────────
// Implemented using only Go's standard library.

func sendWebPush(sub PushSubscribeRequest, plaintext []byte, vapidPrivKey *ecdsa.PrivateKey) error {
	// 1. Decode subscriber's public key and auth secret
	clientPubKeyBytes, err := base64.RawURLEncoding.DecodeString(padBase64(sub.Keys.P256dh))
	if err != nil {
		return fmt.Errorf("decode p256dh: %w", err)
	}
	authSecret, err := base64.RawURLEncoding.DecodeString(padBase64(sub.Keys.Auth))
	if err != nil {
		return fmt.Errorf("decode auth: %w", err)
	}

	// 2. Generate ephemeral sender key pair
	senderKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}

	// 3. ECDH between sender key and client key
	clientX, clientY := elliptic.Unmarshal(elliptic.P256(), clientPubKeyBytes)
	if clientX == nil {
		return fmt.Errorf("invalid client public key")
	}
	sharedX, _ := elliptic.P256().ScalarMult(clientX, clientY, senderKey.D.Bytes())
	sharedSecret := sharedX.Bytes()
	if len(sharedSecret) < 32 {
		padded := make([]byte, 32)
		copy(padded[32-len(sharedSecret):], sharedSecret)
		sharedSecret = padded
	}

	// 4. Generate random salt (16 bytes)
	salt := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return err
	}

	// 5. Sender public key bytes (uncompressed)
	senderPubBytes := elliptic.Marshal(elliptic.P256(), senderKey.PublicKey.X, senderKey.PublicKey.Y)

	// 6. HKDF (RFC 5869) to derive content encryption key and nonce
	// PRK = HMAC-SHA256(auth_secret, ECDH_secret)
	// IKM = HMAC-SHA256(PRK, "WebPush: info\x00" || client_pub || sender_pub || 0x01)
	prk := hkdfExtract(authSecret, sharedSecret)
	info := append([]byte("WebPush: info\x00"), clientPubKeyBytes...)
	info = append(info, senderPubBytes...)
	info = append(info, 0x01)
	ikm := hkdfExpand(prk, info, 32)

	// Key derivation for AES-128-GCM
	saltPRK := hkdfExtract(salt, ikm)

	cekInfo := append([]byte("Content-Encoding: aes128gcm\x00"), 0x01)
	cek := hkdfExpand(saltPRK, cekInfo, 16)

	nonceInfo := append([]byte("Content-Encoding: nonce\x00"), 0x01)
	nonce := hkdfExpand(saltPRK, nonceInfo, 12)

	// 7. Encrypt with AES-128-GCM (RFC 8188 record format)
	encrypted, err := encryptAES128GCM(cek, nonce, salt, senderPubBytes, plaintext)
	if err != nil {
		return fmt.Errorf("encrypt: %w", err)
	}

	// 8. Build VAPID JWT (RFC 8292)
	audience := extractOrigin(sub.Endpoint)
	vapidToken, err := buildVAPIDJWT(vapidPrivKey, audience)
	if err != nil {
		return fmt.Errorf("vapid jwt: %w", err)
	}

	vapidPubB64 := base64.RawURLEncoding.EncodeToString(
		elliptic.Marshal(elliptic.P256(), vapidPrivKey.PublicKey.X, vapidPrivKey.PublicKey.Y),
	)

	// 9. Send HTTP POST to push endpoint
	req, err := http.NewRequest("POST", sub.Endpoint, bytes.NewReader(encrypted))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("Authorization", fmt.Sprintf("vapid t=%s,k=%s", vapidToken, vapidPubB64))
	req.Header.Set("TTL", "86400")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("push request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("push endpoint %d: %s", resp.StatusCode, string(body))
	}
	return nil
}

// encryptAES128GCM encrypts plaintext according to RFC 8188.
func encryptAES128GCM(key, nonce, salt, senderPub, plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	// Pad the plaintext with a delimiter byte (0x02 = last record)
	padded := append(plaintext, 0x02)

	encrypted := gcm.Seal(nil, nonce, padded, nil)

	// Build RFC 8188 header: salt(16) + rs(4) + idlen(1) + keyid(senderPub)
	rs := uint32(4096) // record size
	header := make([]byte, 0, 16+4+1+len(senderPub))
	header = append(header, salt...)
	rsBuf := make([]byte, 4)
	binary.BigEndian.PutUint32(rsBuf, rs)
	header = append(header, rsBuf...)
	header = append(header, byte(len(senderPub)))
	header = append(header, senderPub...)

	return append(header, encrypted...), nil
}

// hkdfExtract computes HKDF-Extract(salt, ikm) = HMAC-SHA256(salt, ikm).
func hkdfExtract(salt, ikm []byte) []byte {
	h := hmacSHA256(salt, ikm)
	return h
}

// hkdfExpand computes HKDF-Expand(prk, info, length).
func hkdfExpand(prk, info []byte, length int) []byte {
	var result []byte
	prev := []byte{}
	for i := 1; len(result) < length; i++ {
		data := append(prev, info...)
		data = append(data, byte(i))
		prev = hmacSHA256(prk, data)
		result = append(result, prev...)
	}
	return result[:length]
}

func hmacSHA256(key, data []byte) []byte {
	// RFC 2104 HMAC-SHA256
	blockSize := 64
	if len(key) > blockSize {
		h := sha256.Sum256(key)
		key = h[:]
	}
	if len(key) < blockSize {
		padded := make([]byte, blockSize)
		copy(padded, key)
		key = padded
	}
	opad := make([]byte, blockSize)
	ipad := make([]byte, blockSize)
	for i := 0; i < blockSize; i++ {
		opad[i] = key[i] ^ 0x5c
		ipad[i] = key[i] ^ 0x36
	}
	inner := sha256.Sum256(append(ipad, data...))
	outer := sha256.Sum256(append(opad, inner[:]...))
	return outer[:]
}

func buildVAPIDJWT(privKey *ecdsa.PrivateKey, audience string) (string, error) {
	now := time.Now()
	claims := jwt.MapClaims{
		"aud": audience,
		"exp": now.Add(12 * time.Hour).Unix(),
		"sub": "mailto:chirm@localhost",
		"iat": now.Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	return token.SignedString(privKey)
}

func extractOrigin(endpoint string) string {
	// Extract scheme + host from endpoint URL
	parts := strings.SplitN(endpoint, "/", 4)
	if len(parts) >= 3 {
		return parts[0] + "//" + parts[2]
	}
	return endpoint
}

func padBase64(s string) string {
	switch len(s) % 4 {
	case 2:
		return s + "=="
	case 3:
		return s + "="
	}
	return s
}
