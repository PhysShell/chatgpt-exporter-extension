# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 1.0.x | ✅ Yes |

Only the latest release receives security fixes. Please update before reporting.

---

## What This Extension Does With Your Session

This extension reads your ChatGPT session token (from `/api/auth/session`) and uses it to call the same internal `chatgpt.com` API endpoints that the ChatGPT web app itself uses. The token is used only during the export and is never stored, logged, or transmitted outside of `chatgpt.com`.

**The extension cannot:**
- Access any website other than `chatgpt.com`
- Read your password or email address
- Store anything in `localStorage`, `IndexedDB`, or browser cookies
- Send data to any third-party server

---

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

If you find a security issue — especially one involving session token handling, data exfiltration, or content script injection — report it privately:

1. Go to the [Security tab](https://github.com/vincze-tamas/chatgpt-exporter/security) of this repository
2. Click **"Report a vulnerability"**
3. Describe the issue, steps to reproduce, and potential impact

You will receive a response within **72 hours**. Critical issues will be patched and released as soon as possible, with a coordinated disclosure after the fix is available.

---

## Scope

In scope:
- Session token leakage or exposure
- Unintended data transmission to third parties
- Content script injection vulnerabilities
- ZIP path traversal in the output archive
- Cross-origin data access

Out of scope:
- ChatGPT's own API behaviour or rate limits
- Issues requiring physical access to the user's machine
- Social engineering attacks

---

## Responsible Disclosure

We follow a **90-day disclosure policy**: if a reported issue is not resolved within 90 days, the reporter is free to disclose it publicly. We appreciate coordinated disclosure and will credit researchers in the relevant release notes.
