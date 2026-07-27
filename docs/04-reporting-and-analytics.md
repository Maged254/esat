# 4. Reporting & Analytics

All reporting is **access-scoped**: every query is restricted to the projects and
clients the signed-in user may see (see [Roles & Access](06-roles-and-access.md)).
Metric definitions below are the source-of-truth server calculations.

> **"Audit" vs "request":** an `audits` row with `employee_present = TRUE` is a real
> audit; `employee_present = FALSE` represents a PPE/tool **request** raised when
> the person wasn't present. Several reports split these two.

## Dashboard — `GET /api/dashboard`

| Tile | Definition |
|------|-----------|
| **Total Active Project Members** | `employees` with `employment_status = 'active'` |
| **Overdue (>30 days)** | Active **SAN** employees whose most recent *present* audit is missing or older than 30 days |
| **Open NCRs** | `ncr_items` with `status NOT IN ('resolved','distributed','canceled','exit')` |
| **Compliance rate** | `compliant` ÷ total audits in the **current month** (non-deleted) |
| **PPE delay cards** (EHS / SCM / Suppliers / Projects) | Oldest request currently sitting in that stage, in days: EHS = from `date_flagged` while `pending`; SCM = from `date_purchase_requested` while `ehs_purchase_requested`; Suppliers = from `date_ordered` while `scm_ordered`; Projects = from `date_available` while `warehouse_available`. Only non-terminal requests. |
| **NCRs by PPE/Tool Item per Month** (heatmap) | Top 20 PPE items by NCR count over the last 6 months, counts per month (6 columns, zero-filled), excludes canceled |
| **Recent audits** | Last 5 audits |

## Audit Coverage — `GET /api/audit-coverage`

Scoped to the **SAN** population (`san = TRUE`, active). Supports `project` /
`client` query filters.

| Metric | Definition |
|--------|-----------|
| **Audit rate** | Audited-within-30-days ÷ SAN total |
| **Aging buckets** | `0–30`, `31–60`, `61–90`, `90+` days since last present audit, plus **Never audited** |
| **Overdue (>30d)** | SAN employees never audited or last audited > 30 days ago |
| **Avg days since audit** | Mean days since last present audit |
| **This vs last month** | Distinct SAN employees audited this month vs last month |
| **Resource counts** | SAN / non-SAN × in-house / outsource |
| **By project table** | Per project: SAN Total, Overdue (>30d), **Audited (≤30d)** = Total − Overdue, and % |

## Analytics pages — `GET /api/graphs`

The **Auditor Performance**, **PPE Request Trends**, and **Repeated Requests**
pages are all fed by this single endpoint (scoped, with optional `project`/`client`
query params). It returns:

| Dataset | Meaning | Feeds |
|---------|---------|-------|
| `auditsByAuditor` / `auditsByAuditorProject` | Audits per auditor (and per auditor × project) | Auditor Performance |
| `auditsByMonth` | Per month (6 mo): total, `audits_count` (present) vs `requests_count` (not present) | PPE Request Trends |
| `ncrByMonth` | Per month (6 mo): NCRs `created` vs `resolved` (resolved = `resolved`/`distributed`) | PPE Request Trends |
| `ppeByEmployee` | Top 20 active employees by PPE request count | PPE Request Trends |
| `ppeStageDelays` | Per-pipeline-stage delay in days (EHS→PM→SCM→Supplier→Project), completed and still-open | PPE Request Trends |
| `ppeRepeatedByEmployee` | Employee × item with **>1** request in the last 12 months (excludes canceled), with all flagged dates | Repeated Requests |
| `filterOptions` | Distinct projects/clients within the user's scope | Filter chips |

## NCR stats — `GET /api/ncr/stats`

Powers the NCR List stat cards. `total_open` uses the same exclusion as the
dashboard (`NOT IN ('resolved','distributed','canceled','exit')`); also returns
`pending`, `pending_pm`, and `resolved_this_month`.

## Access scoping (applies to every report)

- `getProjectFilter(user)` / `getClientFilter(user)` return the user's permitted
  projects/clients (or `null` = unrestricted, e.g. admins).
- A user requesting a project/client outside their scope gets **403**; otherwise
  results are silently limited to what they may see.

## Export

- **CSV** — Employees, Audit/Request History, and NCR List each export the
  currently-filtered rows client-side.
- **PDF / image** — analytics pages use `jsPDF` + `html2canvas` to export charts.

## Notes for maintainers
- Month series are generated to a **fixed** set of columns so months with zero
  activity still appear (no gaps) — mirror this when adding new time-series charts.
- Keep "open" definitions consistent with the exclusion list above when adding
  new NCR/request counts, so tiles agree across pages.
