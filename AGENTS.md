# Working on this repository

- Use `next` as the integration line. Develop in a task-owned pair of independent
  CLI and Broker clones, on task branches. Preserve other tasks' work.
- Start with [isolated development](docs/isolated-development.md) and
  `node scripts/paired-environment.mjs --help`. Select explicit build IDs for
  runs; do not reuse another task's dependency, build or state directories.
- Do not rebuild a checkout used by the normal CLI or Pi installation for a
  development experiment. Do not change global package registrations, settings,
  credentials, caches or session files to prepare a test.
- Follow [verification routing](docs/verification-routing.md). The existing
  integration Skill owns isolation and package pairing; natural and daily
  checks keep their own input requirements. Preserve the strict `next` gate.
- Keep one current implementation. Changes to public behavior include affected
  docs and tests. Cleanup applies only to owned processes and reviewed paths,
  using the established system-Trash policy.
