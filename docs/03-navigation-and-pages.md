# 3. Navigation & Pages

Routes are defined in **`App.jsx`**; the sidebar is defined by the `NAV` array in
**`components/Layout.jsx`**. Most routes are wrapped in a `PageGuard`
(`pageKey`) that enforces per-user page access — see
[Roles & Access](06-roles-and-access.md).

## Sidebar structure

The sidebar groups pages into sections:

```
Overview      Dashboard · Audit Coverage · Auditor Performance ·
              PPE Request Trends · Repeated Requests
Resources     Employees · Casuals
Operations    New Audit · Request a PPE/Tool
Trackers      Audit/Request History · NCR List · PPE Request Tracker
Admin         Admin Panel · My Profile
```

A section header only renders if the user's role is included in that section's
`roles`; individual links additionally require the page in the user's
`page_access` (admins bypass this).

## Pages

### Overview

| Page | Route | Component | Purpose |
|------|-------|-----------|---------|
| **Dashboard** | `/` | `DashboardPage` | Management KPIs — active members, overdue (>30d), open NCRs, compliance rate; PPE pipeline delay cards; "NCRs by PPE/Tool Item per Month" heatmap |
| **Audit Coverage** | `/audit-coverage` | `AuditCoveragePage` | SAN audit coverage — resource stat cards, audit rate, aging timeline, and a By-project table |
| **Auditor Performance** | `/audits` | `AuditsPage` | Per-auditor activity and metrics |
| **PPE Request Trends** | `/requests` | `RequestsPage` | Trends in PPE/tool requests over time |
| **Repeated Requests** | `/repeat-requests` | `RepeatRequestsPage` | Employees/items with repeat requests |

### Resources

| Page | Route | Component | Purpose |
|------|-------|-----------|---------|
| **Employees** | `/employees` | `EmployeesPage` | Employee list + filters; PPE assignment, SAN toggle, CSV import/export (admin) |
| **Casuals** | `/casuals` | `CasualsPage` | Casual-worker roster |

### Operations

| Page | Route | Component | Purpose |
|------|-------|-----------|---------|
| **New Audit** | `/audit/new`, `/audit/new/:employeeId` | `NewAuditPage` | Conduct a safety audit against an employee's assigned PPE/tools |
| **Request a PPE/Tool** | `/request-ppe` | `RequestPPEPage` | Raise a PPE/tool request (employees and casual tables) |

### Trackers

| Page | Route | Component | Purpose |
|------|-------|-----------|---------|
| **Audit/Request History** | `/history` | `AuditHistoryPage` | All audits with filters (name, national ID, status, resource, project, client, auditor) + CSV export |
| **NCR List** | `/ncr` | `NCRPage` | Open NCR items and their pipeline; bulk approvals (Safety / PM); Exit vs Canceled distinction |
| **PPE Request Tracker** | `/ppe-tracker` | `PPERequestTrackerPage` | The PPE request pipeline (EHS → PM → SCM → warehouse → distribution) |

### Admin

| Page | Route | Component | Purpose |
|------|-------|-----------|---------|
| **Admin Panel** | `/admin` | `AdminPage` | User management, page/role access, PPE configuration (admin only) |
| **My Profile** | `/profile` | `ProfilePage` | Profile, password change, profile picture |

## Routes not in the sidebar

| Route | Component | Notes |
|-------|-----------|-------|
| `/login` | `LoginPage` | Unauthenticated |
| `/safety-commitment` | `SafetyCommitmentPage` | Safety commitment acknowledgement |
| `/audits/:auditId` | `AuditDetailPage` | Read a single audit (linked from lists) |
| `/purchase-requests` | `PurchaseRequestsPage` | Not `PageGuard`-wrapped |
| `*` | → redirect to `/` | Catch-all |

## Access & auth wrappers

- `ProtectedRoute` — requires a valid session; otherwise redirects to `/login`.
- `Layout` — the authenticated shell (sidebar + `<Outlet/>`).
- `PageGuard pageKey="…"` — blocks the page unless the user's `page_access`
  includes it (admins bypass). Details in [Roles & Access](06-roles-and-access.md).
