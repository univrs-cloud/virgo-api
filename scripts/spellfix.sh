#!/bin/bash

set -o errexit -o pipefail

version=3.54.1
amalgamation=sqlite-amalgamation-3540100
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL -o "$work/amalgamation.zip" "https://www.sqlite.org/2026/$amalgamation.zip"
curl -fsSL -o "$work/spellfix.c" "https://raw.githubusercontent.com/sqlite/sqlite/version-$version/ext/misc/spellfix.c"

sha256sum --check --strict - <<EOF
0a9c8e34352dad46006aa82836d5383bff9dc6bc9ce5a60553c05aa30e6ad1f9  $work/amalgamation.zip
b961fe17a2fe7082a4a8c7a2676d16ea5450a9021b8b604ff446267312652c51  $work/spellfix.c
EOF

unzip -q "$work/amalgamation.zip" -d "$work"
gcc -O2 -fPIC -shared -I "$work/$amalgamation" "$work/spellfix.c" -o indexer/spellfix.so
