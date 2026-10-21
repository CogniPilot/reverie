# Runs INSIDE the boot container: docker exec -i boot bash -s < boot-owner.sh
# Secrets stay in 0600 files under $TMPDIR; nothing secret is echoed. Prints one line per check.
set -u; umask 077; ok=1
api=http://127.0.0.1:3000; d=$TMPDIR/owner-ci; mkdir -p "$d"
py=/opt/fleet/python/bin/python3
code() { curl -sS -o "$d/body" -w '%{http_code}' --netrc-file "$TMPDIR/netrc" -H "Origin: $api" "$@" || true; }
expect() { echo "$1: got $2, want $3"; [ "$2" = "$3" ] || ok=; }
# 1. The console password alone must be refused under enforce.
expect "console password alone, GET /api/status" "$(code "$api/api/status")" 401
# 2. Create the owner account (the image's setup.sh --owner step). One-time password to a 0600 file only.
REVERIE_DATA_DIR=/instances/default/console reverie owner bootstrap --username owner --enforce > "$d/boot.out" 2>&1 || ok=
sed -n 's/^One-time password: //p' "$d/boot.out" > "$d/otp"; [ -s "$d/otp" ] || { echo "bootstrap printed no one-time password"; ok=; }
grep -v '^One-time password:' "$d/boot.out"
$py -I -c 'import json,sys; print(json.dumps({"username":"owner","password":open(sys.argv[1]).read().strip()}))' "$d/otp" > "$d/login.json"
$py -I -c 'import json,secrets,sys; n=secrets.token_urlsafe(24); open(sys.argv[2],"w").write(json.dumps({"current":open(sys.argv[1]).read().strip(),"next":n}))' "$d/otp" "$d/change.json"
# 3. Sign in with the one-time password (Basic still applies first, then the owner session).
expect "one-time sign-in" "$(code -c "$d/jar" -H 'Content-Type: application/json' --data-binary @"$d/login.json" "$api/api/owner/login")" 200
# 4. A one-time session is restricted until the password changes.
expect "one-time session, GET /api/status" "$(code -b "$d/jar" "$api/api/status")" 403
# 5. Change the password; the reply sets the full owner session.
expect "password change" "$(code -b "$d/jar" -c "$d/jar" -H 'Content-Type: application/json' --data-binary @"$d/change.json" "$api/api/owner/password")" 200
# 6. The signed-in owner reaches an owner route.
expect "signed-in owner, GET /api/status" "$(code -b "$d/jar" "$api/api/status")" 200
# 7. Basic plus an agent header never reaches it.
expect "console password + agent header" "$(code -H 'x-codeman-parent-session: 0000002d-0035-4000-8000-000000000047' "$api/api/status")" 403
rm -rf "$d"; test "${ok:-}" = 1
