# Contributing

Thanks for taking a look. This plugin is small on purpose; the notes below are
what you need to change it without re-learning it the hard way.

## Requirements

- Node.js `>=22.19` or `>=24` (the plugin and its tests use the Node 22 API
  surface; DSH itself runs on a modern Node).
- A DeepSeek Harness checkout that is running the **web** profile, if you want to
  try the plugin live. Testing does **not** require DSH (see below).

## Layout

| Path | What it is |
| --- | --- |
| `lib/index.js` | Host half: HTTP routes, engine lifecycle, model download, per-hold audio buffers, settings namespace |
| `lib/asr-worker.mjs` | Decoding inside a `worker_threads` worker (native sherpa-onnx first, WASM fallback) |
| `lib/model-cache.js` | Model download/cache (mirror, resume, progress) |
| `lib/client.js` | Browser half: long-press gesture, AudioWorklet capture, overlay, draft insertion |
| `tools/` | Offline test harnesses and dev scripts — never shipped to npm |
| `cordis.patch.yml` | The bundle patch row plus every default config value |

## Test without DSH

```sh
npm run check            # syntax check, all four runtime modules
npm test                 # check + the three offline suites
```

- `tools/client-smoke.mjs` loads `lib/client.js` in a `vm` sandbox and asserts the
  client registration contract (module id, only `react` required, exports, slot
  id/order, single style injection).
- `tools/host-test.mjs` starts the host half behind a real HTTP server with a stub
  Cordis context and hits the real routes.
- `tools/client-test.mjs` drives the **real** interaction logic in Node with
  `AudioContext` / `AudioWorkletNode` / `getUserMedia` / `fetch` stubbed, against
  the real host routes.

`host-test` and `client-test` need the ASR model, so on a fresh clone they either
skip or run a reduced set:

```sh
npm run model:fetch      # download the 228MB SenseVoice int8 model
npm test                 # now everything runs
```

CI runs `npm test` as well — without a model it exercises the model-free subset
and skips the rest, so a green run on a clean machine is expected.

## Test against a running DSH

```sh
dsh plugin --profile web add /path/to/dsh-hold-to-talk
# restart dsh web, then hard-refresh the browser page (Ctrl+Shift+R)
```

The host half is loaded at boot; the client half is scanned at boot and cached,
so **editing `lib/client.js` needs a page refresh** — a fresh module token makes
the previous module's document listeners inert, so no restart is required.
Editing anything under `lib/index.js` or `lib/asr-worker.mjs` does need a DSH
restart.

> On Windows, run the `dsh` CLI with the Node that DSH itself runs on. The CLI
> entry self-executes through `import.meta.main` (Node 22.18+/24); on an older
> Node it exits 0 and silently does nothing, which makes an install look like it
> succeeded when nothing changed.

## Conventions

- Keep `lib/client.js` a classic script: no build step, no JSX — use
  `React.createElement` and `window.__ModuleLoader__.load`.
- Prefer explicit failure over silent fallback. If a capability is unavailable
  (no model, no microphone permission, no `@deepseek-ai/schemastery`), degrade
  loudly in the overlay or the host log rather than doing nothing.
- Any fix to the gesture or timing logic deserves a regression case in
  `tools/client-test.mjs` — that suite exists precisely because browser-side
  regressions are expensive to find by hand (a restart used to be the only way).
- Chinese comments are welcome and used throughout; keep user-facing strings in
  the same plain tone as the surrounding code.

## Pull requests

One logical change per commit, a real message, and `npm test` green. If the
change touches user-visible behaviour, add a `CHANGELOG.md` entry under
`## [Unreleased]`.

## License

MIT — by contributing you agree your work is released under the same license.
