# Hermes Mobile (Web & Mobile React)

A cross-platform React application rewritten from the Hermes Mobile Android codebase, preserving the core features, cyber terminal aesthetic, and business logic of the Hermes AI gateway.

## Features

- **Setup & Onboarding Wizard:**
  - 4-step first-run wizard (Welcome, Image install simulation with live logs, 29+ Provider catalog & API key configuration, Boot restart options).
  - Provider catalog matching Hermes Desktop registry (DeepSeek, OpenAI, Anthropic, Gemini, xAI, Kimi, MiniMax, Qwen, Ollama, LM Studio, etc. + custom base URL).
- **Home Dashboard:**
  - Dynamic Agent status presence (ONLINE, THINKING, EXECUTING, WAITING, OFFLINE, CONNECTING, ERROR).
  - Current task banner and relative timestamps (`homeAgo`).
  - Quick action shortcuts (Chat, Command, Tasks/Jobs, Files).
  - Active & recent activities list with live streaming badges.
- **Chat (Agent Workspace):**
  - Live streaming SSE interface with thinking/reasoning blocks and duration timers.
  - Tool execution cards (web search, sandboxed execution, system ops).
  - Prominent mid-stream approval cards (Deny, Allow Once, Allow for Session).
  - Composer with multi-line input, image attachments (up to 4 with thumbnail previews), voice input, reasoning effort switcher, and model picker sheet.
  - Slash commands catalog (`/new`, `/retry`, `/clear`, `/help`, `/status`) and quick pills.
  - Text-to-speech (TTS) speaker on Hermes assistant replies.
  - Per-session message draft persistence and markdown export/share.
- **Scheduled Jobs (Activity / Cron):**
  - Cron schedule CRUD with quick presets (Once, Daily, Weekdays, Hourly, custom 5-field cron).
  - Overdue run tracking, manual "Run now", Pause/Resume toggles, and execution history log.
- **Settings & Ops Center:**
  - Connection credentials management with tri-state "Test key" verification.
  - Gateway service supervisor controls (Start, Stop, Auto-start toggle).
  - Operations diagnostics: Doctor health report checks, backup snapshotting, and debug report sharing.
  - Chat preferences: Font size slider, reasoning effort, auto-approve toggle, and App PIN lock screen.
  - Library: Agent skills toggles, long-term memory summary, blueprints launcher with variable slots, and feedback form.
- **Sessions Drawer:**
  - Multi-session drawer with search filter, source filters, sorting (Newest, Oldest, Most messages).
  - Pinned sessions section with star icons, session renaming, forking/branching, and deletion.

## Development

```bash
npm install
npm run dev
```

Built with React 19, TypeScript, Vite, Tailwind CSS, and Lucide Icons.
