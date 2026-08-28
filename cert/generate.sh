#!/bin/bash

set -e
set -o pipefail

cert_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
key_file="$cert_dir/key.pem"
csr_file="$cert_dir/csr.pem"
cert_file="$cert_dir/cert.pem"
renew_window=2592000

if [ "$1" != "--force" ] && [ -f "$key_file" ] && [ -f "$cert_file" ] &&
	openssl x509 -checkend "$renew_window" -noout -in "$cert_file" > /dev/null 2>&1; then
	exit 0
fi

openssl genrsa -out "$key_file" 4096
chmod 600 "$key_file"
openssl req -new -key "$key_file" -out "$csr_file" -subj "/CN=virgo/O=univrs.cloud/C=RO"
openssl x509 -req -days 365 -in "$csr_file" -signkey "$key_file" -out "$cert_file" -sha256
chmod 644 "$cert_file"
echo "Generated self-signed certificate in $cert_dir."
