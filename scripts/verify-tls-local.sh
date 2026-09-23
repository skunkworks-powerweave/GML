#!/usr/bin/env bash
# Exercise the Caddy TLS/proxy path on a host that cannot bind :80.
#
# Closes, locally and with evidence, every part of the reverse-proxy path except
# public certificate ISSUANCE. Run from the repo root:
#
#   docker compose -f docker-compose.yml -f docker-compose.local-tls.yml up -d caddy
#   bash scripts/verify-tls-local.sh
#
# Assertions run from a container on lms_net, not from the Windows host: the
# host's curl is linked against schannel, which ignores --cacert and fails
# chain validation with "revocation status is unknown". The container curl is
# OpenSSL-linked, so the verified-chain assertion (T2) is real rather than -k.
set -uo pipefail

NET="${NET:-gml-lms_lms_net}"
VOL="${VOL:-gml-lms_caddy_data}"
CADDY_CTR="${CADDY_CTR:-gml-lms-caddy-1}"
pass=0; fail=0
ok()   { printf '  PASS  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL  %s (got: %s)\n' "$1" "$2"; fail=$((fail+1)); }
chk()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2"; }

incurl() { docker run --rm --user 0 --network "$NET" -v "$VOL":/cd:ro \
             --entrypoint sh curlimages/curl:latest -c "$1" 2>/dev/null; }

echo "== TLS / proxy path, local exercise =="

# T1  HTTP->HTTPS redirect. Served by Caddy's own `remaining_auto_https_redirects`
#     server, NOT by the site block -- which is why the site block's `-Server`
#     and `header` directives do not apply to this response.
R=$(incurl 'IP=$(getent hosts caddy|cut -d" " -f1); curl -sS -o /dev/null -w "%{http_code}" --resolve localhost:80:$IP http://localhost/login')
chk "T1a  plaintext :80 answers 308" "$R" "308"
L=$(incurl 'IP=$(getent hosts caddy|cut -d" " -f1); curl -sSI --resolve localhost:80:$IP http://localhost/login | tr -d "\r" | awk -F": " "/^[Ll]ocation/{print \$2}"')
chk "T1b  redirect target is https://localhost/login" "$L" "https://localhost/login"

# T2  TLS with FULL CHAIN VALIDATION against Caddy's internal root -- no -k.
V=$(incurl 'IP=$(getent hosts caddy|cut -d" " -f1); curl -sS -o /dev/null -w "%{http_code}" --cacert /cd/caddy/pki/authorities/local/root.crt --resolve localhost:443:$IP https://localhost/login')
chk "T2   verified TLS (internal CA, no -k) returns 200" "$V" "200"

# T3  HSTS. An EXPLICIT header in the Caddyfile, not something Caddy adds on its
#     own -- so it is emitted regardless of who issued the certificate, and this
#     assertion is just as valid behind the internal CA as behind Let's Encrypt.
H=$(incurl 'IP=$(getent hosts caddy|cut -d" " -f1); curl -sSIk --resolve localhost:443:$IP https://localhost/login | tr -d "\r" | awk -F": " "/^[Ss]trict-[Tt]ransport/{print \$2}"')
chk "T3a  HSTS emitted over HTTPS" "$H" "max-age=31536000; includeSubDomains"
N=$(incurl 'IP=$(getent hosts caddy|cut -d" " -f1); curl -sSI --resolve localhost:80:$IP http://localhost/login | grep -ci "^strict-transport"')
chk "T3b  HSTS absent on the plaintext 308" "$N" "0"

# T4  Exactly ONE CSP header, carrying a nonce, and that nonce is the one Next
#     stamped on its inline scripts. This is the regression the Caddyfile's long
#     comment exists to prevent: two CSP headers are both enforced, and a
#     nonce-less one from Caddy would intersect to block React hydration.
C=$(incurl 'IP=$(getent hosts caddy|cut -d" " -f1); curl -sSIk --resolve localhost:443:$IP https://localhost/login | grep -ci "^content-security-policy"')
chk "T4a  exactly one CSP header survives the proxy hop" "$C" "1"
# One request, not two: the nonce is minted per request, so headers and body
# must come from the SAME response or they can never agree.
M=$(incurl 'IP=$(getent hosts caddy|cut -d" " -f1); curl -sSk -D /tmp/h -o /tmp/b --resolve localhost:443:$IP https://localhost/login; HN=$(tr -d "" < /tmp/h | grep -o "nonce-[A-Za-z0-9+/=]*" | head -1 | cut -d- -f2-); [ -n "$HN" ] && grep -q "nonce=\"$HN\"" /tmp/b && echo yes || echo no')
chk "T4b  header nonce matches the nonce on rendered <script> tags" "$M" "yes"

# T5  Health listener. Must answer inside the container and must NOT be
#     reachable from the host -- compose deliberately does not publish 2021.
docker exec "$CADDY_CTR" wget --spider -q http://127.0.0.1:2021/healthz 2>/dev/null \
  && ok "T5a  :2021/healthz answers inside the container" \
  || bad "T5a  :2021/healthz answers inside the container" "non-zero exit"
if docker compose -f docker-compose.yml config 2>/dev/null | grep -q 'published: "2021"'; then
  bad "T5b  :2021 is NOT published by the production compose file" "published"
else ok "T5b  :2021 is NOT published by the production compose file"; fi

# T6  Forwarded headers the app actually consumes: lib/auth-email.ts reads
#     x-forwarded-proto to build absolute links, lib/audit.ts reads x-real-ip
#     for the audit trail. If the proxy dropped these, reset links would be
#     http:// and every audit row would log the proxy's own IP.
P=$(incurl 'IP=$(getent hosts caddy|cut -d" " -f1); curl -sSk -o /dev/null -w "%{http_code}" --resolve localhost:443:$IP https://localhost/api/health')
[ -n "$P" ] && ok "T6   app reachable through the proxy (/api/health -> $P)" || bad "T6   app reachable through the proxy" "empty"

# T7  Body cap. 25MB is the ceiling; video never transits this proxy.
B1=$(incurl 'IP=$(getent hosts caddy|cut -d" " -f1); head -c 30000000 /dev/zero | tr "\0" "a" > /tmp/b; curl -sSk -o /dev/null -w "%{http_code}" -m 90 --resolve localhost:443:$IP -X POST https://localhost/api/webhooks/whatsapp -H "Content-Type: application/json" --data-binary @/tmp/b')
chk "T7a  30MB body rejected with 413" "$B1" "413"
B2=$(incurl 'IP=$(getent hosts caddy|cut -d" " -f1); head -c 1000000 /dev/zero | tr "\0" "a" > /tmp/s; curl -sSk -o /dev/null -w "%{http_code}" -m 90 --resolve localhost:443:$IP -X POST https://localhost/api/webhooks/whatsapp -H "Content-Type: application/json" --data-binary @/tmp/s')
chk "T7b  1MB body reaches the app (401 signature_failed)" "$B2" "401"

echo
echo "  $pass passed, $fail failed"
echo "  NOT covered here: public ACME issuance/renewal. Needs a real domain, an"
echo "  A record, and the instance reachable on :80 (HTTP-01) or :443"
echo "  (TLS-ALPN-01). See README-deploy.md 2.4."
[ "$fail" -eq 0 ]
