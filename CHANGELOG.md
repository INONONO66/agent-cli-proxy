# Changelog

All notable changes to this project will be documented in this file.

## [0.2.7](https://github.com/INONONO66/agent-cli-proxy/compare/v0.2.6...v0.2.7) (2026-06-21)

### Features

- **server:** proxy websocket upgrade requests (c7f5e64)

### Bug Fixes

- **release:** publish npm with oidc (79c18d3)
- **server:** accept websocket proxy credentials (6339a29)

### Tests

- **server:** cover websocket proxy relay (504d366)
## [0.2.1](https://github.com/INONONO66/agent-cli-proxy/compare/v0.2.0...v0.2.1) (2026-05-29)

### Bug Fixes

- keep GitHub Release creation independent from npm publish failures
- package GitHub runtime assets after npm publish

## [0.2.0](https://github.com/INONONO66/agent-cli-proxy/compare/v0.1.0...v0.2.0) (2026-05-29)

### Features

- add separate local dashboard runtime and build output
- require managed proxy API keys through Authorization Bearer tokens
- attach release runtime tarballs to GitHub Releases

### Bug Fixes

- disable CLIProxyAPI usage correlation after unsupported 404 responses
- keep admin APIs local-only by socket address

### Documentation

- document GitHub Release based server installation
