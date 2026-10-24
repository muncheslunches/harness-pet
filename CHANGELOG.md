# Changelog

## Unreleased — `0.1.0-beta.2` in development

The source is public for development and review. No installer has been released yet.

### Added

- Clawrk, an original pixel crab with 26 standard animations and a custom animation.
- Studio pet management, animation previews, behavior/sound controls and pet-creation prompts.
- Local agent status bubbles, session lists, configurable buttons and global hotkeys.
- Claude Code hook setup/removal, plus setup prompts and a shared bridge for other agents.
- Optional text avoidance and Caps Lock movement commands, enabled only with permission.
- Windows x64 installer packaging with a bundled Node.js runtime.
- Sandbox restrictions, security smoke tests and local diagnostic logging.
- Documentation, README screenshots/GIF and issue-report templates.
- "Only show with its agent": a pet appears while its agent has a window open, is working or needs you, and leaves after a set time once that window is minimized or hidden and the agent is quiet.
- A green check mark on the pet for a finished turn you haven't looked at. It clears when you open the session from the pet or switch to the agent's window.
- Shaking the cage frees the pets inside it; shaking one pet frees just that pet.
- General settings to mute every pet or stop group dances, and a watchdog that restarts a pet window that stops drawing.

### Changed

- Pets without their own "needs you" or "done" animation no longer play the same stand-in for both: "needs you" is an urgent double hop, "done" hops briefly and then settles.
- Studio > Behavior is grouped (On screen and buttons on top, then Coming and going, Agent and look, Moving around, Personality). Options that depend on another setting are greyed out until it is on. The right-click Behavior menu uses the same groups.

- A single left click on a pet keeps the current app focused. Bubble clicks and explicit jump actions still open the tracked session; double-click reactions and Ctrl-double-click refresh remain available.
- The NSIS uninstall macro attempts to remove only the uninstalling copy's Claude Code hooks before file removal and skips upgrades.
- Legacy `builtin:clawd` / `clawd.pet.js` references migrate to Clawrk.

### Still open before the beta installer

- Clean Windows 10 and 11 install, upgrade, uninstall and same-profile reinstall checks.
- A recorded live Claude Code session against the installed app (synthetic bridge tests exist; a live run doesn't yet).
- Normal app shutdown within the smoke-test deadlines, and a measured one-hour soak run.
- Quiet handling of missing Claude Code hook files.
- Release workflow gates for tag/version/asset consistency.
- The first beta will be **unsigned**, with SHA-256 checksums. See [Windows signing](docs/WINDOWS_SIGNING.md).
