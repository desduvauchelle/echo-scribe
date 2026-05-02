#!/usr/bin/env bash
# One-time setup: create a self-signed code-signing certificate so every
# `bun tauri build` produces a binary with the SAME signature. macOS keys TCC
# permission grants to the signature, so this means Microphone + Accessibility
# grants survive every reinstall — no more re-prompting after a rebuild.
#
# Steps performed:
#   1. Generate a self-signed RSA cert valid for 10 years with the
#      `codeSigning` extended key usage (id-kp-codeSigning, 1.3.6.1.5.5.7.3.3).
#   2. Import the cert + private key into your login keychain.
#   3. Trust the cert for code signing in the System keychain (one sudo prompt).
#   4. Verify `security find-identity` lists it.
#
# After this script succeeds, `tauri.conf.json` is already wired up to use
# the identity (see `bundle.macOS.signingIdentity`).
#
# Idempotent: if the identity already exists, exits cleanly.

set -euo pipefail

CN="Echo Scribe Local Dev"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cd "$(dirname "$0")/.."

# Already a trusted identity? Done.
if security find-identity -v -p codesigning | grep -q "$CN"; then
    echo "==> Code-signing identity '$CN' already present. Nothing to do."
    security find-identity -v -p codesigning | grep "$CN"
    exit 0
fi

# Cert already in keychain (e.g. from a prior partial run that didn't reach
# the trust step)? Skip generate/import and just trust the existing one.
if security find-certificate -c "$CN" >/dev/null 2>&1; then
    echo "==> Cert '$CN' already in login keychain — extracting to trust it."
    security find-certificate -c "$CN" -p > "$WORKDIR/cert.pem"
else
    echo "==> Generating self-signed certificate ($CN)…"
    /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout "$WORKDIR/key.pem" \
        -out "$WORKDIR/cert.pem" \
        -subj "/CN=$CN/O=Echo Scribe Local/C=US" \
        -addext "extendedKeyUsage=codeSigning,1.3.6.1.5.5.7.3.3" \
        -addext "basicConstraints=critical,CA:false" \
        -addext "keyUsage=critical,digitalSignature" \
        >/dev/null 2>&1

    echo "==> Bundling into PKCS#12…"
    P12_PASS="echoscribe-temp"
    /usr/bin/openssl pkcs12 -export \
        -inkey "$WORKDIR/key.pem" \
        -in "$WORKDIR/cert.pem" \
        -out "$WORKDIR/cert.p12" \
        -passout "pass:$P12_PASS"

    echo "==> Importing into login keychain (allowing /usr/bin/codesign access)…"
    /usr/bin/security import "$WORKDIR/cert.p12" \
        -k "$HOME/Library/Keychains/login.keychain-db" \
        -T /usr/bin/codesign \
        -T /usr/bin/security \
        -P "$P12_PASS" \
        >/dev/null
fi

echo "==> Trusting cert for code signing (sudo will prompt)…"
sudo security add-trusted-cert -d -r trustRoot \
    -p codeSign \
    -k /Library/Keychains/System.keychain \
    "$WORKDIR/cert.pem"

echo "==> Verifying…"
if ! security find-identity -v -p codesigning | grep -q "$CN"; then
    echo "Failed to verify identity in keychain. See errors above." >&2
    exit 1
fi
security find-identity -v -p codesigning | grep "$CN"

echo "==> Patching src-tauri/tauri.conf.json with signingIdentity…"
CONFIG="src-tauri/tauri.conf.json"
# Use the SHA-1 hash as the signing identity (not the CN). The cert exists in
# both login and System keychains after the trust step, so a name-based lookup
# is ambiguous and codesign refuses. The hash is unique and works.
SHA1=$(security find-identity -v -p codesigning | grep "$CN" | head -1 | awk '{print $2}')
if [[ -z "$SHA1" ]]; then
    echo "Could not extract SHA-1 for $CN" >&2
    exit 1
fi

if grep -q '"signingIdentity"' "$CONFIG"; then
    /usr/bin/sed -i '' \
        "s|\"signingIdentity\": \"[^\"]*\"|\"signingIdentity\": \"$SHA1\"|" \
        "$CONFIG"
    echo "    Updated signingIdentity to $SHA1"
else
    /usr/bin/sed -i '' \
        's|"infoPlist": "Info.plist"|"infoPlist": "Info.plist",\
      "signingIdentity": "'"$SHA1"'"|' \
        "$CONFIG"
    echo "    Added: \"signingIdentity\": \"$SHA1\""
fi

echo
echo "==> Done."
echo "    Run ./reinstall.command — the build will sign with '$CN'."
echo "    First launch will still prompt once for Microphone + Accessibility"
echo "    (the OLD ad-hoc grants don't transfer). Every reinstall AFTER that"
echo "    keeps grants silently."
