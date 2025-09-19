# Developer notes

## Smoke check

```
npm run build && npm start
BASE=http://localhost:3000 node scripts/smoke-history.mjs
```

Use `DEBUG=1` to append `&debug=1`.
