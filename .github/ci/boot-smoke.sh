# Runs INSIDE the boot container, in two phases around a restart:
#   docker exec -i boot bash -s -- before < boot-smoke.sh
#   docker restart boot (and wait for /api/status)
#   docker exec -i boot bash -s -- after  < boot-smoke.sh
# Checks follow the candidate-image smoke route matrix. Prints one line per check, statuses only.
# Secrets live in 0600 files under $TMPDIR/owner-ci; only the new owner password is kept across the restart.
set -u; umask 077; ok=1; phase=${1:-}
api=http://127.0.0.1:3000; d=$TMPDIR/owner-ci; mkdir -p "$d"
py=/opt/fleet/python/bin/python3
agent='x-codeman-parent-session: 0000002d-0035-4000-8000-000000000047'
reads='/api/status /api/settings /api/subscription-profiles /api/model-endpoints'
ws=/ws/sessions/00000000-0000-4000-8000-000000000001/terminal
# Every request carries the same Origin, never follows redirects, and is bounded in time.
# none: no credentials; basic: console password only; any other word: Basic plus that cookie jar.
code() {
  local who=$1; shift
  local a=(-sS -o "$d/body" -w '%{http_code}' --max-time 10 -H "Origin: $api")
  case "$who" in
    none) ;;
    basic) a+=(--netrc-file "$TMPDIR/netrc") ;;
    *) a+=(--netrc-file "$TMPDIR/netrc" -b "$d/$who.jar") ;;
  esac
  curl "${a[@]}" "$@" 2>/dev/null || true
}
expect() { echo "$1: got $2, want $3"; [ "$2" = "$3" ] || ok=; }
upgrade=(-H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13'
  -H 'Sec-WebSocket-Key: c21va2UtY2hlY2sta2V5MQ==')
json=(-H 'Content-Type: application/json')
# Body checks on the last response; prints nothing secret, only a verdict.
shape() { $py -I - "$d/body" "$@" <<'PY' || ok=
import json, sys
body, kind, *rest = sys.argv[1:]
try:
    v = json.load(open(body))
except Exception:
    print(f"  {kind}: response is not JSON"); sys.exit(1)
def fail(why): print(f"  {kind}: {why}"); sys.exit(1)
if kind == "settings":
    isinstance(v, dict) or fail("not an object")
elif kind == "profiles":
    (isinstance(v, dict) and v.get("success") is True and isinstance(v.get("data", {}).get("profiles"), list)) or fail("not success with data.profiles")
    labels = [p.get("label") for p in v["data"]["profiles"]]
    for want in rest:
        has, label = want[0] == "+", want[1:]
        (label in labels) == has or fail(f"label {label!r} {'missing' if has else 'present'}")
elif kind == "endpoints":
    isinstance(v, list) or fail("not a list")
    ids = [h.get("id") for h in v]
    for want in rest:
        has, hid = want[0] == "+", want[1:]
        (hid in ids) == has or fail(f"endpoint {hid!r} {'missing' if has else 'present'}")
    any("apiKey" in h for h in v) and fail("an apiKey is returned")
elif kind == "created-profile":
    (v.get("success") is True and v.get("data", {}).get("profile", {}).get("id")) or fail("no success with a profile id")
    open(rest[0], "w").write(v["data"]["profile"]["id"])
elif kind == "created-endpoint":
    (v.get("success") is True and v.get("data", {}).get("host", {}).get("id") == rest[0]) or fail("no success with that host id")
elif kind == "success":
    v.get("success") is True or fail("success is not true")
PY
}
denied() {  # denied LABEL WANT_NONE WANT_BASIC [extra jars as name=want] -- curl args
  local label=$1 n=$2 b=$3; shift 3
  expect "$label, no credentials" "$(code none "$@")" "$n"
  expect "$label, console password only" "$(code basic "$@")" "$b"
  expect "$label, console password + agent header" "$(code basic -H "$agent" "$@")" 403
}
anonymous_checks() {
  for r in $reads; do denied "GET $r" 401 401 "$api$r"; done
  expect "GET /api/smoke-does-not-exist, console password only" "$(code basic "$api/api/smoke-does-not-exist")" 401
  denied "WebSocket upgrade" 401 401 "${upgrade[@]}" "$api$ws"
  denied "POST /api/subscription-profiles" 401 401 "${json[@]}" --data-binary '{"label":"Smoke denied","provider":"openai"}' "$api/api/subscription-profiles"
  denied "POST /api/model-endpoints" 401 401 "${json[@]}" --data-binary '{"id":"smoke-denied","label":"Smoke denied","baseUrl":"http://example.invalid/v1"}' "$api/api/model-endpoints"
}
owner_reads() {  # owner_reads PROFILE_WANT ENDPOINT_WANT (+name present, -name absent)
  expect "GET /api/status, owner" "$(code owner "$api/api/status")" 200
  expect "GET /api/settings, owner" "$(code owner "$api/api/settings")" 200; shape settings
  expect "GET /api/subscription-profiles, owner" "$(code owner "$api/api/subscription-profiles")" 200; shape profiles "$1" '-Smoke denied'
  expect "GET /api/model-endpoints, owner" "$(code owner "$api/api/model-endpoints")" 200; shape endpoints "$2" -smoke-denied
}
login() {  # login JAR PASSWORD_FILE
  $py -I -c 'import json,sys; print(json.dumps({"username":"owner","password":open(sys.argv[1]).read().strip()}))' "$2" > "$d/login.json"
  code basic -c "$d/$1.jar" "${json[@]}" --data-binary @"$d/login.json" "$api/api/owner/login"
  rm -f "$d/login.json"
}

