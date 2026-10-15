# Prodero Curator

**Project memory for AI coding agents, through chat.**

Curator keeps useful decisions, conventions and lessons available across coding sessions. Ask your agent to remember something, retrieve relevant context or review what should be shared with your team.

**v0.1.0 Public Preview.** Curator runs locally and connects to your coding agent through MCP. The terminal is for installation and maintenance; everyday work happens in conversation.

## Why Curator exists

A new coding session often means explaining the same architecture, constraints and past mistakes again. Chat history alone is hard to reuse across tasks and teammates. Curator stores durable project knowledge and selects relevant context for the agent’s next task.

## How it works

Tell your agent:

> Remember that API tests should use our shared fixtures. Apply this to the `tests/` path.

The agent saves Local Knowledge through Curator’s MCP tools. In a later session, ask it to work on API tests: Curator can include that convention when the agent prepares context for the task. You can inspect or edit the saved item at any time.

Curator relies on the agent following its runtime instructions to prepare tasks, record useful outcomes and close sessions. It does not watch every conversation or guarantee that every detail will be remembered.

## Install

Requires **Node.js 22.14+ in the 22.x line**, npm and Git. See [compatibility](docs/COMPATIBILITY.md) for verified platforms.

```sh
npm install --global @prodero/cli@0.1.0
prodero install
```

The interactive wizard lets you choose a coding agent and review its MCP setup. Installation configures the agent; it does not initialize your projects.

## Open your coding agent

Restart the agent, open your repository and type:

```text
prodero
```

The agent opens Curator through MCP. In a new project, choose **Initialize Prodero**. Review the generated project files, including the managed `AGENTS.md` instructions and Git-ignore rules.

Where the host supports MCP Apps, Curator provides a graphical interface. Otherwise, use text mode: **“Show Prodero as text.”** You do not need to memorize CLI commands.

## Everyday use

Ask your connected agent in ordinary language:

- “What do we know about our API test setup?”
- “Remember why we chose this approach.”
- “Update the saved testing convention to use the new fixture directory.”
- “Show the knowledge relevant to this bug before we start.”
- “Review which Local lessons would be useful to share with the team.”

Use **Knowledge** to search, inspect and edit saved items. **Sync Memory** lets you choose **Improve memory**, **Share knowledge**, or both, then start the workflow. Eligible Local improvements can apply within that workflow; sharing presents proposed Versioned changes for review. Normal session learning does not require running Sync Memory.

## Main capabilities

- **Task context:** bounded selection of relevant knowledge and reusable skills.
- **Session continuity:** recorded outcomes become Local Knowledge when sessions close; preparation can recover pending observations.
- **Knowledge management:** search, applicability, sources, relationships and revision-aware editing.
- **Skills:** reusable procedures, with Local candidates and review workflows for Versioned skills.
- **Team knowledge:** Git-shareable Markdown that you review alongside repository changes.

## Local and Versioned Knowledge

**Local Knowledge** is Git-ignored working state. **Versioned Knowledge** is Git-shareable project state. Curator retrieves both; cloning a repository brings committed Versioned Knowledge, not ignored Local data.

Local does **not** mean inaccessible to the connected agent. The agent may create, promote and maintain Versioned Knowledge. Review and approval steps are workflow safeguards, not authenticated human authorization. Curator does not commit or push: review repository changes before sharing them.

The generated `.prodero/index.md` can include active **Local skill titles and paths**. It is not automatically ignored in every project. Keep it ignored when those details are private, and review generated files before committing. See [storage and privacy](docs/PRIVACY.md).

## Supported agents and limitations

**Codex CLI is verified; Claude Code is experimental.** Claude Code also needs a project `CLAUDE.md` importing `@AGENTS.md`; the installer does not create it. Cursor is detection-only, and there is no Claude Desktop installer.

MCP Apps, workspace roots and sampling support vary by host. Text mode supports core workflows, but App-only curation review/apply is unavailable through the text gateway. See the [host/runtime matrix](docs/COMPATIBILITY.md) and [setup guide](docs/hosts.md).

## Privacy and security

Knowledge and session history are plaintext project files. Keep secrets out of Curator: credential screening is best-effort, not complete data-loss prevention. Forgetting an item does not securely erase history, backups or Git.

Retrieved context reaches your connected agent. Optional assisted operations can send selected content through host sampling to its model; deterministic workflows do not require sampling. Curator requires neither cloud synchronization nor embeddings. See [privacy](docs/PRIVACY.md) and [security reporting](SECURITY.md).

## Documentation and contributing

- [Setup, updates and advanced CLI commands](docs/hosts.md) · [Recovery](docs/RECOVERY.md)
- [Architecture](ARCHITECTURE.md) · [Context selection](docs/CONTEXT-SELECTION-V2.md)
- [Themes](docs/ui-themes.md) · [Plugins](docs/plugins.md)
- [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Release verification](docs/RELEASING.md)

Preview interfaces and schemas may evolve. Back up the whole `.prodero` directory before upgrading; follow the linked maintenance and recovery guidance.

Curator is [MIT licensed](LICENSE).
