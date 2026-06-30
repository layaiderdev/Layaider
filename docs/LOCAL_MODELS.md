# Connecting local model endpoints

Layaider's native engine is aider, which talks to models through litellm. Any
local server that exposes an OpenAI-compatible (or natively supported) API can
be used, so Layaider stays fully offline. This guide shows how to wire common
local servers into a Layaider blueprint.

## How model config flows in Layaider

1. **Model string** — add it in the aider tab's *Model strings* / *Models*
   lists (e.g. `ollama/llama3` or `openai/local-model`).
2. **Blueprint** — create a blueprint and set the architect (and optionally
   editor/weak) role to that model.
3. **Key** — add a key entry (nickname, env var, token) and set it as the
   blueprint's role key. Layaider writes referenced keys to a `0600` env file
   under `~/.layaider` and sources it into the session at launch; the secret
   never appears in the process list.
4. **Base URL** — the endpoint URL is an **environment variable**, not a key.
   Because the session runs under a login shell (`bash -lic`), export the base
   URL in your shell startup so the session inherits it (see below).

> Readiness note: the launcher refuses a blueprint whose provider key is not
> present. A keyless local server therefore still needs a **dummy key entry**
> (any non-empty token) referenced by the role, so the readiness check passes.

## Set the base URL in your shell startup

Add the relevant line to `~/.profile` (or `~/.bashrc`), in the same shell where
Layaider launches the session:

```sh
# Ollama
export OLLAMA_API_BASE="http://127.0.0.1:11434"

# Any OpenAI-compatible server (llama.cpp, LM Studio, vLLM, text-gen-webui)
export OPENAI_API_BASE="http://127.0.0.1:8080/v1"
```

Reload the shell (or restart Layaider) so the new session inherits it.

## Recipes

### Ollama

```sh
ollama serve
ollama pull llama3
export OLLAMA_API_BASE="http://127.0.0.1:11434"   # in ~/.profile
```

In Layaider:
- Model string: `ollama/llama3` (or `ollama_chat/llama3`).
- Key: nickname `ollama`, var `OLLAMA_API_KEY`, token `x` (dummy — Ollama needs
  no key but the readiness check does); set it as the blueprint's architect key.

### llama.cpp server

```sh
./llama-server -m model.gguf --host 127.0.0.1 --port 8080
export OPENAI_API_BASE="http://127.0.0.1:8080/v1"   # in ~/.profile
```

In Layaider:
- Model string: `openai/llama` (the suffix after `openai/` is the model name the
  server reports).
- Key: nickname `local`, var `OPENAI_API_KEY`, token `x`; set as architect key.

### LM Studio

Start its local server (default `http://127.0.0.1:1234/v1`):

```sh
export OPENAI_API_BASE="http://127.0.0.1:1234/v1"   # in ~/.profile
```

- Model string: `openai/<model-id shown in LM Studio>`.
- Key: `OPENAI_API_KEY` = `lm-studio` (any non-empty token).

### vLLM

```sh
python -m vllm.entrypoints.openai.api_server --model <hf-model> --port 8000
export OPENAI_API_BASE="http://127.0.0.1:8000/v1"   # in ~/.profile
```

- Model string: `openai/<hf-model>`.
- Key: `OPENAI_API_KEY` = `x`.

## Verifying

Launch the blueprint from the **Live** tab, then attach to watch the session
directly:

```sh
tmux attach -t la-aider
```

If aider reports it cannot reach the model, confirm the base-URL variable is
exported in the launching shell (`echo $OPENAI_API_BASE` inside
`bash -lic`) and that the local server is listening on that address.

## Cloud models (for reference)

Cloud providers work the same way without a base URL: add the model string
(e.g. `anthropic/claude-...` or `openai/gpt-...`), add the real API key under
its standard env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...), and set it as
the blueprint's role key. Note that cloud models require network access, so they
are not part of the offline guarantee.
