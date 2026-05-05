# Security Policy

## Supported versions

| Version | Support |
|---------|---------|
| 0.x | Best-effort security fixes via patch releases |

We aim to release security patches promptly. Users are encouraged to stay on the latest patch release within the 0.x line.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, use one of these channels:

- **Email**: security@example.com *(TODO: replace with a real address before first public release)*
- **GitHub private security advisory**: [Report a vulnerability](https://github.com/<owner>/agent-cli-proxy/security/advisories/new)

Include in your report:

- A clear description of the vulnerability
- Steps to reproduce
- Potential impact (what an attacker could do)
- Suggested fix if you have one

We will acknowledge receipt within 48 hours and provide an estimated timeline for a fix.

## Disclosure timeline

We follow a 90-day coordinated disclosure policy:

1. You report the vulnerability privately.
2. We acknowledge within 48 hours.
3. We investigate and develop a fix, keeping you updated.
4. We release a patch and notify you before or at the same time as public disclosure.
5. After 90 days from your report (or sooner if a patch ships), you may disclose publicly.

If a vulnerability is actively exploited in the wild, we may accelerate the timeline.

## Configuration security best practices

### Admin API key

The proxy binds to `127.0.0.1` by default. If you expose it beyond loopback (by setting `PROXY_HOST` to a non-loopback address), you **must** set `ADMIN_API_KEY`. Without it, the proxy refuses to start.

```bash
# Good: loopback only, no key needed
PROXY_HOST=127.0.0.1

# Good: non-loopback with key
PROXY_HOST=0.0.0.0
ADMIN_API_KEY=a-long-random-secret
```

Do not expose the admin endpoints to the public internet without additional network controls (firewall, reverse proxy with TLS, etc.).

### Management key

`CLIPROXY_MGMT_KEY` is used for CLIProxyAPI account correlation. Rotate it if you suspect it has been compromised. Use `--cliproxy-mgmt-key-env` during non-interactive init so the value never appears in shell history or process arguments.

### Environment files

- Store `.env` files with mode `0600` (owner read/write only). The `init` command sets this automatically.
- Never commit `.env` files to version control. The `.gitignore` excludes `.env` by default.
- Prefer environment variables injected by your process manager over files on disk for production deployments.

### Provider credentials

Provider API keys should be configured in CLIProxyAPI, not in this proxy. If you use custom providers with `auth.env`, make sure the referenced environment variables are set securely and not logged.

### Dashboard password

If you enable the dashboard (`DASHBOARD_PASSWORD_HASH`), use a strong password. The hash is bcrypt; generate it with:

```bash
bunx agent-cli-proxy init
```

The interactive init prompts for a password and stores only the hash.

## Upgrading safely

To upgrade to the latest version:

```bash
# If installed globally
npm update -g agent-cli-proxy

# If running from source
git pull
bun install
bun run build
agent-cli-proxy service restart
```

Check the CHANGELOG (when added) for breaking changes before upgrading across minor versions. Patch releases within 0.x are safe to apply without configuration changes.

After upgrading, run `agent-cli-proxy doctor` to verify the configuration and database migrations are current.
