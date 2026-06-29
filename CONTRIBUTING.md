# Contributing

## Setup

```bash
bun install
bun run check
```

Optional host checks require `pi` and/or `omp` on PATH:

```bash
bun run test:host
bun run test:global-config
```

## Development rules

- Keep the package standalone. Do not depend on this repository being inside a monorepo.
- Do not hard-code local absolute paths, API keys, tokens, or private service endpoints.
- Keep host-specific behavior behind Pi/OMP extension APIs.
- Add or update smoke coverage for config resolution, discovery, injection, and privacy behavior.
- Update README and examples when config fields or user-visible behavior change.

## Release

Releases are tag-driven:

```bash
bun run release:check patch --no-push
bun run release patch
```

The release script creates a temporary local release branch, writes version files, commits, tags, pushes the tag, and lets GitHub Actions publish via npm Trusted Publishing.
