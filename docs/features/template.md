# Feature: <Name>

> Copy this file to `docs/features/<feature-slug>.md` and fill it in before writing
> code. Delete any section that genuinely doesn't apply — don't leave placeholders.
> This doc is the feature-specific counterpart to the general skills in
> `docs/skills/` (`go-backend`, `postgres`, `htmx-ui`, `tailwind-ui`); it should not
> repeat their content, only reference decisions those skills leave open.

## Status

`Proposed | In Progress | Shipped | Deprecated`

## Summary

One or two sentences: what this feature does and why it exists.

## Problem / Motivation

What gap or need this addresses. What happens if it isn't built.

## Scope

**In scope:**

*

**Out of scope:**

*

---

## User Flow

Walk through the interaction as the user experiences it, step by step. Prose or a
numbered list — enough that someone unfamiliar with the feature can picture it.

```text
1. User navigates to ...
2. User clicks ...
3. Page shows ...
```

---

## UI

Pages and components involved, and where they live in `web/templates/`.

```text
web/templates/
├── pages/
│   └── <page>.html
└── components/
    └── <component>.html
```

States this feature's UI must handle (see `tailwind-ui` for the full state list):

| State    | Behavior |
| -------- | -------- |
| Default  |          |
| Loading  |          |
| Empty    |          |
| Error    |          |
| Success  |          |

---

## HTMX Interactions

Every interactive element that issues an HTMX request. See `htmx-ui` for the
underlying conventions (ID naming, fragment vs. full-page rendering, OOB swaps).

| Trigger              | Method | Endpoint              | Target        | Swap        | Indicator |
| --------------------- | ------ | ---------------------- | ------------- | ----------- | --------- |
| e.g. "Wake" button    | POST   | `/devices/{id}/wake`   | `#device-123` | `outerHTML` | local     |

Confirmation required for destructive actions:

*

---

## Routes / Handlers

| Method | Path                  | Handler          | Auth required | Notes |
| ------ | ---------------------- | ----------------- | ------------- | ----- |
| GET    | `/devices`             | `DeviceHandler.List` | yes        |       |
| POST   | `/devices/{id}/wake`   | `DeviceHandler.Wake`  | yes        |       |

---

## Data Model

New or changed tables/columns. Reference the migration file(s) once written — see
`postgres` for naming conventions and migration tooling (`goose`).

```sql
-- migrations/0xx_<description>.sql
```

| Table  | Column | Type | Constraints | Notes |
| ------ | ------ | ---- | ----------- | ----- |
|        |        |      |             |       |

---

## Business Rules / Validation

Rules enforced beyond basic type/shape validation — the things a reviewer would
otherwise have to reverse-engineer from the code.

*

---

## Security Considerations

* **Authz**: who is allowed to trigger this, and where is it enforced?
* **Destructive actions**: confirmation required? (see `htmx-ui`)
* **Input handling**: anything beyond standard parameterized queries / escaping?
* **Secrets**: does this feature introduce new config/secrets? (see `go-backend`)

---

## Testing Plan

What must be covered before this ships — not a restatement of the general test
practices in `go-backend`/`postgres`, just what's specific to this feature.

* [ ]
* [ ]

---

## Open Questions

Unresolved decisions. Remove this section once none remain.

*

---

## Definition of Done

* [ ] User flow works end-to-end, including edge cases above.
* [ ] All states in the UI table are implemented (loading/empty/error/success).
* [ ] Destructive actions require confirmation.
* [ ] Migration written, reviewed, and includes a working `Down`.
* [ ] Handler/service/repository boundaries followed (`go-backend`).
* [ ] Accessibility checked (keyboard, focus, contrast, semantic HTML).
* [ ] Tests cover the behavior in the Testing Plan above.
* [ ] No open questions remain unresolved.
