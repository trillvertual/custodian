# Lint toolchain

Run `npm ci --prefix tools/lint` from the repository root, then `npm run lint` and `npm run lint:verify`.

This is a private, independent development package. Its TypeScript 6 parser is supported by typescript-eslint and does not replace the application's TypeScript 7 compiler. Keep its own lockfile and audit it separately. Dependencies are managed by the `/tools/lint` Dependabot entry.

The minimatch override selects the patched 11.x API used by the current ESLint/parser dependencies. Remove it when their declared ranges include the patched branch, then rerun lint, its positive/negative smoke fixtures and the tooling audit.

See [the integration policy](../../docs/AUTOMATED-REVIEW.md) for the rule scope, container gate and service activation.
