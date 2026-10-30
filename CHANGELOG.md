# Changelog

## 0.1.0-beta.3 — first public beta (unreleased)

The first release with a downloadable Windows installer. It is **unsigned**; each release publishes SHA-256 checksums. See [Windows signing](docs/WINDOWS_SIGNING.md).

### Added

- Clawrk, an original pixel crab with 26 standard animations and a custom animation.
- Studio pet management, animation previews, behavior/sound controls and pet-creation prompts.
- Local agent status bubbles, session lists, configurable buttons and global hotkeys.
- Claude Code hook setup/removal, plus setup prompts and a shared bridge for other agents.
- Optional text avoidance and Caps Lock movement commands, enabled only with permission.
- Windows x64 installer packaging with a bundled Node.js runtime.
- Sandbox restrictions, security smoke tests and local diagnostic logging.
- Documentation, README screenshots/GIF and issue-report templates.
- "Only show with its agent": a pet appears while its agent has a window open, is working (background shells, agents and monitors a Claude Code turn left running count too) or needs you, and leaves after a set time once that window is minimized or hidden and the agent is quiet.
- A green check mark on the pet for a finished turn you haven't looked at. It clears when you open the session from the pet or switch to the agent's window.
- Shaking the cage frees the pets inside it; shaking one pet frees just that pet.
- General settings to mute every pet or stop group dances, and a watchdog that restarts a pet window that stops drawing.
- Smoke-poof sound plays whenever a pet re-appears in a puff of smoke, and a pet is refreshed right before it re-appears.
- When a hook event goes missing, the pet reads the agent's own transcript to see whether the turn finished, was interrupted (Esc or a declined tool), or stopped on an API error such as a usage limit. This covers Claude Code, Codex and Antigravity, and only reads the records that say how a turn ended, never what the agent read or wrote. Each transcript is parsed again only when it changes.
- Turn-ending errors reported by hooks (such as Claude Code's `StopFailure`) show as "Usage limit reached" or "Turn error"; a failed tool call doesn't end the turn.
- The release workflow checks that the tag, package version and installer name match, and marks only versions like `0.1.0-beta.3` as pre-releases.

### Changed

- Pets without their own "needs you" or "done" animation no longer play the same stand-in for both: "needs you" is an urgent double hop, "done" hops briefly and then settles.
- Studio > Behavior is grouped (On screen and buttons on top, then Coming and going, Agent and look, Moving around, Personality). Options that depend on another setting are greyed out until it is on. The right-click Behavior menu uses the same groups.
- A single left click on a pet keeps the current app focused. Bubble clicks and explicit jump actions still open the tracked session; double-click reactions and Ctrl-double-click refresh remain available.
- A pet keeps calling you while an agent waits for your permission, for up to an hour, even if nothing else happens meanwhile.
- The NSIS uninstall macro attempts to remove only the uninstalling copy's Claude Code hooks before file removal and skips upgrades.
- Legacy `builtin:clawd` / `clawd.pet.js` references migrate to Clawrk.
- The README leads with installing from Releases (checksum and SmartScreen steps), and gains Troubleshooting and updated Known limitations sections.

### Fixed

- Clawrk no longer leaves while the Claude Desktop window is open. Windows withholds the path of Claude Desktop's window process from the query the helper used, so the "WindowsApps" matcher never found the window. The helper now reads process paths with limited query rights, which also fixes focusing the app and spotting it in front.
- A window check that fails (the helper restarting) no longer sends pets away.
- **Show all pets** no longer brings back pets that only show with their agent while that agent's window is minimized. They return as soon as the window is open or the agent gets busy.
- **Put on screen** and **Show** in Studio refresh the pet as it comes back.
- The tray icon carries sizes for every common display scale and is set again after startup, display changes and unlock, so it can't stay blank after Windows sign-in.
- Studio opens with both its sidebar and its page scrolled to the top.
- The cage works in an installed copy. Its drawing now ships with the app (`pet-window/cage.pet.js`) instead of the pets folder, which an installed copy keeps in `%USERPROFILE%\.harness-pet\pets` and never copied the cage into, so turning the cage on showed a second Clawrk. Clawrk is the only pet in `pets/`.
- **Quit** always closes the app. Before, the watchdog could re-open the pets it was closing, and Electron then ignored every later Quit until the process was ended; now nothing opens a window once Quit starts, and the app exits after 5 seconds if a window still won't close.
- A settings save that Windows briefly refuses (`EPERM` while antivirus, search indexing or a sync client has the file open) is retried instead of failing. If it still fails, the app tries again a few seconds later and shows an error only if that fails too. The Studio warning now names the file and the error, clears after the next successful save, and a valid settings file is no longer copied to `prefs.json.recovery-*`.

### Still open before 1.0

- An install, Connect, live Claude Code session and uninstall on a second Windows PC; Windows 10 stays listed as untested until it has been tried.
- Each Claude Code tool call waits about 0.8 seconds for two hooks. Running those two hooks in the background (Claude Code's `async` hook option) would remove that wait; it needs a live test first.
- Code signing. Releases are unsigned with SHA-256 checksums until then.
