# Quickstart 003 — Ping

```powershell
cd C:\Users\himan\OneDrive\Desktop\GML\lms-app
pnpm install                                  # picks up @gml/shared workspace dep
pnpm test                                     # 23/23 governance tests green
pnpm --filter @gml/web dev                    # starts Next.js on :3000
# in another shell:
curl http://localhost:3000/api/ping
# → {"pong":true,"ts":"2026-05-20T...","spec":"003"}
```
