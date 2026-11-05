# Changelog

## 0.1.0-beta.5-final — first public beta

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
- The release workflow checks that the tag, package version and installer name match, and marks only versions like `0.1.0-beta.5-final` as pre-releases.
- Pets rest while you're away: slow motion after 5 minutes without input, asleep after 10. Your first input wakes them all, news from its agent wakes one, and locking the screen rests them at once. The times are in General settings.
- Experimental: **Sleep during full-screen apps**.
- `npm run perf` measures what a set of pets costs, and `npm run test:smoke:rest` checks resting, hidden pets and the helpers in real windows.

### Changed

- Pets without their own "needs you" or "done" animation no longer play the same stand-in for both: "needs you" is an urgent double hop, "done" hops briefly and then settles.
- Studio > Behavior is grouped (On screen and buttons on top, then Coming and going, Agent and look, Moving around, Personality). Options that depend on another setting are greyed out until it is on. The pet's Behavior menu uses the same groups.
- A single left click on a pet keeps the current app focused. Bubble clicks and explicit jump actions still open the tracked session; double-click reactions and Ctrl-double-click refresh remain available.
- A pet keeps calling you while an agent waits for your permission, for up to an hour, even if nothing else happens meanwhile.
- The NSIS uninstall macro attempts to remove only the uninstalling copy's Claude Code hooks before file removal and skips upgrades.
- Legacy `builtin:clawd` / `clawd.pet.js` references migrate to Clawrk.
- Electron 44.9.3 (from 44.9.0), which stops trusting the compromised eMudhra intermediate certificates (GHSA-jr5w-w6x2-84p9). The build tool dependencies fast-uri and minimatch move to 3.1.9 and 11.0.4 (GHSA-g3hv-75wg-m249); neither ships in the app.
- Much lower CPU and memory use. A frame identical to the one on screen is no longer sent to the GPU, and a pet holding still redraws less often. Three pets with their usual behaviors on, counting the load they add to Windows' compositor, went from about 38% of a CPU core to about 11% while their agents were quiet, and from about 50% to about 32% while their agents worked. In a short test their memory went from about 440 MB to about 270 MB, and over half an hour of real use it held at about 325 MB. Asleep, they use under 3%.
- The Windows helpers are now small Rust programs of about 200 KB instead of PowerShell processes, using about 1 MB of memory rather than about 75 MB and almost no CPU rather than about 2% of a core. The PowerShell scripts stay as a fallback, used automatically if the programs are missing or blocked.
- A pet's audio stream suspends once you're away or nothing has played for 5 minutes. It stays open otherwise, so sounds still start at once, and reopens the moment pets wake.
- Windows now tells the app when windows change, so pets climb back in front and notice their agent's window sooner, with less polling.
- A hidden pet closes its window, freeing its renderer: after 30 seconds for a pet that comes and goes with its agent (it got a new window each time anyway), after 5 minutes for one you hid. Studio keeps its details.
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
- The sessions folder no longer collects temporary files. A hook stopped between writing and renaming left one behind for good; the app now clears any over an hour old when it starts.
- Renderer console errors reach `app.log` again. The handler was reading Electron's old event arguments, so it never saw one and logged a deprecation warning instead.
- A slow start, such as right after signing in, no longer gets pets restarted while they are still loading. Each retry now waits twice as long as the last.
- Window titles and paths with non-English characters now match correctly in the Rust helper. PowerShell read and wrote them in the console's code page.
- A test depended on a pet that isn't in the repository, so it failed on a fresh checkout.
- A settings save that Windows briefly refuses (`EPERM` while antivirus, search indexing or a sync client has the file open) is retried instead of failing. If it still fails, the app tries again a few seconds later and shows an error only if that fails too. The Studio warning now names the file and the error, clears after the next successful save, and a valid settings file is no longer copied to `prefs.json.recovery-*`.

### Still open before 1.0

- Connect and a live Claude Code session on a second Windows PC. Install, uninstall and a short run have been tried on a 10-year-old Windows 10 laptop, where performance was subpar.
- Each Claude Code tool call waits about 0.8 seconds for two hooks. Running those two hooks in the background (Claude Code's `async` hook option) would remove that wait; it needs a live test first.
- Code signing. Releases are unsigned with SHA-256 checksums until then.
