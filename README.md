# pi-extensions

Extensions for [pi](https://pi.dev). Each top-level directory is a standalone npm package, published separately and listed in the [pi package gallery](https://pi.dev/packages).

| Package | Description |
|---|---|
| [`pi-preflight`](./pi-preflight) | Interviews you until the agent is confident, then plans, lets you review and edit, and executes with a live checklist |

## Publishing a package

```bash
cd <package>
npm run check       # typecheck + tests
npm publish         # the `pi-package` keyword lists it in the gallery
```
