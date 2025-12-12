# Repository Guidelines

## Project Structure & Module Organization
- Source lives in `src/`, organized by Nest modules: `browser/` for Playwright helpers, `linkedin/` for LinkedIn automation (controllers, services, DTOs, utils), `stream/` for streaming support, and root `app.*` bootstrap files. `main.ts` wires the Nest application.
- Tests: unit specs live beside code as `*.spec.ts`; end-to-end tests and fixtures are in `test/` with `jest-e2e.json` for config. Built output lands in `dist/`.
- Supporting assets: `browser-dashboard.html` for manual browser control, service unit files (`mcp-agent.service`, `playwright-mcp.service`), and `mcp.json` for MCP configuration.

## Build, Test, and Development Commands
- Install: `npm install` (uses Node + npm; lockfile is present).
- Local run: `npm run start` (default), `npm run start:dev` (watch), `npm run start:debug` (inspect), `npm run start:prod` (run compiled `dist/main`).
- Build: `npm run build` (Nest compile via TypeScript).
- Lint/format: `npm run lint` (ESLint with auto-fix) and `npm run format` (Prettier on `src/` and `test/`).
- Tests: `npm test` (Jest unit), `npm run test:watch`, `npm run test:cov` (coverage to `coverage/`), `npm run test:e2e` (e2e from `test/jest-e2e.json`).

## Coding Style & Naming Conventions
- TypeScript with ES modules; prefer 2-space indentation and Prettier defaults. Keep imports ordered logically (framework → local).
- Files: controllers/services end with `.controller.ts`/`.service.ts`; DTOs under `dto/`; utilities under `utils/`; specs end with `.spec.ts`.
- Use Nest patterns (modules for boundaries, injectable services, DTOs + `class-validator`) and favor typed interfaces over `any`.
- Keep async browser flows human-like and explicit; avoid magic sleeps—use the existing timing utilities where present.

## Testing Guidelines
- Unit tests mirror source filenames with `.spec.ts` inside `src/`. E2E tests live in `test/` and target the compiled app.
- Prefer jest `describe/it` with clear scenario names; mock Playwright/Nest providers rather than hitting live services.
- Aim to keep coverage steady; `npm run test:cov` should pass. For new endpoints, include at least one happy-path and one failure-path test.

## Commit & Pull Request Guidelines
- Recent history uses short, descriptive titles (e.g., “Enhance LinkedIn note modal handling…”). Follow that style: imperative/concise subject, present tense, <=72 chars when possible.
- Include context in the body when behavior changes or timing/automation is affected. Reference related issue IDs or links in the description.
- For PRs, provide: summary of change, risk/rollout notes, test commands executed, and any screenshots or logs for browser flows. Tag reviewers for affected modules (`browser`, `linkedin`, `stream`).

## Security & Configuration Tips
- Avoid committing secrets; rely on environment variables loaded via `@nestjs/config`. Document new env keys in PRs.
- When modifying Playwright flows, ensure cookies/tokens stay scoped and sanitized before logging. Keep systemd service files (`*.service`) and `install-services.sh` aligned with runtime paths if you change startup behavior.
