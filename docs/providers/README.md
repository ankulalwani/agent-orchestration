# AI models: own logins and add-on models

**By default every task runs on the harness's own login and model choice**: Claude Code on your Claude
subscription (or whatever it is configured with), Codex on its ChatGPT login, and so on. Nothing needs to
be set up for that. Each installed harness appears as a provider `native:<agent>` ("own login") with the
model `default`, and is preferred over everything else unless a policy prefers something explicitly.

**Add-on models are optional.** They are the providers below, configured on the worker (local UI →
**AI models**): when a harness reaches its usage limit, a task can continue on them. Keys never leave the
machine, and the dashboard only shows masked values such as `sk-ant-••••••••••••1234`.

## When a harness reaches its limit

A worker setting (local UI → AI models → *When a harness reaches its limit*) decides:

- **Ask me** (default): the task waits for an answer in the dashboard. Reply `switch` to continue on
  add-on models, or `wait` to wait for the harness's limit to reset.
- **Switch automatically**: the task continues at once on the first available add-on model, from its
  last checkpoint.

Either way, the next session of the task goes back to the harness's own login once its limit has reset.
Without add-on models the task waits for the reset (the fallback policy applies). A limit without a known
reset time is retried after 15 minutes; a reset time is never guessed.

## The model gateway

Harnesses speak their own API: Claude Code the Anthropic Messages API, Codex the OpenAI Responses API,
Gemini CLI the Gemini API, OpenCode and Aider OpenAI chat completions. Add-on providers offer OpenAI-compatible
chat completions. The worker's **model gateway** sits in between, like OmniRoute or free-claude-code but built
in:

- It listens on `127.0.0.1` only, on a random port, and each agent session gets its own token.
- The harness is started with its endpoint pointed at the gateway (`ANTHROPIC_BASE_URL` for Claude Code; a
  custom `model_provider` for Codex; `GOOGLE_GEMINI_BASE_URL` with API-key authentication and a settings home
  of its own for Gemini CLI; `OPENCODE_CONFIG_CONTENT` for OpenCode; `OPENAI_API_BASE` for Aider). Its own
  tools, prompts and settings are unchanged.
- It translates requests and streamed answers both ways, including tool calls and tool results (Codex's
  free-form tools such as `apply_patch` become functions with one `input` argument). Thinking/reasoning
  blocks are not sent upstream, and hosted server tools (web search) are not available through it.
- **Fallback inside a turn:** a request goes to the first add-on model that answers. A limit (429), an
  outage (5xx, timeout, connection error) or a refusal (4xx: unknown model, no tool support) moves it to the
  next model, as long as nothing has been streamed yet. If every add-on model is limited the harness gets a
  limit error in its own format, with the soonest known `Retry-After`.
- **Order:** add-on providers are used in the order of the list (move them up and down). List the models to
  use per provider (the first is preferred); without a list, every model the provider lists is used.

All five harnesses were run for real through the gateway (Claude Code 2.1.281, Codex 0.157.1, Gemini CLI
0.61.0, OpenCode 1.18.32, Aider 0.86.2) against a fake OpenAI-compatible model that asks each to create a
file with its own tools; no real add-on provider was used.

## Providers

Presets in the worker UI: **OpenRouter**, **NVIDIA NIM**, **Groq**, **DeepSeek**, **OpenAI**, **Google
Gemini** (through its OpenAI-compatible endpoint), **Anthropic** (API key), **Ollama** and **LM Studio**
(local, keyless), and **Other OpenAI-compatible** (vLLM, LiteLLM, Together, Fireworks, …: give the base URL).

