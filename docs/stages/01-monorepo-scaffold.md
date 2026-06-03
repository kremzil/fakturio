# Stage 1: Monorepo Scaffold

Goal: move development to the target stack immediately.

Deliverables:
- npm workspace root
- `apps/web` Next.js 16 app
- `apps/worker` Temporal worker
- `packages/*` domain packages
- Docker Compose local infra

Acceptance criteria:
- `npm test` passes.
- `npm run build` passes.
- Next dashboard runs on port `3000`.
