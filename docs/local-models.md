# Local / on-premises models

JessicaOS can run entirely against a model you host yourself — Ollama, LM
Studio, vLLM, or any other server that speaks the OpenAI **chat-completions**
API (`POST /v1/chat/completions`). This is an additional provider alongside
Claude, Gemini and OpenAI; it does not replace or weaken the existing
bring-your-own-key model.

## Why you'd use this: data sovereignty, not cost

The point of local models is **not** that they're cheaper than a frontier
API. It's that your documents and prompts never leave your own
infrastructure — nothing is sent to Anthropic, Google or OpenAI. That
matters for firms with strict data-residency requirements or clients who
won't permit their matter documents to touch a third-party API.

It is **not** a claim that local models match frontier quality. See
[Honest quality guidance](#honest-quality-guidance) below before relying on
this mode for real matter work.

## Setup

Local mode is a server-side (`backend/.env`) configuration — there is no
per-user base URL, and no way to point the backend at an arbitrary
user-supplied server. This is deliberate: a user-controlled URL fetched by
the backend is a server-side request forgery (SSRF) risk, so only the
operator running the JessicaOS backend can configure it.

Add to `backend/.env` (see `backend/.env.example` for the commented
template):

```
LOCAL_LLM_BASE_URL=http://localhost:11434/v1
LOCAL_LLM_MODELS=qwen2.5:14b-instruct
LOCAL_LLM_API_KEY=
```

- `LOCAL_LLM_BASE_URL` — the server's OpenAI-compatible base URL (note the
  trailing `/v1`, matching Ollama's default).
- `LOCAL_LLM_MODELS` — a comma-separated list of model ids to offer in the
  model picker. These must be ids your local server actually has loaded.
- `LOCAL_LLM_API_KEY` — optional. Most local servers ignore the bearer
  token entirely; when unset, JessicaOS sends `Authorization: Bearer ollama`
  as a harmless default.

`OPENAI_BASE_URL` is honoured as a documented alias for `LOCAL_LLM_BASE_URL`
when the latter is unset. It never affects the cloud OpenAI client — the
two providers coexist, so you can keep a cloud OpenAI key configured and
add local models alongside it.

Once both a base URL and at least one model are configured, a **"Local
(on-premises)"** group appears in the model picker (chat, tabular reviews,
and account → model preferences for title/tabular defaults) — visible only
when configured, hidden entirely otherwise.

### Ollama

```bash
ollama pull qwen2.5:14b-instruct
ollama serve   # usually already running as a background service
```

```
LOCAL_LLM_BASE_URL=http://localhost:11434/v1
LOCAL_LLM_MODELS=qwen2.5:14b-instruct
```

### LM Studio

Load a model in LM Studio and start its local server (Developer tab →
"Start Server"), which by default listens on `http://localhost:1234/v1` and
speaks the same chat-completions API.

```
LOCAL_LLM_BASE_URL=http://localhost:1234/v1
LOCAL_LLM_MODELS=qwen2.5-14b-instruct
```

(vLLM's OpenAI-compatible server works the same way — point
`LOCAL_LLM_BASE_URL` at its `/v1` endpoint.)

## Recommended model

**Qwen 2.5 14B Instruct** (Apache-2.0 licence) is the model this
integration has been built and tested against. It's a reasonable balance of
capability and hardware requirements for a single workstation, and its
licence permits unrestricted commercial use — no attribution or
share-alike obligations, unlike some other open-weights families.

## Honest quality guidance

Frontier API models (Claude, Gemini, GPT) materially outperform local
open-weights models on legal drafting and analysis tasks — issue-spotting
completeness, correct statement of law, and avoiding invented facts all
degrade with smaller local models. Local mode is a genuine data-sovereignty
option, not a drop-in substitute for a frontier model on matter-critical
work.

The README's eval comparison table (populated by the Day-3 model-comparison
run against the golden eval set — see `docs/BUILD_PLAN.md`) is the source of
truth for how a given local model compares to Claude/Gemini/OpenAI on this
platform's own tasks. Read it before deciding how much to trust local-model
output on a real matter.

## Tool-calling reliability

JessicaOS's document tools (read/edit, generate DOCX, workflows) rely on
the model calling functions with well-formed JSON arguments. Tool-calling
reliability **varies significantly by model and by server** — smaller
models in particular sometimes emit malformed tool-call JSON. When that
happens, JessicaOS does not crash: the malformed call is reported back to
the model as a tool error (so it can retry or explain the failure to you)
rather than executed. If you see repeated tool failures, try a larger model
or a different local server.
