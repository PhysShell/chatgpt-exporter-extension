# ChatGPT Conversation Exporter

> A Chrome extension that exports **all your ChatGPT conversations** to Markdown files inside a ZIP archive — preserving your project folder structure, with no Python or external tools required.

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-orange.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Output Structure](#output-structure)
- [How It Works](#how-it-works)
- [Privacy](#privacy)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Exports all projects** — automatically discovers every project in your sidebar
- **Preserves folder structure** — each project becomes its own folder in the ZIP
- **Exports regular conversations too** — non-project chats go into a `Conversations/` folder
- **Pure Markdown output** — clean `.md` files ready to open in any editor or Obsidian vault
- **Runs in the background** — close the popup while exporting; the tab keeps working
- **Live progress + ETA** — real-time progress bar with time-remaining estimate
- **No Python, no scripts, no dependencies** — one ZIP download, just unzip and read
- **Zero external requests** — uses your existing browser session; nothing leaves your machine

---

## Installation

### Option A — Load unpacked (no store required)

1. [Download this repository](https://github.com/vincze-tamas/chatgpt-exporter/archive/refs/heads/main.zip) and unzip it
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the `chatgpt-exporter/` folder

The extension icon appears in your toolbar. If it's hidden, click the puzzle-piece icon and pin *ChatGPT Conversation Exporter*.

---

## Usage

### Step 1 — Open ChatGPT

Navigate to [chatgpt.com](https://chatgpt.com) and make sure you are logged in.

### Step 2 — Load all your projects

In the left sidebar, hover over the **"More"** button under *Projects*. This makes ChatGPT render all your project links, which the extension picks up automatically.

> If only some projects appear, wait a moment or scroll the sidebar — the extension detects them as they appear in the DOM.

### Step 3 — Export

Click the **ChatGPT Exporter** icon in your toolbar, then click **📥 Export to ZIP**.

The extension will:
1. Detect all your projects
2. Download the conversation list for each project
3. Download full conversation details and convert them to Markdown
4. Package everything and download `chatgpt_export_YYYY-MM-DD.zip` automatically

> **You can close the popup** while the export runs — it continues in the background as long as the `chatgpt.com` tab stays open. Reopen the popup anytime to check progress.

### Step 4 — Unzip

Done. Just unzip the file — no further steps needed.

---

## Output Structure

```
chatgpt_export_2025-07-14.zip
└── chatgpt_export/
    ├── Projects/
    │   ├── My Coding Project/
    │   │   ├── 2025-06-01_Refactor authentication module.md
    │   │   └── 2025-06-15_Add unit tests for parser.md
    │   └── Research Notes/
    │       └── 2025-07-02_Literature review on transformers.md
    └── Conversations/
        ├── 2025-05-20_Random question about Python.md
        └── 2025-07-10_Recipe ideas.md
```

Each Markdown file looks like this:

```markdown
# Refactor authentication module

**Created:** 6/1/2025, 10:15:00 AM
**Updated:** 6/1/2025, 11:42:00 AM
**ID:** `a1b2c3d4...`

---

### You

Can you help me refactor this JWT middleware?

---

### ChatGPT

Sure! Here's a cleaner version using a dedicated `AuthGuard` class...

---
```

---

## How It Works

ChatGPT projects are stored internally as **gizmos** with the URL pattern `/g/g-p-{hex_id}-{slug}/`. The extension:

1. Watches the DOM with a `MutationObserver` to capture project links as they appear
2. Optionally clicks "More" in the sidebar to reveal all projects
3. Fetches a session token from `/api/auth/session` (same-origin, no password required)
4. Retrieves conversation lists via `/backend-api/gizmos/{gizmo_id}/conversations?cursor=0`
5. Uses cursor-based pagination to collect every conversation across all pages
6. Fetches full conversation trees via `/backend-api/conversation/{id}`
7. Converts the internal message tree to Markdown in pure JavaScript
8. Builds a standard ZIP archive in memory and triggers a browser download

All API calls are made **from within the `chatgpt.com` page context** using your existing browser session — identical to what the ChatGPT web app does itself.

---

## Privacy

This extension:

- **Only runs on `chatgpt.com`** — it cannot access any other website
- **Makes no external network requests** — all requests go to `chatgpt.com` only
- **Sends no data anywhere** — the ZIP is built in memory and saved directly to your computer
- **Uses no third-party libraries** — the full codebase is ~500 lines of vanilla JavaScript
- **Stores nothing persistently** — no `localStorage`, no `IndexedDB`, no cookies written

The full source code is auditable in this repository.

---

## Requirements

- Chrome 109+ or any Chromium-based browser (Edge, Brave, Arc, …)
- A ChatGPT account (Free or Plus)

---

## Troubleshooting

| Symptom | Solution |
|---|---|
| "Reload the chatgpt.com tab and try again" | The content script didn't load. Reload the `chatgpt.com` tab, then open the popup again. |
| 0 projects detected | Hover over "More" in the sidebar first, wait 1–2 seconds, then click Export. |
| Export stops mid-way | Keep the `chatgpt.com` tab open and visible. The extension keeps running in the background. |
| ZIP is empty or very small | A temporary API error occurred — try again. |
| Conversations appear in the wrong project | Make sure you're on the latest version; reload the extension if needed. |

**Still stuck?** [Open an issue](https://github.com/vincze-tamas/chatgpt-exporter/issues) and include:
- Your Chrome version (`chrome://version`)
- What you see in DevTools Console (`F12` → Console tab, on the `chatgpt.com` tab)
- Approximate number of projects and conversations

---

## Contributing

Contributions are welcome!

- **Bug reports & feature requests** → use the [issue templates](.github/ISSUE_TEMPLATE/)
- **Code changes** → fork, branch, and open a pull request with a clear description
- **Security issues** → see [SECURITY.md](SECURITY.md) before posting publicly

---

## License

[MIT](LICENSE) — free to use, modify, and distribute.
