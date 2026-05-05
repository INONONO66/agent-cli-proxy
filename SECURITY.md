# Security Policy

## Reporting Security Vulnerabilities

If you discover a security vulnerability in Agent CLI Proxy, please email security@example.com instead of using the public issue tracker. Please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if available)

We will acknowledge receipt of your report within 48 hours and provide an estimated timeline for a fix.

## Security Considerations

### API Keys and Credentials

- Provider API keys should be configured in CLIProxyAPI, not stored by this proxy
- The proxy binds to `127.0.0.1` by default; only expose beyond loopback with proper authentication
- Use `ADMIN_API_KEY` when exposing admin endpoints beyond localhost

### Configuration

- Store `.env` files securely and never commit them to version control
- Restrict file permissions on configuration directories: `~/.config/agent-cli-proxy/`
- Use strong passwords for dashboard login if enabled

### Updates

Keep Agent CLI Proxy updated to receive security patches. Check for updates regularly using:

```bash
bunx agent-cli-proxy --version
```

## Supported Versions

Security updates are provided for the latest stable release. Users are encouraged to upgrade promptly when security updates are available.
