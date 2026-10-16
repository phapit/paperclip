export const type = "antigravity_local";
export const label = "Antigravity CLI (local)";

/** Empty means "use the model configured in the agy profile". */
export const DEFAULT_ANTIGRAVITY_LOCAL_MODEL = "";

/** Remote/sandbox bootstrap: installs agy into ~/.local/bin when it is missing. */
export const SANDBOX_INSTALL_COMMAND =
  'export PATH="$HOME/.local/bin:$PATH"; command -v agy >/dev/null 2>&1 || curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir "$HOME/.local/bin"';

/** Output of `agy models`; refresh when the CLI catalog changes. */
export const models = [
  { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" },
  { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
  { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)" },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
  { id: "claude-opus-5-5-medium", label: "Claude Opus 5.5 (Medium)" },
  { id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)" },
  { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
  { id: "claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 (Medium)" },
  { id: "claude-sonnet-5-5-low", label: "Claude Sonnet 5.5 (Low)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

export const agentConfigurationDoc = `# antigravity_local agent configuration

Adapter: antigravity_local

Use when:
- You want Paperclip to run the Antigravity CLI (agy) on the host machine, an SSH host, or a sandbox
- You sign in with a Google account (no API key) and want one isolated profile per agent
- You want conversations resumed across heartbeats with --conversation
- You want Paperclip skills delivered to agy and optional rotation across several signed-in accounts

Don't use when:
- The agy CLI is not installed on the machine that runs the agent

Core fields:
- cwd (string, optional): default absolute working directory for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): agy model id (see \`agy models\`). Empty uses the profile default.
- effort (string, optional): reasoning effort low | medium | high | xhigh | max, forwarded as --effort
- command (string, optional): defaults to "agy"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Account fields:
- accountHomes (string[], optional): profile HOME directories to rotate through when an account runs out of quota.
  Use absolute paths, or the single entry "auto" for every signed-in profile under
  $PAPERCLIP_HOME/antigravity-accounts (override with PAPERCLIP_ANTIGRAVITY_ACCOUNTS_DIR). Local runs only.
- quotaCooldownMin (number, optional): minutes an exhausted profile is skipped. Defaults to 60. The cooldown is in memory and resets when the server restarts.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Multiple accounts:
- Credentials and conversations live under $HOME/.gemini/antigravity-cli (token: antigravity-oauth-token).
  Give each agent its own HOME (for example HOME=/paperclip/antigravity-accounts/acc1) and sign in once per HOME.
- With accountHomes, a quota error switches to the next profile and starts a fresh conversation
  (a conversation only exists inside the profile that created it). The profile used is stored in the session as accountHome.

Skills:
- Desired Paperclip skills are linked into <HOME>/.gemini/config/skills, which agy discovers globally.
  Remote and sandbox runs copy them into the remote profile's skills root.

Remote and sandbox:
- Runs on SSH and sandbox targets install agy when missing and use the remote profile's own sign-in.
  Tokens are never copied to remote machines; sign in on the remote host, or use a local target.

Notes:
- Runs use \`agy -p <prompt> --output-format stream-json --dangerously-skip-permissions\`; the prompt is an argument, not stdin.
- Sessions resume with \`--conversation <id>\` when the stored session cwd matches the current cwd.
- Authentication: run \`agy\` interactively once per profile and sign in. Not signed in produces antigravity_auth_required.
- Models are discovered from \`agy models\` using a signed-in profile; the built-in list is the fallback.
`;
