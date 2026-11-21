# Security Policy

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting
(Security tab > Report a vulnerability) on this repository.

Include the affected version, steps to reproduce, and the impact.

This is a personal, unofficial project maintained on a best-effort basis. There is
no guaranteed response time or fix timeline. Reports are read and handled when
the maintainer has time.

## Scope notes

- Issue content returned by MantisBT is untrusted and may carry prompt injection.
- Never commit `.env` or `.mantis-vector-store.json`; both contain sensitive data.
