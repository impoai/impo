# Contributing

Start with [setup](README.md#run-locally) and [architecture](docs/architecture.md).
Keep changes focused and include the checks needed to verify the behavior.

- Run `npm test` for server/client protocol changes.
- Use the relevant isolated database suite for persistence or ownership changes.
- Run native tests for iOS capture, permission or UI changes; state hardware limits.
- Keep public copy and documentation in English.
- Edit Drizzle entities directly and use `npm run db:push` during development.
- Regenerate the Xcode project when adding native files.
- Run `npm run check:secrets` and inspect your diff before pushing.
- Keep credentials, local state, screenshots and internal deployment records out of Git.

Discuss larger changes in an issue or the [community Discord](https://discord.gg/84ZYn3xcGV).
Report security-sensitive issues privately as described in [SECURITY.md](SECURITY.md).
