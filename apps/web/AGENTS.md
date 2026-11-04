# apps/web

Next.js App Router UI and admin panel. This app is a placeholder page.

- `pnpm --filter @lunarhunt/web dev` listens on `WEB_PORT` (default 3000).
- `pnpm --filter @lunarhunt/web test` runs Vitest in jsdom.
- Keep routes as server components until a client interaction needs `"use client"`.
- Shared components go in `@lunarhunt/ui`.
