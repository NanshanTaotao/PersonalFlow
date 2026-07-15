# PersonalFlow

PersonalFlow is a local-first AI roleplay practice studio. It helps users rehearse high-stakes conversations such as job interviews, thesis or project reviews, debate rounds, promotion reviews, and B2B sales discovery calls.

The project is built as a pnpm monorepo with a deterministic runtime, a local SQLite store, a Fastify API, and a React web app. It can run fully in local fake-model mode for development and testing, or connect to an OpenAI-compatible model provider through locally saved model settings.

## Status

This repository is in early alpha. The core practice flow, scenario templates, local storage, review generation, branch/fork flows, material attachment, and material visibility controls are functional and covered by automated tests. Expect API and schema changes before a stable release.

## Highlights

- Local-first data storage with SQLite.
- Built-in roleplay templates for interviews, reviews, debates, and sales conversations.
- RuntimeIR-based scenario execution with role, stage, state, resource, and visibility rules.
- Material library for reusable text context plus per-scenario temporary text materials.
- Per-material visibility configuration by role and stage.
- Evidence-based review reports generated from committed session events.
- Branching and withdraw flows for replaying from earlier turns.
- Fake model mode for deterministic local development and CI.
- Optional OpenAI-compatible model mode for real practice sessions.

## Repository Layout

```text
apps/
  api/        Fastify product API
  web/        React + Vite web app
packages/
  agent/      LLM adapter and AgentAction parsing
  contracts/  shared runtime and API contracts
  review/     review report generation
  runtime/    deterministic scenario runtime
  storage/    SQLite repositories
  templates/  built-in scenario templates and fixtures
tests/
  e2e/        Playwright product flows
```

## Requirements

- Node.js 20 or newer
- pnpm 10 or newer
- macOS, Linux, or Windows with a working native build toolchain for `better-sqlite3`

## Quick Start

```bash
pnpm install
pnpm demo:start
```

Open the web app at:

```text
http://127.0.0.1:5173
```

The API health endpoint is:

```text
http://127.0.0.1:3000/health
```

`pnpm demo:start` runs `pnpm demo:setup` first. Setup creates `.env` from `.env.example` if needed and copies the bundled demo database from:

```text
examples/demo/personalflow-demo.sqlite
```

to the API runtime store:

```text
apps/api/.personalflow/personalflow.sqlite
```

Setup does not overwrite an existing `.env` or local SQLite file. The runtime database is ignored by git. To reset back to the bundled demo, stop the dev server, remove `apps/api/.personalflow/personalflow.sqlite`, and run `pnpm demo:setup` again.

The bundled demo contains historical practice sessions and review reports so you can explore the product immediately. It does not include a working model credential. Configure your own OpenAI-compatible key in Settings if you want to run new real-model practice sessions.

## Model Modes

PersonalFlow supports two model modes.

`fake` mode is the default for local development and CI. It uses deterministic responses and does not call any external model provider.

```bash
PERSONALFLOW_MODEL_MODE=fake pnpm dev
```

`real` mode uses a saved OpenAI-compatible model configuration from the Settings page. API keys are stored locally and are not returned by product APIs.

```bash
PERSONALFLOW_MODEL_MODE=real pnpm dev
```

Use a stable local encryption key if you save model credentials:

```bash
PERSONALFLOW_LOCAL_ENCRYPTION_KEY=change-me-to-a-32-character-local-key
```

Do not commit real model credentials.

## Development Commands

```bash
pnpm test:run
pnpm typecheck
pnpm build
pnpm e2e
pnpm release:gate
```

`pnpm release:gate` runs the full project gate:

1. Vitest suite
2. TypeScript checks
3. Production build
4. Playwright Chromium install check
5. Playwright E2E tests

## Security And Privacy

- Local practice data is stored in SQLite on the user's machine.
- Model credentials are intended to stay local.
- Product APIs should not return raw provider responses, raw prompts, authorization headers, or API keys.
- `.personalflow/`, `.tmp/`, `.env`, logs, and upload scratch space are ignored by git.

Please read [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## Contributing

Contributions are welcome while the project is in alpha. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and run `pnpm release:gate` before opening a pull request.

## License

MIT. See [LICENSE](LICENSE).
