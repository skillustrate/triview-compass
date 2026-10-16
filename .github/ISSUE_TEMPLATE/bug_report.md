---
name: Bug report
about: Something in TriView-Compass doesn't behave the way it's documented to
title: ""
labels: bug
---

**What happened**
A clear description of the actual behavior.

**What you expected**
What the README/SECURITY.md led you to expect instead, with a link to the specific claim if you can.

**Steps to reproduce**
The exact command(s), policy, and request/repository state. Redact any real secrets, source, or account details — this project treats reviewed content as sensitive and you should too when reporting a bug.

**Environment**
- OS (this project is Linux-only today; note if you're on something else and expecting support)
- Node version (`node --version`)
- Which adapter(s): Claude Code CLI version (`claude --version`), LM Studio, or your own `--adapter-module`

**Logs / output**
`--format text` output or the relevant JSON report fields. If it's a security-sensitive bug (e.g. a secret leaking somewhere it shouldn't), use SECURITY.md's private channel instead of a public issue.
