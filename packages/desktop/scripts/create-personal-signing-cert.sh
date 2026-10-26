#!/usr/bin/env bash
# Creates the self-signed code-signing certificate for personal macOS builds.
#
# Ad-hoc signatures change on every build, so macOS refuses in-app updates
# between them. Signing every build with this one certificate keeps the app's
# designated requirement stable and lets electron-updater install the next build.
#
# Run once on your Mac, then add the two printed values as repository secrets.
# Keep the output folder backed up: a new certificate means one more manual install.
set -euo pipefail

name="${1:-Paseo Personal Signing}"
out="${PASEO_SIGNING_OUT:-$HOME/paseo-personal-signing}"

if [ -e "$out" ]; then
  echo "$out already exists. Move it away or set PASEO_SIGNING_OUT to another folder." >&2
  exit 1
fi

# macOS ships LibreSSL at /usr/bin/openssl, whose PKCS#12 output the keychain imports.
# A Homebrew OpenSSL 3 needs the legacy encryption flags for the same result.
openssl_bin=/usr/bin/openssl
[ -x "$openssl_bin" ] || openssl_bin="$(command -v openssl)"
pkcs12_flags=()
if "$openssl_bin" version | grep -q '^OpenSSL 3'; then
  pkcs12_flags=(-certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1)
fi

mkdir -p "$out"
chmod 700 "$out"
cd "$out"

cat > cert.conf <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = $name
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF

"$openssl_bin" req -x509 -newkey rsa:3072 -sha256 -days 7300 -nodes \
  -config cert.conf -keyout key.pem -out cert.pem 2>/dev/null

password="$("$openssl_bin" rand -base64 24 | tr -d '/+=' | cut -c1-28)"
# The ${a[@]+...} form keeps macOS's bash 3.2 from treating an empty array as unset.
"$openssl_bin" pkcs12 -export ${pkcs12_flags[@]+"${pkcs12_flags[@]}"} -name "$name" \
  -inkey key.pem -in cert.pem -out signing.p12 -passout "pass:$password"

# The key now lives only inside the password-protected .p12.
rm -f key.pem cert.conf
printf '%s\n' "$password" > p12-password.txt
base64 < signing.p12 | tr -d '\n' > p12-base64.txt
chmod 600 signing.p12 p12-password.txt p12-base64.txt

fingerprint="$("$openssl_bin" x509 -in cert.pem -noout -fingerprint -sha1 | cut -d= -f2)"

cat <<EOF

Created "$name" in $out
SHA-1 fingerprint: $fingerprint

Add two secrets at
https://github.com/dandibbert/paseo/settings/secrets/actions

  PASEO_MAC_SIGNING_P12_BASE64    contents of $out/p12-base64.txt
  PASEO_MAC_SIGNING_P12_PASSWORD  contents of $out/p12-password.txt

Copy them with:
  pbcopy < "$out/p12-base64.txt"
  pbcopy < "$out/p12-password.txt"

Back up $out somewhere safe. Do not commit or paste it anywhere else.
EOF
