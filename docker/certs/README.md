# Your own TLS certificate (optional)

By default Caddy gets a free certificate from Let's Encrypt for `DOMAIN` and
renews it by itself. If your organisation already holds a certificate for the
name (purchased, wildcard, or from an internal CA), or Let's Encrypt cannot
reach this server, Caddy can serve that one instead.

1. Put two PEM files in this folder: `fullchain.pem` (the certificate, then its
   chain) and `privkey.pem` (the private key, **unencrypted**), and
   `chmod 600 privkey.pem`. Git ignores this folder's contents and image builds
   exclude it, so the key is never committed or baked into an image.
2. Copy `tls.caddy.example` to `tls.caddy` (the name must end in `.caddy`).
   Change the two paths only if you named the files differently; they are
   written as the container sees them: `/etc/caddy/certs/<file>`.
3. Check it: `bash scripts/preflight.sh` (readable, covers `DOMAIN`, not
   expired, key matches the certificate). `./scripts/deploy.sh` also has Caddy
   validate the pair before it builds or restarts anything.

While `tls.caddy` is here Caddy does **not** contact Let's Encrypt for
`DOMAIN`, and `ACME_EMAIL` is not used for it (it must still be set). Port 80
still redirects to HTTPS, so keep it open.

## Renewal is then yours

Replace both files, then:

```
docker compose exec caddy caddy reload --force --config /etc/caddy/Caddyfile
```

`--force` because the Caddyfile itself has not changed, and a plain `reload`
then does nothing. There is no downtime. `bash scripts/preflight.sh` warns when
the certificate has fewer than 14 days left.

## Going back to Let's Encrypt

Delete `tls.caddy` and run `./scripts/deploy.sh`.
