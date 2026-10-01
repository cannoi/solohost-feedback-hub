# AI module note — v2.4

Builder stores the key on the provider you select (`GEMINI_API_KEY`, `DEEPSEEK_API_KEY`).
Feedback Hub now does the same inside `ai-app-kernel`:

- Settings → choose provider → paste token → Kiểm tra token
- Kernel binds `AI_API_KEY` to `AI_PROVIDER` even when the token prefix is `sk-` (DeepSeek and OpenAI share that prefix)
- Do not type the token into chat

Client apps still use `module/shfh-client.js`. They do not need the AI key.
