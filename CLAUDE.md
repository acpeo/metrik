# Claude Code instructions

Read and follow `AGENTS.md` before changing this repository. It is the public
cross-tool source for architecture, product constraints, platform boundaries,
working style, and verification.

If `.maintainer/MAINTAINER.md` exists, read it after `AGENTS.md`. It is an
optional private maintainer overlay. Do not fail when it is absent, and never
copy its contents into the public repository.

Useful commands:

```bash
npm ci
npm run dev
npm test
npm run build
npm run desktop:dev
npm run desktop:build

cd src-tauri
cargo fmt --check
cargo clippy -- -D warnings
cargo test
```

The browser preview uses explicitly labeled demo data and cannot validate native
desktop reads, transparency, positioning, menu-bar/taskbar integration, or
cross-monitor DPI behavior. Validate those behaviors on the affected operating
system.
