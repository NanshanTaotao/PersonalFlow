# Security Policy

PersonalFlow is local-first software. Practice data, saved model configuration, and SQLite storage are intended to stay on the user's machine unless the user explicitly connects an external model provider.

## Supported Versions

The project is currently in alpha. Security fixes are applied to the main development branch.

## Reporting A Vulnerability

Please do not open a public issue with exploit details, credentials, local database contents, or private prompts.

Use a private security advisory if the hosting repository supports it. Otherwise, contact the maintainers through a private channel and include:

- A short description of the issue.
- Steps to reproduce.
- The affected component.
- Whether real model mode was enabled.
- Any logs with secrets removed.

## Sensitive Data Expectations

PersonalFlow should not expose these values through product APIs, UI, debug views, tests, or logs:

- API keys or authorization headers.
- Raw model provider responses.
- Raw prompts or full prompt blocks.
- SQLite encryption material.
- Local database rows containing private user data.
- Internal event, actor, step, or state-version identifiers in user-facing pages.

## Local Data

Default local data is stored under:

```text
.personalflow/
```

Temporary test and acceptance artifacts may be stored under:

```text
.tmp/
```

Both paths are ignored by git. Do not attach local SQLite databases or logs to public issues.
