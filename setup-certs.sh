#!/usr/bin/env bash
# setup-certs.sh — generate locally-trusted TLS certs for Chirm (LAN/mobile)
#
# Run this once on the machine that hosts Chirm.
# Then follow the printed instructions to trust the CA on each phone/tablet.
#
# Requires: mkcert  (https://github.com/FiloSottile/mkcert)
#   Linux:  apt install mkcert  OR  brew install mkcert
#   macOS:  brew install mkcert
#   Windows: choco install mkcert  OR  scoop install mkcert

set -e

if ! command -v mkcert &>/dev/null; then
  echo "❌  mkcert not found."
  echo "    Install it from: https://github.com/FiloSottile/mkcert#installation"
  echo "    or via your package manager, then re-run this script."
  exit 1
fi

# Install the local CA into the system trust store (only needed once per machine)
mkcert -install

# Collect all LAN IPs to include in the cert's Subject Alternative Names
HOSTS="localhost 127.0.0.1 ::1"
while IFS= read -r ip; do
  HOSTS="$HOSTS $ip"
done < <(ip -4 addr show scope global | grep -oP '(?<=inet\s)\d+(\.\d+){3}' 2>/dev/null || \
         ifconfig 2>/dev/null | grep -oE 'inet (addr:)?[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | grep -v 127.0.0.1)

echo "→ Generating cert for: $HOSTS"

mkdir -p certs
# shellcheck disable=SC2086
mkcert -cert-file certs/cert.pem -key-file certs/key.pem $HOSTS

CA_ROOT=$(mkcert -CAROOT)
echo ""
echo "✅  Done. Chirm will automatically use certs/cert.pem on next start."
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  To trust these certs on Android / iOS / other devices (one-time):"
echo ""
echo "  1. Copy this file to the device:"
echo "       $CA_ROOT/rootCA.pem"
echo ""
echo "  2. Android: Settings → Security → Encryption & credentials"
echo "              → Install a certificate → CA certificate → pick rootCA.pem"
echo ""
echo "  3. iOS/iPadOS: AirDrop or email rootCA.pem to the device,"
echo "                 open it, go to Settings → General → VPN & Device Mgmt,"
echo "                 install the profile, then Settings → General →"
echo "                 About → Certificate Trust Settings → enable it."
echo ""
echo "  After installing, navigate to https://<your-LAN-IP>:8443 —"
echo "  no warnings, full PWA + push notifications."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
