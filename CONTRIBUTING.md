# Contributing

`nozzlecast-relay` is a small self-hosted service built for one specific setup — a self-hosted
[Bambuddy](https://github.com/karliky/bambuddy) instance, an ntfy server, and the
[NozzleCast](https://github.com/hibikipr/NozzleCast) iOS app. It's shared publicly in case it's
useful to others running the same stack, not as a general-purpose framework, so PRs that add
config surface for setups this project doesn't target are likely to be declined in favor of
keeping it simple — but bug fixes, docs improvements, and features that fit the existing scope
are welcome.

## Before you start

Read [ARCHITECTURE.md](ARCHITECTURE.md) first — it's the current-state design reference (modules,
data flow, payload shapes, trigger sources, known limitations). The `docs/superpowers/` specs are
point-in-time investigation history kept for context, not the source of truth for current
behavior.

## Setup

```bash
npm install
npm test
```

No live Bambuddy/ntfy/APNs credentials are required to run the test suite — it's fully unit-tested
against fakes/fixtures (see `test/`). To run the relay against a real deployment, see the
[README](README.md#running-locally) and [README's deploying section](README.md#deploying).

## Making a change

- Add or update tests under `test/` for any behavior change — `npm test` should stay green
  (`node --test test/*.test.js`, no separate build step).
- Keep changes scoped: this codebase deliberately avoids abstractions and config knobs it doesn't
  need yet. A bug fix doesn't need a refactor alongside it.
- If a change affects the module layout, data flow, payload shapes, or a trigger's behavior,
  update [ARCHITECTURE.md](ARCHITECTURE.md) in the same PR — it's meant to stay accurate, not
  drift from the code.
- Never commit real credentials, `.p8` keys, hostnames, or tokens — `docker-compose.example.yml`
  and `.env.example` should only ever contain placeholders.

## Reporting bugs

Open an issue with what you observed, what you expected, and (if you have it) relevant relay log
output — `docker compose logs nozzlecast-relay` or `journalctl -t nozzlecast-relay` depending on
how it's deployed. Since this relies on live APNs/Bambuddy state, exact timestamps and the
relevant `gcode_state` transition are more useful than a description alone.