| Kind | List models | Health | Usage | Notes |
|---|---|---|---|---|
| `anthropic` | ✓ `/v1/models` | ✓ | — | `x-api-key`, `anthropic-version: 2023-06-01` |
| `openai` | ✓ `/v1/models` | ✓ | — | Custom base URL supported |
| `openai-compatible` | ✓ `/models` | ✓ | — | vLLM, LM Studio, LiteLLM…; key optional |
| `google` | ✓ `/v1beta/models` | ✓ | — | `x-goog-api-key` header |
| `openrouter` | ✓ | ✓ | ✓ `/key` | Credit usage and limit |
| `azure-openai` | ✓ | ✓ | — | Base URL is the resource endpoint; `extra.apiVersion` |
| `ollama` | ✓ `/api/tags` | ✓ | — | Local, keyless |
| `deepseek`, `groq`, `nvidia-nim` | ✓ `/models` | ✓ | — | OpenAI-compatible presets with their default addresses |
| `lmstudio` | ✓ `/models` | ✓ | — | Local, keyless (`http://127.0.0.1:1234/v1`) |
| `bedrock` | ✓ `ListFoundationModels` | ✓ | — | SigV4-signed. `extra.region`, optional `extra.profile`; `baseUrl` for a VPC endpoint |
| `vertex` | manual list | ✓ | — | Google OAuth token, then the project's Vertex AI location. `extra.project`, `extra.region` |

**Verification status:** each provider was tested against a local HTTP fake that checks auth headers, paths, parsing, and 429 `Retry-After` handling. None was tested against the live API because no keys were available.

### Bedrock and Vertex credentials

- **Bedrock:** for health checks the worker uses, in order, the key stored for the provider in the worker
  UI (`ACCESS_KEY_ID:SECRET` or `ACCESS_KEY_ID:SECRET:SESSION_TOKEN`, or JSON), the `AWS_*` environment
  variables, then the profile in `~/.aws/credentials` (`extra.profile`, else `AWS_PROFILE`, else
  `default`). A stored key is also passed to agents as `AWS_*` variables. With SSO or instance roles the
  worker can't sign a check itself; the provider is then shown as usable and problems appear when an
  agent runs.
- **Vertex:** store a service-account key (JSON) for the provider, or rely on
  `GOOGLE_APPLICATION_CREDENTIALS` or `gcloud auth application-default login`. Set `extra.project` and
  `extra.region`; agents receive them as `ANTHROPIC_VERTEX_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT` and
  `CLOUD_ML_REGION`. Declare the models you use (Vertex has no simple list of usable models per project).
- Signing is checked against the official AWS SigV4 test vector and against the AWS SDK's own signer;
  the Google token exchange against a fake token endpoint that verifies the JWT with the key's public key.

## Behaviour

- **Capabilities, not assumptions.** An operation a provider doesn't support returns `{ supported: false, reason }`. The platform never invents usage or limit data.
- **Rate-limit-safe polling.** Health checks run at most every 5 minutes, back off exponentially with jitter on failure, and are skipped while a provider is known to be limited.
- **Limits.** Limits reported by agents during execution (or a 429 from a health check) mark the provider as limited. When no reset time is known it stays limited until a later check succeeds; a reset time is never guessed.
- **Own login.** Harnesses use their own login without any provider entry (see the top of this page). The older "use the agent's own login" option on a provider still works.
- **`AO_HARNESS_OWN_LOGIN=0`** (worker environment) turns the own-login targets off, for workers that must only use configured providers.
- **Sign in instead of a key (OpenRouter).** In the worker UI, save an OpenRouter provider without a key and click **Sign in with OpenRouter**. The browser opens OpenRouter, you approve, and OpenRouter issues a key for this computer (OAuth with PKCE; the callback goes to the worker's loopback address, so nothing needs registering). The key goes into the OS credential store like a pasted one. Anthropic and OpenAI offer no OAuth for API access: use a key or the agent's own login. Google Vertex and Bedrock use cloud credentials (see above).

## Usage tracking

Token counts and cost are recorded per task, agent, provider and model when the agent reports them (Claude Code reports both). They are exposed via `GET /api/v1/orgs/:orgId/usage`.
