# Contributing to Qingmo

Thanks for taking the time to improve Qingmo. This guide keeps changes small, testable and aligned with the editor's architecture.

## Before you start

Read these first — they explain constraints that are easy to break accidentally:

- [Architecture invariants](README.md#architecture)
- Implementation ADRs: `docs/adr/` (kept locally, not versioned)
- Blueprint: `docs/BLUEPRINT.md` (kept locally, not versioned)

If an issue touches saving, window closing, path handling, IPC or the update chain, open a design discussion before writing code. Those paths have exactly one supported design and are guarded by tests.

## Development setup

```bash
corepack enable
pnpm install
pnpm tauri dev
```

`pnpm dev` runs the UI against in-memory adapters. Use `pnpm tauri dev` for native dialogs and real file IO.

Prerequisites and build commands are listed in the [README](README.md#install-and-build).

## Workflow

1. Fork the repository and create a topic branch: `feat/…`, `fix/…`, `docs/…`.
2. Keep each pull request focused on one change.
3. Add or update tests at the lowest layer that can prove the behavior: Vitest for pure logic, Testing Library for components, Rust integration tests for IO, Playwright for user flows.
4. Run the local gate before pushing:

   ```bash
   pnpm ci:local
   ```

5. Fill in the pull request template, including the user-visible effect and any residual risk.

### Changes to the IPC boundary

Adding or changing a command, event, permission or DTO requires:

1. Update the contract source and regenerate TypeScript types.
2. Update the capability allowlist and negative tests.
3. Cover the new shape in contract tests.
4. Update `docs/adr/0003-ipc-contract.md` and the command table in the task design doc.

### Changes to saving or closing

`SaveCoordinator` is the only save path. Do not add a second one. Any change must keep debounce, single-flight, conflict detection and close flushing intact, and must update `docs/adr/0002-single-save-path.md` or `docs/adr/0004-path-token-close-guard.md` when behavior changes.

## Style

- TypeScript: strict types, no `any` without a reason, ESLint and Prettier are authoritative.
- Rust: `cargo fmt` and `cargo clippy -- -D warnings`.
- CSS: use design tokens from `packages/ui`; no hard-coded colors in components.
- User-facing strings go through i18next (`zh-CN` and `en` together).
- Comments explain *why*, not *what*.

## Commit messages

Use one of: `feat`, `fix`, `refactor`, `docs`, `test`.

```text
[feat] Short description

What: what changed
Why: the problem being solved
How: the approach
Details: important implementation notes
Impact: affected modules
```

Do not add an AI co-author trailer.

## Pull request checklist

- [ ] The change is scoped to one problem.
- [ ] `pnpm ci:local` passes.
- [ ] New behavior has tests at the right layer.
- [ ] IPC, save, close or path changes update the matching ADR.
- [ ] User-facing strings exist in both locales.
- [ ] No secrets, build output or editor state files are committed.

## Reporting bugs

Include the commit SHA, OS and version, reproduction steps, expected vs. actual behavior, and relevant logs. Never paste document contents you consider private.

Security issues: open an issue marked **security** and avoid publishing a working exploit until a fix is available.

## License

By contributing, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), matching the project.
