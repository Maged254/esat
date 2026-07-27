# 6. Roles & Access

Access control has **three independent layers**: authentication (who you are),
page access (which pages you can open), and data scoping (which projects/clients'
data you can see).

## 1. Authentication

- **JWT bearer tokens.** On login the server signs a token carrying `id`, `role`,
  `project_access`, `client_access`, and `page_access`. The SPA sends it as
  `Authorization: Bearer …`; the `auth` middleware verifies it and sets `req.user`.
- **Token lifetime:** 8 hours for people; the `sync@egypro.com` account gets a
  **non-expiring** token (see [Integrations & Sync](07-integrations-and-sync.md)).
- **Post-deploy invalidation:** non-sync tokens issued before the server's boot
  time are rejected, so everyone re-logs in after a release (the sync account is
  exempt).
- **Brute-force lockout:** 5 failed logins locks the account for 15 minutes.
- **Idle logout:** the SPA auto-logs-out after inactivity (`AuthContext`).

> Because access arrays are baked into the token at login, **changing a user's
> role or access requires them to log in again** to take effect.

## 2. Page access (`page_access[]`)

Controls which pages a user can open and see in the sidebar.

- The frontend `PageGuard pageKey="…"` blocks a route unless the user's
  `page_access` includes that key; the sidebar hides links the same way.
- **Admins bypass** page access entirely (see everything).
- Managed in the Admin panel per user.

## 3. Data scoping (`project_access[]` / `client_access[]`)

Restricts *which records* a user sees, for the **restricted roles** only:

```
RESTRICTED_ROLES = ehs_officer, ehs_manager, supervisor, scm_officer, project_director
```

`getProjectFilter(user)` / `getClientFilter(user)` resolve to:

| User's access | Result | Meaning |
|---------------|--------|---------|
| Not a restricted role (e.g. `admin`) | `null` | Unrestricted — all data |
| Restricted, holds **all** projects/clients | `null` | Effectively unrestricted |
| Restricted, holds a subset | the list | Limited to those projects/clients |
| Restricted, holds **none** (`[]`) | `[]` | **No data** |

Enforcement helpers:
- `inScope(user, project, client)` — boolean gate for a record.
- `getPersonScope(id)` / `getAuditScope(auditId)` — resolve an employee/casual/
  audit's project & client so out-of-scope reads return **404** and cross-scope
  report requests return **403**.

Every list, report, and detail query applies these filters, so scoping is
enforced server-side, not just hidden in the UI.

## Roles

| Role | Restricted? | Typical responsibilities |
|------|-------------|--------------------------|
| `admin` | No | Everything — user management, page/access config, PPE catalog |
| `ehs_manager` | Yes | Manage audits & NCRs; **Approve (Safety)** |
| `ehs_officer` | Yes | Conduct audits, manage NCRs, raise PPE/tool requests |
| `supervisor` | Yes | Conduct audits within their permitted projects |
| `project_director` | Yes | **Approve (PM)** on items needing PM approval |
| `scm_officer` | Yes | SCM/procurement stages; PPE Request Tracker |

## Service / system accounts

| Account | Purpose |
|---------|---------|
| `sync@egypro.com` | SharePoint/Power Automate sync — non-expiring token, exempt from post-deploy invalidation |
| `eats-sync@egypro.app` | Additional sync/integration account |
| `admin@egypro.com` | Default seeded admin (change its password on first use) |

These are excluded from the normal user lists in the UI.

## Quick reference: where it's enforced

| Layer | Frontend | Backend |
|-------|----------|---------|
| Authenticated | `ProtectedRoute`, `AuthContext` | `auth` middleware |
| Page access | `PageGuard`, sidebar `NAV` roles | (page-level checks on sensitive routes) |
| Data scope | filter chips reflect scope | `getProjectFilter` / `getClientFilter` / `inScope` |
