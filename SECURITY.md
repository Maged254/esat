# Security Policy

## Reporting a vulnerability

If you discover a security issue in ESAT, please report it privately to the
project maintainer (the Egypro EHS/IT team) rather than opening a public issue.
Do not include secrets, credentials, or production data in a report.

## Secret management

All secrets are supplied through **environment variables** and are read only from
the environment at runtime. The application:

- **Never** hardcodes credentials, API keys, connection strings, or signing
  secrets in source code.
- **Refuses to start** if the JWT signing secret is missing, so it can never fall
  back to a predictable default.

Local configuration lives in a `.env` file that is **git-ignored** and must never
be committed. Use `.env.example` (values omitted) as the template.

**Never commit a secret.** If you must reference one, reference the environment
variable name, not its value.

## If a secret is exposed

Committing a secret — even briefly — means it must be treated as compromised.
Removing it in a later commit does **not** help: the value remains recoverable
from git history. **Rotation of the live value is the only effective remediation.**

Rotation procedure:

1. **Generate a new value.** For random signing secrets, use a cryptographically
   secure generator (e.g. `openssl rand -base64 48`). Never paste the real value
   into chat, tickets, or commits.
2. **Update the deployment environment.** Set the new value in the hosting
   platform's environment/secret settings and redeploy.
3. **Verify** the application works with the new value and that the **old value is
   rejected**.
4. **Re-issue dependent tokens.** Rotating the JWT signing secret invalidates
   **every** issued token — including long-lived tokens held by automated
   integrations (for example, the SharePoint sync). Re-mint those tokens and
   update wherever they are stored, or the integration will start returning
   `401`.
5. **Record** the rotation (who/when) for audit.

> ⚠️ Rotating the JWT signing secret logs out all users and breaks any automated
> integration that authenticates with a stored token until that token is
> re-issued. Plan the two changes together.

## Optional hardening

- Keep application repositories **private**.
- Periodically scrub secrets from git history (cleanup only — not a substitute for
  rotation).
- Rotate third-party API keys on a regular schedule.

---

_Operators: the environment-specific rotation runbook (hosts, service names, and
the exact steps for this deployment) is maintained separately as an internal,
confidential document and is intentionally not committed to this repository._
