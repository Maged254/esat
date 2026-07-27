# 2. Design System / Theme

The visual system lives in **`src/index.css`** (frontend repo) as CSS custom
properties plus a set of utility/component classes. Prefer these tokens and
classes over ad-hoc inline styles so pages stay consistent.

## Color tokens

### Brand & semantic

| Token | Value | Use |
|-------|-------|-----|
| `--eg-green` / `--eg-green-dark` | `#1D9E75` / `#0F6E56` | Primary brand, success, "good" |
| `--eg-navy` / `--eg-navy-dark` | `#0C447C` / `#042C53` | Headings, primary accent, selected outlines |
| `--eg-navy-light` | `#E6F1FB` | Navy tint (tags, badges) |
| `--danger` / `--danger-light` | `#E24B4A` / `#FCEBEB` | Errors, overdue, non-compliant |
| `--warning` / `--warning-light` | `#EF9F27` / `#FAEEDA` | Pending, partial |

### Neutrals

| Token | Value |
|-------|-------|
| `--bg` | `#f9fafb` (default page background) |
| `--surface` | `#ffffff` (cards) |
| `--text-primary` / `--text-secondary` / `--text-tertiary` | `#111827` / `#6b7280` / `#9ca3af` |
| `--border` | `0.5px solid #e5e7eb` |

### Workflow palette (PPE request pipeline stages)

Used across the PPE request / tracker views to color the four pipeline owners.

| Stage | Color | Light | Token prefix |
|-------|-------|-------|--------------|
| EHS | `#2563EB` | `#EFF6FF` | `--wf-ehs*` |
| PM (Project Manager) | `#BE185D` | `#FDF2F8` | `--wf-pm*` |
| SCM | `#048660` | `#ECFDF5` | `--wf-scm*` |
| Projects | `#BB5A08` | `#FFF7ED` | `--wf-projects*` |

Each has `-light` and `-gradient` variants, plus shared `--wf-shadow-rest`,
`--wf-shadow-hover`, `--wf-radius: 10px`, `--wf-transition: 200ms ease`.

## Highlight & surface conventions

These are project conventions applied consistently across list/report pages:

| Element | Style |
|---------|-------|
| **Report/list page background** | `#EEF1F7` via the `graphs-content` class (also gives cards a soft shadow and removes borders) |
| **Selected/active stat card** | Fill `#F0F7FF` + `outline: 2px solid #042C53` (navy) |
| **Table row hover** | `table-hover-soft` → `#F0F7FF` (soft blue). Also available: `table-hover-blue` → `#E3F2FD`; default (no class) → `#f9fafb` gray |
| **Value cards** | White (`.card`), not the legacy gray `.stat-card` |

```jsx
// Selected stat card pattern
<div className="card" style={{
  cursor:'pointer', padding:'16px 18px',
  background: active ? '#F0F7FF' : '#fff',
  outline:    active ? '2px solid #042C53' : '',
}} />
```

## Layout tokens

| Token | Value |
|-------|-------|
| `--sidebar-w` | `230px` |
| `--header-h` | `56px` (used as sticky offset for filter bars) |
| `--radius-md` / `--radius-lg` | `8px` / `12px` |

## Components

### Cards
- `.card` — white surface, rounded (`--radius-lg`), bordered. On `graphs-content`
  pages the border is dropped and a shadow added.
- `.card-header` / `.card-title` / `.card-body` — standard header row + body
  padding.
- `.pulse-card` — adds a lift-on-hover transition.

### Stat values
- `.stat-label` — small muted caption.
- `.stat-value` — 26px/500 number; color modifiers `.navy` `.green` `.danger`
  `.warning`. (Audit Coverage uses an enlarged 40px/800 treatment with the
  secondary breakdown stacked to the right.)

### Tags

| Class | Background / Text | Typical use |
|-------|-------------------|-------------|
| `.tag-green` | `#EAF3DE` / `#3B6D11` | Compliant, distributed, resolved, active |
| `.tag-red` | `#FCEBEB` / `#A32D2D` | Non-compliant, canceled, issues |
| `.tag-amber` | `#FAEEDA` / `#854F0B` | Partial, flagged/pending |
| `.tag-navy` | `#E6F1FB` / `#0C447C` | In-progress pipeline states |
| `.tag-teal` | `#E1F5EE` / `#0F6E56` | Warehouse available |
| `.tag-gray` | `#F1EFE8` / `#5F5E5A` | Exit, neutral |
| `.tag-purple` | `#EDE9FE` / `#6D28D9` | Misc category |

### Filter bar (Search / Filter card)

The standard list-page filter is a sticky card with two labeled rows — **Search**
(text inputs) and **Filter** (dropdowns) — used on Employees, Casuals, Audit
Coverage, Audit/Request History, and NCR List. Controls are
`height:30, padding:'4px 8px', fontSize:12`.

```jsx
<div className="card" style={{ position:'sticky', top:'var(--header-h)', zIndex:40 }}>
  <div className="card-body" style={{ display:'flex', flexDirection:'column', gap:14 }}>
    <div /* Search row: label + inputs */ />
    <div /* Filter row: label + selects + Clear */ />
  </div>
</div>
```

### Buttons
- `.btn` (default), `.btn-navy` / `.btn-primary` (navy fill), `.btn-sm` (compact,
  used by pagination).

### Forms
- `.form-input`, `.form-select` — shared field styling.

### Sidebar & profile chip
- `.sidebar` (dark navy `--eg-navy-dark`), `.nav-section` (section header),
  `.nav-item` (link, `.active` state).
- `.user-chip` — footer profile card: gradient surface, rounded, hover lift;
  contains a 64px avatar (white ring + shadow) stacked above `.user-name` /
  `.user-role`. See [Navigation & Pages](03-navigation-and-pages.md).

## Typography
- Base: system font stack, 14px, `--text-primary`.
- Headings/titles use `--eg-navy`; captions use `--text-secondary`/`-tertiary`.

## Conventions
- Reach for a **token or class** before an inline hex value; if you must inline,
  reuse the values above so light/greys stay consistent.
- New selectable cards and hoverable tables should use the **`#F0F7FF`**
  highlight + `table-hover-soft` to match the rest of the app.
