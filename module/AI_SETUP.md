# AI module note — v2.4.1

Builder stores the key on the provider you select (`GEMINI_API_KEY`, `DEEPSEEK_API_KEY`).
Feedback Hub does the same inside `ai-app-kernel`:

- Settings → choose provider → paste token → **Kiểm tra token**
- Kernel binds `AI_API_KEY` to `AI_PROVIDER` even when the token prefix is `sk-` (DeepSeek and OpenAI share that prefix)
- Token check = list models; if the provider has no `/models`, a one-line chat test; the message says exactly why it failed (401 wrong key, 402 no credit, timeout, DNS/network)
- A key is only ever sent to the provider it was entered for
- Do not type the token into chat

Client apps still use `module/shfh-client.js`. They do not need the AI key.

To add the same token check to another app, use `module/AI_TOKEN_CHECK_PROMPT.md`.
