// What we know about popular coding-agent harnesses, used to build the "link
// this agent" prompts. Hook systems change quickly, so every prompt also tells
// the agent to check the harness's current docs and adapt.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetHarnesses = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const HARNESSES = [
    {
      id: 'claude-code',
      name: 'Claude Code',
      app: 'Claude Desktop, the claude CLI, VS Code and JetBrains',
      builtIn: true,
      notes: [
        'Built in: Harness Pet can install these hooks itself (Studio → Agents → Claude Code → Install).',
        'Hooks live in ~/.claude/settings.json under "hooks": UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Notification, Stop, SessionEnd.',
        'Claude Desktop opens claude://claude.ai/new (new chat), claude://code/new (new Code session) and claude://code/continue?session=<local_… id>.',
      ],
    },
    {
      id: 'antigravity',
      name: 'Google Antigravity',
      app: 'the Antigravity IDE, app and agy CLI',
      notes: [
        'Hooks are shell commands in a hooks.json: user-global ~/.gemini/config/hooks.json (shared by the CLI, IDE and app) or workspace .agents/hooks.json.',
        'Known events: PreInvocation, PreToolUse, PostToolUse, PostInvocation, Stop. Tool events accept a regex matcher on the tool name.',
        'PreInvocation and PostInvocation fire around every model call, not once per turn; only Stop ends the turn. When background tasks or daemons run, Stop includes fullyIdle: false so pets indicate ongoing work. SessionStart must pass --event SessionStart (not PreInvocation), or new and idle conversations look busy.',
        'Payloads have conversationId and transcriptPath but no prompt text or event name; the bridge reads the title from the transcript and mirrors subagent activity back to the parent session.',
        'Hooks receive camelCase JSON on stdin and may answer with a JSON decision on stdout. PreToolUse should answer with an allow decision so the bridge never blocks a tool.',
      ],
    },
    {
      id: 'cursor',
      name: 'Cursor',
      app: 'the Cursor editor (Agent)',
      notes: [
        'Hooks live in ~/.cursor/hooks.json (user) or .cursor/hooks.json (project): { "version": 1, "hooks": { "<event>": [{ "command": "…" }] } }.',
        'Known events include beforeSubmitPrompt, beforeShellExecution, beforeMCPExecution, beforeReadFile, afterFileEdit and stop.',
        '"before…" hooks may need a JSON answer such as {"permission":"allow"} or {"continue":true}; check the docs and pass it with --reply.',
      ],
    },
    {
      id: 'codex',
      name: 'OpenAI Codex',
      app: 'the Codex CLI, IDE extension and app',
      notes: [
        'Newer Codex versions support lifecycle hooks; check the current docs for the config file and event names.',
        'Older versions only have `notify = ["program", …]` in ~/.codex/config.toml, which runs once per finished turn with the event as a JSON argument. The bridge reads JSON arguments, so `--harness codex --event agent-turn-complete` works there.',
      ],
    },
    {
      id: 'gemini-cli',
      name: 'Gemini CLI',
      app: 'the gemini CLI',
      notes: [
        'Hooks are configured in ~/.gemini/settings.json (or the project .gemini/settings.json) under "hooks".',
        'Event names to look for: BeforeAgent / AfterAgent, BeforeTool / AfterTool, Notification, SessionStart / SessionEnd. Check the current docs for exact names and the stdout contract.',
      ],
    },
    {
      id: 'copilot-cli',
      name: 'GitHub Copilot CLI',
      app: 'the copilot CLI and agent mode',
      notes: ['Check the current docs for hook or lifecycle-event support and its config file. If there are no hooks, use the generic fallback below.'],
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      app: 'the Windsurf editor (Cascade)',
      notes: ['Cascade has hooks for prompts, commands and code reads/writes; check the current docs for the file location and event names.'],
    },
    {
      id: 'cline',
      name: 'Cline',
      app: 'the Cline extension',
      notes: ['Cline supports hooks around tasks, prompts and tool use; check the current docs for where hook scripts go and which events exist.'],
    },
  ];

  return { HARNESSES, BY_ID: Object.fromEntries(HARNESSES.map((h) => [h.id, h])) };
});