case "$phase" in
before)
  trap 'find "$d" -mindepth 1 ! -name pw -delete' EXIT
  # 1. Refusals on a fresh container, before any owner account exists.
  anonymous_checks
  # 2. Create the owner account (setup.sh --owner). The one-time password goes to a 0600 file only.
  REVERIE_DATA_DIR=/instances/default/console reverie owner bootstrap --username owner --enforce > "$d/boot.out" 2>&1 || ok=
  sed -n 's/^One-time password: //p' "$d/boot.out" > "$d/otp"; [ -s "$d/otp" ] || { echo "bootstrap printed no one-time password"; ok=; }
  grep -v '^One-time password:' "$d/boot.out"
  anonymous_checks
  # 3. The one-time session is restricted until the password changes: every private read, write and upgrade is 403.
  expect "one-time sign-in" "$(login restricted "$d/otp")" 200
  for r in $reads; do expect "GET $r, one-time session" "$(code restricted "$api$r")" 403; done
  expect "WebSocket upgrade, one-time session" "$(code restricted "${upgrade[@]}" "$api$ws")" 403
  expect "POST /api/subscription-profiles, one-time session" "$(code restricted "${json[@]}" --data-binary '{"label":"Smoke denied","provider":"openai"}' "$api/api/subscription-profiles")" 403
  expect "POST /api/model-endpoints, one-time session" "$(code restricted "${json[@]}" --data-binary '{"id":"smoke-denied","label":"Smoke denied","baseUrl":"http://example.invalid/v1"}' "$api/api/model-endpoints")" 403
  # 4. Change the password; the reply sets the full owner session. Keep only the new password, for after the restart.
  $py -I -c 'import json,secrets,sys; n=secrets.token_urlsafe(24); open(sys.argv[2],"w").write(n); open(sys.argv[3],"w").write(json.dumps({"current":open(sys.argv[1]).read().strip(),"next":n}))' "$d/otp" "$d/pw" "$d/change.json"
  cp "$d/restricted.jar" "$d/owner.jar"
  expect "password change" "$(code owner -c "$d/owner.jar" "${json[@]}" --data-binary @"$d/change.json" "$api/api/owner/password")" 200
  rm -f "$d/change.json" "$d/otp"
  # 5. The full owner session reaches private reads; an agent header still wins over it.
  owner_reads '-Smoke account' -smoke-endpoint
  for r in $reads; do expect "GET $r, owner + agent header" "$(code owner -H "$agent" "$api$r")" 403; done
  expect "WebSocket upgrade, owner + agent header" "$(code owner -H "$agent" "${upgrade[@]}" "$api$ws")" 403
  expect "POST /api/subscription-profiles, owner + agent header" "$(code owner -H "$agent" "${json[@]}" --data-binary '{"label":"Smoke denied","provider":"openai"}' "$api/api/subscription-profiles")" 403
  expect "POST /api/model-endpoints, owner + agent header" "$(code owner -H "$agent" "${json[@]}" --data-binary '{"id":"smoke-denied","label":"Smoke denied","baseUrl":"http://example.invalid/v1"}' "$api/api/model-endpoints")" 403
  # 6. Synthetic configuration writes as the owner; no provider sign-in, discovery or model call.
  expect "POST /api/subscription-profiles, owner" "$(code owner "${json[@]}" --data-binary '{"label":"Smoke account","provider":"openai"}' "$api/api/subscription-profiles")" 200
  shape created-profile "$d/profile-id"; [ -s "$d/profile-id" ] && mv "$d/profile-id" "$TMPDIR/owner-ci-profile-id"
  expect "POST /api/model-endpoints, owner" "$(code owner "${json[@]}" --data-binary '{"id":"smoke-endpoint","label":"Smoke endpoint","baseUrl":"http://example.invalid/v1"}' "$api/api/model-endpoints")" 200
  shape created-endpoint smoke-endpoint
  # The denied attempts above created nothing; the owner's own items are there.
  owner_reads '+Smoke account' +smoke-endpoint
  ;;
after)
  trap 'rm -rf "$d" "$TMPDIR/owner-ci-profile-id"' EXIT
  # 7. Enforcement survives the restart.
  expect "owner-auth.policy after restart" "$(cat /instances/default/console/owner-auth.policy 2>/dev/null)" enforce
  anonymous_checks
  # 8. The owner signs in again with the password set before the restart; the synthetic items persisted.
  [ -s "$d/pw" ] || { echo "no owner password kept from before the restart"; ok=; }
  expect "owner sign-in after restart" "$(login owner "$d/pw")" 200
  owner_reads '+Smoke account' +smoke-endpoint
  # 9. Clean up only the synthetic items, by the returned profile id.
  id=$(cat "$TMPDIR/owner-ci-profile-id" 2>/dev/null)
  if [ -n "$id" ]; then
    expect "DELETE the synthetic profile, owner" "$(code owner -X DELETE "$api/api/subscription-profiles/$id")" 200; shape success
  else echo "no synthetic profile id kept from before the restart"; ok=; fi
  expect "DELETE /api/model-endpoints/smoke-endpoint, owner" "$(code owner -X DELETE "$api/api/model-endpoints/smoke-endpoint")" 200; shape success
  owner_reads '-Smoke account' -smoke-endpoint
  ;;
*) echo "usage: bash -s -- before|after < boot-smoke.sh"; ok= ;;
esac
test "${ok:-}" = 1
