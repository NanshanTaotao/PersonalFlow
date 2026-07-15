# Contributing

Thanks for helping improve PersonalFlow. The project is still in alpha, so the best contributions are focused, well-tested, and clear about product impact.

## Development Setup

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Open `http://127.0.0.1:5173` for the web app.

## Before You Open A Pull Request

Run the full gate:

```bash
pnpm release:gate
```

If the full gate is too slow during development, run the closest targeted checks first:

```bash
pnpm test:run
pnpm typecheck
pnpm build
```

## Code Guidelines

- Keep runtime behavior deterministic.
- Prefer product-facing copy over internal runtime terminology.
- Do not expose raw prompts, provider raw responses, API keys, authorization headers, storage rows, or internal event identifiers in product pages.
- Keep local-first behavior intact; do not introduce required cloud services for the default path.
- Add or update tests when changing runtime behavior, API DTOs, review generation, or visible UI behavior.
- Keep large generated artifacts, local SQLite files, logs, and uploaded scratch files out of git.

## Commit Guidelines

Use short imperative commit messages, for example:

```text
feat: add material visibility dialog
fix: keep review cards internally scrollable
docs: add local development guide
```

## Reporting Bugs

Please include:

- What you expected to happen.
- What actually happened.
- Steps to reproduce.
- Whether you were using fake model mode or real model mode.
- Relevant console or terminal output with secrets removed.
