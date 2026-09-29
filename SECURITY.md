# Security

Do not post credentials, recordings, transcripts or personal data in public issues.
Use the repository's private vulnerability reporting feature when it is available;
otherwise contact the maintainers privately through the project website.

## Configuration

- Keep server secrets in the ignored root `.env` or your deployment's secret store.
- Keep native deployment values in ignored `ios/App/Config.local.xcconfig`.
- Never put Clerk secret keys or other provider secrets in an iOS build.
- Use `.env.example` and `Config.local.example.xcconfig` only as blank/local examples.
- Signing keys, provisioning files, local databases, recordings and build output stay untracked.
- Use development identities only on local databases; never enable them in production.

## Checking a change

Install Gitleaks and run `npm run check:secrets` before pushing. The check scans
tracked/non-ignored files and reachable Git history with redacted output. CI runs
the same check. Test tokens must be clearly synthetic; broad path allowlists are
not a substitute for reviewing findings.

A clean automated scan is not proof that every possible credential format is
covered. If a real credential is exposed, revoke or rotate it, remove it from
history, and check other refs, forks and cached copies before publishing.
