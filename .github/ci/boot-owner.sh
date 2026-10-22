# Runs INSIDE the boot container: docker exec -i boot bash -s < boot-owner.sh
# Secrets stay in 0600 files under $TMPDIR; nothing secret is echoed. Prints one line per check.
set -u; umask 077; ok=1
api=http://127.0.0.1:3000; d=$TMPDIR/owner-ci; mkdir -p "$d"
py=/opt/reverie/python/bin/python3
code() { curl -sS -o "$d/body" -w '%{http_code}' -H "Origin: $api" "$@" || true; }
expect() { echo "$1: got $2, want $3"; [ "$2" = "$3" ] || ok=; }
# Browser-first setup works without the shared console password or a Basic-auth dialog.
expect "first-run account page" "$(code "$api/owner/setup")" 200
$py -I -c 'import json,secrets; p=secrets.token_urlsafe(24); print(json.dumps({"username":"ci-owner","password":p,"confirmation":p}))' > "$d/setup.json"
expect "create chosen owner account" "$(code -c "$d/setup-jar" -H 'Content-Type: application/json' --data-binary @"$d/setup.json" "$api/api/owner/setup")" 200
expect "new owner session, GET /api/status" "$(code -b "$d/setup-jar" "$api/api/status")" 200
expect "second owner claim refused" "$(code -H 'Content-Type: application/json' --data-binary @"$d/setup.json" "$api/api/owner/setup")" 409
# The legacy console password alone must still be refused under enforce.
expect "console password alone, GET /api/status" "$(code --netrc-file "$TMPDIR/netrc" "$api/api/status")" 401
# Advanced host recovery issues an OTP for the existing chosen username, not a replacement account.
REVERIE_DATA_DIR=/instances/default/console reverie owner reset-password > "$d/reset.out" 2>&1 || ok=
sed -n 's/^One-time password: //p' "$d/reset.out" > "$d/otp"; [ -s "$d/otp" ] || { echo "reset printed no one-time password"; ok=; }
grep -v '^One-time password:' "$d/reset.out"
grep -q '^Owner: ci-owner$' "$d/reset.out" || { echo "reset changed the chosen owner username"; ok=; }
$py -I -c 'import json,sys; print(json.dumps({"username":"ci-owner","password":open(sys.argv[1]).read().strip()}))' "$d/otp" > "$d/login.json"
$py -I -c 'import json,secrets,sys; n=secrets.token_urlsafe(24); open(sys.argv[2],"w").write(json.dumps({"current":open(sys.argv[1]).read().strip(),"next":n}))' "$d/otp" "$d/change.json"
# Ordinary owner sign-in and cookies work without Basic credentials.
expect "one-time sign-in" "$(code -c "$d/jar" -H 'Content-Type: application/json' --data-binary @"$d/login.json" "$api/api/owner/login")" 200
expect "one-time session, GET /api/status" "$(code -b "$d/jar" "$api/api/status")" 403
expect "password change" "$(code -b "$d/jar" -c "$d/jar" -H 'Content-Type: application/json' --data-binary @"$d/change.json" "$api/api/owner/password")" 200
expect "signed-in owner, GET /api/status" "$(code -b "$d/jar" "$api/api/status")" 200
# Only these legacy transport refusal checks explicitly send Basic credentials.
expect "console password + agent header" "$(code --netrc-file "$TMPDIR/netrc" -H 'x-reverie-parent-session: 0000002d-0035-4000-8000-000000000047' "$api/api/status")" 403
rm -rf "$d"; test "$ok" = 1
