## Token budget rules

Hard rules:
- Never continue from old chat history when current repo state is enough.
- Always start resumed work with `git status` and `git diff --stat`.
- Read only changed files or directly relevant files.
- Never scan the whole repository unless explicitly requested.
- Never print large command outputs.
- Never paste full file contents.
- Before reading a file over 300 lines, explain why it is needed.
- Keep implementation responses short.
- Prefer targeted `git diff <file>`, `findstr`, and small test commands.
- Use docs/* status files as memory, not chat history.