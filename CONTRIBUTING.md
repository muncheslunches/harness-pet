# Contributing to Harness Pet

Bug reports, fixes, docs and original pets are welcome. This repository is development source preparing for `0.1.0-beta.1`; no installer has been released yet. Known open items are listed in [CHANGELOG.md](CHANGELOG.md).

## Ways to help

- **Report a bug:** open an issue with the *Bug report* form. See [Reporting bugs and diagnostics](#reporting-bugs-and-diagnostics). Report security problems privately as described in [SECURITY.md](SECURITY.md).
- **Pick an issue:** ones labelled `good first issue` are small and well defined. Comment on it first so two people don't do the same work.
- **Make a pet:** see [docs/PET_FORMAT.md](docs/PET_FORMAT.md), or use **Studio → Create a pet** to generate a prompt for your coding agent.

## Running it from source

Use **Windows 10/11 x64** with [Node.js](https://nodejs.org) 22 and npm (22 is what the prepared CI workflow uses). In this project folder:

```bash
npm ci
npm start
```

Before sending changes:

```bash
npm test
npm run validate -- pets/clawrk.pet.js
```

For sandbox changes, also run `npm run test:security:electron`, which launches real Electron renderers. Build an installer with `npm run dist:win`; it requires `LICENSE` beside the build-time Node executable and writes to `dist/` without publishing.

## Reporting bugs and diagnostics

Include the app version (or source commit and whether it has local changes), Windows version, display scaling/monitor layout, agent and agent version, reproduction steps, expected behavior and actual behavior. Include relevant lines from `%USERPROFILE%\.harness-pet\app.log`.

For dropped clicks, freezes or mouse lag, quit the app, enable diagnostics in PowerShell and launch it from the project folder:

```powershell
$env:HARNESS_PET_DIAG = '1'
npm start
```

For an installed copy, launch its actual executable from that same PowerShell session instead of `npm start`; replace the example path with your installation path:

```powershell
& 'C:\path\to\Harness Pet.exe'
```

Reproduce the issue and quit, then collect `%USERPROFILE%\.harness-pet\diag.log`. Clear the variable before the next launch:

```powershell
Remove-Item Env:HARNESS_PET_DIAG
```

This affects newly launched processes; it does not enable diagnostics in an already-running app. Redact usernames, paths, project/session names, prompt snippets and other private details before sharing logs or screenshots. Do not attach whole session folders, agent transcripts, Claude settings or credentials. Follow [SECURITY.md](SECURITY.md) for suspected sandbox escapes.

## Sending a pull request

1. Fork the repository and create a branch (`git checkout -b fix-bubble-offscreen`).
2. Keep each pull request about one thing. Small PRs get reviewed and merged much faster.
3. Match the style of the surrounding code: plain JavaScript, no build step, short comments that explain *why*.
4. Add or update a test in `test/` when you change behavior.
5. Fill in the pull request template: what changed, how you tested it, and a screenshot or GIF for anything visible.

GitHub Actions CI runs the tests on pull requests and pushes.

## Ground rules for code

Harness Pet runs on people's desktops, watches the keyboard (when switched on) and edits Claude Code's settings, so changes there get a careful review:

- **No network access and no telemetry.** The app blocks web requests on purpose.
- Pet code stays sandboxed. Don't give pets new powers in `runtime/` without discussing it in an issue first.
- New npm dependencies need a good reason. Fewer dependencies mean less to trust.
- Anything that touches `native/`, `hook/` or `lib/claude-hooks.js` should explain exactly what it does and why.

## Pets in this repository

Only **original characters** can be added to the built-in collection. Pets based on characters from games, films, shows or brands (even as fan art) can't be included: one takedown notice could take the whole project offline. You're welcome to make those for your own use, and to share original pets in Discussions.

## Be kind

Everyone here is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
