# Wardens

TypeScript engine for PANOPTICON ring 0. It loads `panopticon.charter.yaml`, checks it against `schema/charter.schema.json`, and exposes `wardens check` and `wardens hook`.

```bash
pnpm --filter wardens test
pnpm --filter wardens build
```

The build writes `dist/wardens.mjs` and is not committed. Hook installation is a later issue (`wardens sync`).
