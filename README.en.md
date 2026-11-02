# DSH Work Window (plugin for DeepSeek Harness)

English | [中文](README.md)

A DeepSeek Harness (DSH) desktop plugin that makes agents **start model requests only inside allowed working windows**. During a paused window the agent stops before any model request (no tokens are consumed), and a task submitted at that time asks the user for explicit confirmation first. Chinese public-holiday data comes from [timor.tech](https://timor.tech/api/holiday) and is cached locally. A **Work Window** entry and status panel live in the left sidebar.

> Status: runs in a DSH `desktop` profile via HMR hot reload (tested on Windows with DSH `0.2.1-rc.5`, no application restart). See [docs/VERIFICATION.md](docs/VERIFICATION.md) for the installation/verification record.

**Path placeholders** used below: `<workspace>` repository root · `<plugin-dir>`=`<workspace>/plugins/work-window` · `<DSH-install-dir>` DSH installation directory · `$DSH_HOME` DSH home (in PowerShell: `$env:DSH_HOME`, usually `%USERPROFILE%\.dsh`).

## Rules

| Day type | Agent state |
|---|---|
| Working day (Mon–Fri, excluding public holidays, including adjusted workdays) | **Paused 09:00–12:00 and 14:00–18:00**; allowed 12:00–14:00 and 18:00–09:00 |
| Weekend / public holiday | Allowed all day |

Pause semantics (enforced by the Host at `agent/pre-step`):

1. **No model request starts during a paused window** → no tokens are consumed;
2. A user task (sent from the composer) triggers the native DSH approval prompt (allow once / reject). Allow runs it once; reject, confirmation timeout, or no live web client puts it **back in the queue** and it resumes automatically when the window ends;
3. Automatic sources such as scheduled reminders queue silently (no popup);
4. Goal rounds are **parked in place** (not rejected, so a goal is never permanently blocked) and resume when the window ends;
5. A turn that started before the pause is allowed to finish (only new work is gated).

## Features

- **Zero-token pause**: gating at `agent/pre-step`; a rejected step never reaches the model.
- **Remind + confirm**: reuses the `ctx.approval` web approval panel with pause-window and resume-time copy; the confirmation wait has a configurable timeout (10 minutes by default).
- **Queue + timed wake-up**: held messages go back to the agent inbox and are woken at `nextChangeAt`.
- **Holidays**: the Host fetches timor.tech yearly data and caches it on disk (12 h TTL, 6 h checks, next-year prefetch in Nov–Dec) with a weekend fallback; the Client keeps a localStorage cache, a built-in offline snapshot and a manual **Sync holiday data** button.
- **Sidebar entry**: an icon entry in `sidebar.panellist`; the `main` panel shows a status badge, local time, next change countdown, paused windows, today's holiday and cache provenance.
- **Composer notice**: a `conversation.composer.dock` banner while a window is paused.
- **System prompt policy**: injects the working-window rules into every agent so it avoids starting long work near a boundary.
- **Configurable**: time zone, paused windows, holiday API, cache TTL, confirmation timeout, cache directory.

## Repository layout

```text
.
├── plugins/work-window/          installable plugin bundle
│   ├── index.js                  Host half: gate / approval / queue+wake / prompt / holiday cache
│   ├── client.template.js        Client half source (sidebar entry + panel + notice)
│   ├── client.js                 ⚠️ generated artifact (build with tools/build-client.mjs)
│   ├── shared/holiday.js         reference implementation of holiday + window logic (host)
│   ├── shared/holiday-cache.js   host-side cache (atomic writes / single-flight refresh / TTL)
│   ├── shared/status-client.mjs  compact browser implementation (parity-tested against holiday.js)
│   ├── shared/offline-holidays.json  built-in offline snapshot (2025/2026)
│   ├── cordis.patch.yml          bundle patch (inserts the work-window row and default config)
│   ├── locale/{zh,en}.json       display metadata for the plugin manager
│   ├── icon.svg                  original icon
│   └── tools/                    build and test scripts
├── shared/                       standalone reference implementation and tests
├── docs/                         research / install / verification documents
├── prototype/                    minimal runnable Client-half skeleton (research artifact)
├── tools/                        check.mjs (build + all tests) and extract-asar.mjs
├── BRIEF.md                      initial project brief (historical record)
├── README.en.md                  this file
└── LICENSE                       MIT
```

## Quick start

**Requirements**: DSH desktop (`desktop` profile; tested with `0.2.1-rc.5`). Node.js 24+ is only needed for development/testing.

### Install

GUI (recommended; writes the profile and hot reloads): **Plugins** in the DSH sidebar → **Add plugin** → enter the absolute `<plugin-dir>` path → **Install** → **Enable now**.

CLI (fully quit the desktop app first):

```powershell
& "<DSH-install-dir>\resources\runtime\cli\bin\dsh.cmd" plugin --profile <profile> add "<plugin-dir>"
```

Manual replication of the installer's file result (Junction + atomic profile `package.json` write) is documented in [docs/install-plan.md](docs/install-plan.md).

### Verify after install

1. A **Work Window** entry appears in the sidebar (clock + pause icon, `order: 20`);
2. On working days 09:00–12:00 / 14:00–18:00 the panel shows **Paused** and the composer notice appears;
3. Runtime evidence: the plugin graph from `GET http://127.0.0.1:<GUI port>/plugins/events` contains `@local/dsh-work-window`;
4. Holiday cache file: `$DSH_HOME\cache\work-window\holidays-<year>.json`.

If the sidebar entry is missing, press **F5** (browser refresh only, no Host restart).

### Uninstall / rollback

- Disable: remove `@local/dsh-work-window` from `dsh.profile.bundles` in the profile `package.json` (HMR recomposes in 2–4 s);
- Full uninstall: also remove `dependencies["@local/dsh-work-window"]` and the `node_modules/@local/dsh-work-window` link; the `$DSH_HOME/cache/work-window` cache directory is optional to delete;
- The plugin is junction-linked to this repository, so **moving or deleting the directory breaks the plugin**.

## Configuration

Edit the profile `cordis.patch.yml` (or the bundle's own `plugins/work-window/cordis.patch.yml`):

```yaml
- id: work-window
  name: '@local/dsh-work-window'
  config:
    timeZone: Asia/Hong_Kong
    pauseWindows:
      - { start: '09:00', end: '12:00' }
      - { start: '14:00', end: '18:00' }
    holidayApiUrl: 'https://timor.tech/api/holiday/year/{year}'
    cacheTtlHours: 12
    confirmDuringPause: true
    confirmTimeoutMs: 600000        # max wait for the pause-window confirmation
    # cacheDir: 'D:\somewhere\work-window'   # optional; default $DSH_HOME/cache/work-window
    wakeNotice: '（工作时段已开始，暂停结束：继续执行队列中暂停的任务。）'
    policyText: null                # optional: override the injected policy text
```

`pauseWindows` also accepts `'09:00-12:00'` strings. The config is validated by the Standard Schema exported from `index.js`; invalid config fails at load time.

## Holiday data

- API: `GET https://timor.tech/api/holiday/year/<year>` → `{ code: 0, holiday: { 'MM-DD': { holiday, name, wage, date, … } } }`.
- `holiday: true` = public holiday (day off); `holiday: false` = adjusted workday (counts as a working day); ordinary weekends are computed locally.
- Host cache: `$DSH_HOME/cache/work-window/holidays-<year>.json` (atomic writes, 12 h TTL, checked every 6 h, next year prefetched in Nov–Dec).
- Client cache: `localStorage['dsh-work-window:holidays:<year>']`; the built-in `shared/offline-holidays.json` snapshot is the fallback.
- timor.tech is rate limited (HTTP 429 on rapid requests); the Host refreshes serially and relies on the cache.

## Development and tests

```powershell
cd <workspace>
node tools/check.mjs                      # build client.js + syntax checks + all tests

# or individually
node plugins/work-window/tools/build-client.mjs   # generate client.js from template + status-client + offline data
node shared/holiday.test.mjs                      # holiday/window reference implementation (103 assertions)
node plugins/work-window/tools/parity.test.mjs    # browser vs host status parity (953 assertions)
node plugins/work-window/tools/host.test.mjs      # host gate unit tests (34 assertions)
node plugins/work-window/tools/client.test.mjs    # client.js load/register/render in a VM (18 assertions)
node plugins/work-window/tools/make-offline.mjs   # regenerate the offline snapshot (needs network)
```

Conventions:

- Change browser logic in `plugins/work-window/client.template.js` and/or `shared/status-client.mjs`, then run `node tools/build-client.mjs` (the build is deterministic, so the artifact can be committed);
- The client artifact must not `import` any Harness client package; it only `require('react')`;
- Host-half dependencies: `inject` must include both `systemPrompt` and `timer` (`ctx.interval`/`ctx.timeout` are timer-service mixin accessors; omitting `timer` makes `apply()` throw and the plugin silently ineffective). Optional services are read with `ctx.get()`; `host.test.mjs` covers the declaration;
- Do not commit `.scratch/` (asar extraction, reproducible via `node tools/extract-asar.mjs`).

## Known limitations

- A turn that started before the pause is allowed to finish, so work crossing the boundary keeps consuming tokens until that turn ends.
- Child agents (subagent/teammate) are gated too; a parent waiting for a child result is paused along with it.
- Parking a goal round occupies that agent until the window ends; other tasks in the session queue behind it (the trade-off for never blocking goals).
- Without a live web client no confirmation prompt is shown; the task is queued instead (avoids a permanently pending approval).
- GUI interaction is not automatically simulated: injecting a user message during a pause and clicking the approval dialog, plus panel theming, need manual verification. See [docs/VERIFICATION.md](docs/VERIFICATION.md).
- Pausing relies on the public `agent/pre-step` extension point; re-verify against [docs/host-api.md](docs/host-api.md) after DSH upgrades.

## Documentation

- [Plugin usage notes (Chinese)](plugins/work-window/README.md)
- [Installation & verification record](docs/VERIFICATION.md)
- [Install & hot-reload plan](docs/install-plan.md)
- [Host-side API research](docs/host-api.md)
- [Client-side API research](docs/client-api.md)
- [Initial project brief](BRIEF.md)

## License

[MIT](LICENSE) © dsh-work-window contributors
