# Security Policy

Running pet code shared by others is a core feature of Harness Pet. Pets run in isolated Web Workers with no Node.js access, removed network APIs and an Electron request filter that restricts local resources and blocks external network requests. No software sandbox is infallible.

If you find a way to break out of the pet sandbox, reach the network, access unauthorized files (such as reading arbitrary `file://` URLs), execute arbitrary code on the host, capture keystrokes improperly, or anything else that could impact user security, please report it **privately**.

## How to report sandbox escapes and vulnerabilities

Please **do not** open public GitHub issues or discussions for security vulnerabilities or sandbox escapes.

Instead, report vulnerabilities privately:

1. **Send the report through one of these private channels:**
   - **GitHub private reporting (after repository setup):** use <https://github.com/muncheslunches/harness-pet/security/advisories/new> once private reporting has been enabled and verified. Until then, use the maintainer email below.
   - **Email:** `0vknzqgws@mozmail.com`
2. **Include in your report:**
   - A clear description of the vulnerability or sandbox escape vector.
   - Proof-of-concept pet file (`.pet.js`) or reproduction steps.
   - The OS version and Harness Pet version you tested.
   - Any potential impact or suggested mitigations.

Say whether you would like credit for the report. The maintainer will reply as soon as possible, and will agree a disclosure date with you before any details are published.

## Security Model & Sandbox Guarantees

- **Worker Isolation:** Pets run inside Dedicated Web Workers with DOM access disabled and Node.js integration disabled.
- **Prototype Lockdown:** Network, worker creation, and communication primitives (`fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `Worker`, `postMessage`, etc.) are stripped or sealed across `self` and prototype scopes (`WorkerGlobalScope`, `DedicatedWorkerGlobalScope`).
- **Network & File URL Filter:** The Electron main process intercepts all web requests (`onBeforeRequest`), strictly blocking non-local protocols and restricting `file://` access strictly to the application directory and the user's pets folder (`~/.harness-pet/pets`).
- **Path Execution Restriction:** Studio IPC handlers that open local folders or files (`open-path`) are strictly limited to pre-approved application paths in `store.PATHS`.

## Supported Versions

Security updates are provided for the latest release.

## Verification

Run `npm test` for the unit tests and `npm run test:security:electron` for real Electron checks. The smoke test exercises worker breakout attempts, forged global messages, infinite loads/draws, recovery, file/junction/HTTP/WebSocket denial, navigation, new windows and denied permissions. It uses a disposable profile and synthetic data. Windows junction tests require an environment that permits creating junctions. `HARNESS_PET_SECURITY_APP` can point the smoke test at unpacked `resources/app` to check packaged source parity and run its worker/filter code. These checks cover specific attacks and do not establish that every sandbox escape is impossible.

Trusted launch configuration in `links.json` can start programs or open external URLs through Windows. Those programs are outside Electron's request filter. Pet manifests and worker messages cannot configure those actions. Animation workers receive public agent status rather than prompt/tool/transcript content, keys or screenshots. See README's Settings recovery section for backup/reset instructions, worker deadlines and diagnostic-log privacy.
