# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Transfer target workspace**: the "Transfer to Harness" panel and the `webchat_transfer` tool now let you pick a target workspace (or leave the new session ungrouped). The transferred session is created with the workspace's canonical path as its working directory and attached to the workspace's account, so it is grouped under that workspace in the sidebar instead of "Ungrouped".
- **Workspace listing in `webchat_status`**: the status tool now reports the harness workspaces (`id | title | path`) available as `webchat_transfer` targets.
- **Unit tests** for the transfer workspace-resolution and attach logic (`test/transfer.test.ts`, `pnpm test`).

### Changed

- `webchat_transfer` accepts optional `workspaceId` and `cwd` parameters.

## [0.1.0] - 2026-08-20

### Added

- Initial release: browser-driven DeepSeek web chat, transfer-to-Harness (distill/raw), import-as-context, agent tools (`webchat_status` / `webchat_send` / `webchat_import` / `webchat_transfer`), and one-time hands-free login.
