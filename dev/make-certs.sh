#!/usr/bin/env bash
# Erzeugt Wegwerf-Zertifikate für die TLS-Testserver (dev/certs, nicht im Repo).
# Aufruf (Git-Bash): bash dev/make-certs.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p certs
cd certs
export MSYS_NO_PATHCONV=1

# Zertifizierungsstelle
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=OwlynDB Test-CA" -keyout ca.key -out ca.crt

# Server: localhost und 127.0.0.1
cat > server.ext <<'EOF'
subjectAltName = DNS:localhost, IP:127.0.0.1
extendedKeyUsage = serverAuth
EOF
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout server.key -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 -extfile server.ext -out server.crt
# HAProxy erwartet Zertifikat und Schlüssel in einer Datei
cat server.crt server.key > server.pem

# Client: CN = Datenbankbenutzer
cat > client.ext <<'EOF'
extendedKeyUsage = clientAuth
EOF
openssl req -newkey rsa:2048 -nodes -subj "/CN=certuser" -keyout client.key -out client.csr
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 -extfile client.ext -out client.crt

# derselbe Schlüssel mit Passwort, und als PKCS#12 (Client-Zertifikat samt Schlüssel in einer Datei)
openssl pkey -in client.key -aes256 -passout pass:keypass -out client-enc.key
openssl pkcs12 -export -in client.crt -inkey client.key -passout pass:keypass -out client.p12

# dasselbe mit EC-Schlüssel als PKCS#12 (node-forge kennt nur RSA, die Umwandlung läuft über Node)
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=certuser" -keyout client-ec.key -out client-ec.csr
openssl x509 -req -in client-ec.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 -extfile client.ext -out client-ec.crt
openssl pkcs12 -export -in client-ec.crt -inkey client-ec.key -passout pass:keypass -out client-ec.p12

# fremde CA mit eigenem Client-Zertifikat (muss abgelehnt werden)
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Fremde CA" -keyout other-ca.key -out other-ca.crt
openssl req -newkey rsa:2048 -nodes -subj "/CN=certuser" -keyout other-client.key -out other-client.csr
openssl x509 -req -in other-client.csr -CA other-ca.crt -CAkey other-ca.key -CAcreateserial -days 3650 -extfile client.ext -out other-client.crt

# Zertifikat und Schlüssel in einer Datei (wie openssl s_client -cert ohne -key)
cat client.crt client.key > client-combined.pem

# SSH-Schlüssel für den SSH-Testserver: ohne und mit Passwort
rm -f ssh_client ssh_client.pub ssh_client_enc ssh_client_enc.pub
ssh-keygen -q -t ed25519 -N '' -C owlyndb-test -f ssh_client
ssh-keygen -q -t ed25519 -N 'sshpass' -C owlyndb-test-enc -f ssh_client_enc

rm -f ./*.csr ./*.ext ./*.srl
chmod 644 ./*
echo "Zertifikate in dev/certs erzeugt"
