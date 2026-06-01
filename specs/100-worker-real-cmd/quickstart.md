# Quickstart 100

1. `docker compose build worker && docker compose up -d worker` — the worker container starts and stays running.
2. `docker compose logs worker --tail=20` — expect bullmq Worker startup output and NO occurrence of the string `worker idle`.
3. Enqueue a transcode job (upload a clip via `/api/videos/upload` or `redis-cli LPUSH bull:transcode:wait '<json>'`) and watch `docker compose logs worker -f` show the job being dequeued and ffmpeg running.
