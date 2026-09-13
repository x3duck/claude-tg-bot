# Project instructions

## Scope

- This repository contains a Telegram bot backed by Claude Agent SDK and a Telegram Mini App.
- Read `README.md` before changing behavior or deployment-related code.
- If `AGENTS.local.md` exists, read it for machine-specific and deployment details. Never commit that file.

## Runtime and commands

- Use Node.js 24 or newer.
- Install dependencies with `npm install`.
- Run locally with `npm start` or `npm run dev`.
- Validate every code change with `npm run typecheck`.
- TypeScript runs directly under Node.js; there is no build step.

## Development

- Keep changes focused on the requested task.
- Preserve unrelated user changes in the working tree.
- Do not add code comments unless they explain a non-obvious protocol constraint or real trap. Comments must be concise and in English.
- Never commit `.env`, credentials, Telegram tokens, Claude credentials, `data/`, `workspaces/`, or logs.
- Treat Telegram topic state, persisted state, and workspace files as separate sources of truth. Account for partial failures when synchronizing them.
- Keep access checks and Telegram `initData` validation intact for every Mini App endpoint.
- Do not weaken `ALLOWED_USER_IDS`, private-chat restrictions, or path validation.

## Verification

- Run `npm run typecheck` after implementation.
- Exercise the affected flow locally when practical.
- For state-changing fixes, verify both success and failure paths.
- Report what was verified and anything that could not be verified.

## Git and deployment

- Do not create a commit or push unless the user explicitly requests it.
- Do not deploy, restart services, or modify a remote server unless the user explicitly requests it.
- Before committing, inspect `git status` and include only files relevant to the task.
- Use a concise commit message describing the resulting behavior.
- Never force-push or rewrite shared history unless explicitly requested.
