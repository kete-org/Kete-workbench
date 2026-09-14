# Kete Workbench — Enterprise Offering

## Positioning

Enterprise is for organizations that need centralized control over how
their teams use the agent — identity, spend, governance, and
standardization — not just more usage. This sits on top of the core
product; nothing here is a substitute for the affordability-first
individual/team pricing that's central to Kete Workbench's positioning
in the African market. Enterprise pricing should reflect regional
purchasing power the same way individual pricing does — see the pricing
note at the end.

---

## What Kilo Code and Qoder actually ship at Enterprise tier

**Kilo Code Enterprise** (on top of its Teams tier): SSO, OIDC, SCIM,
model and provider restrictions, a shared private gateway, audit logs,
SLA commitments, dedicated support. Model usage is still billed
separately — BYOK and local models remain available even at Enterprise.

**Qoder Enterprise** ($20/seat/month on top of Teams, which itself adds
BYOK, MCP/Skills security controls, and unified plugin management):
shared credit pool, group-based permissions and billing management,
multi-dimensional model policy controls, plugin sharing and deployment
controls, a private enterprise capability marketplace, operation audit
logs, priority support.

Both converge on the same core: **identity, spend control, policy
enforcement, and a private distribution channel for internal tooling.**
That's the shape Kete Workbench's offering should match — the
differentiation is in what's under it (governance-as-chokepoint,
per-tool permissions, African-market cost economics), not in inventing a
different category of enterprise feature.

---

## Kete Workbench Enterprise — feature spec

### Identity & access
- **SSO** (SAML/OIDC) and **SCIM** for automated user provisioning/deprovisioning
- **Group-based permissions** — map org teams/departments to tool-permission profiles (extends the planned per-tool `allow`/`ask`/`deny` model — D-006, a rework of today's risk tiers in `src/vs/platform/governance/` — from per-user to per-group)
- Custom CA certificate support for organizations behind internal proxies (relevant for large-organization/telecom-style enterprise network setups)

### Governance & compliance
- **Operation audit logs** — queryable, exportable, tied to the same audit trail the governance gate already writes to (not a separate compliance system bolted on)
- **Multi-dimensional model policy controls** — restrict which models/providers are usable by team, project, or data sensitivity level (e.g. "no external API calls for this repo," enforced structurally, not just by convention)
- **Security controls over MCP and Skills** — an admin defines which MCP servers and skills are installable org-wide, closing the "any developer can install any skill" gap in the base product
- **Data residency controls** — inherited from the existing roadmap item, now exposed as an admin-configurable policy rather than a build-time constraint

### Spend & model management
- **Shared credit/spend pool** across the org, with per-team or per-project budget allocation
- **Centralized billing** — one invoice, not per-seat card charges
- **Private model gateway** — org-hosted routing layer (this is where the earlier OmniRoute-style gateway integration becomes an enterprise-tier feature specifically, not a general-availability one)

### Standardization & distribution
- **Plugin/skill management and distribution** — admins push a standardized set of skills, hooks, rules, and MCP connectors to every developer's install, versioned and pinned (this is the existing "versioned/pinned team skill packs" roadmap item, formalized as an Enterprise-tier admin capability)
- **Private enterprise capability marketplace** — an org-internal skill/template marketplace, separate from the public one, for proprietary internal tooling (an org's own internal API integrations, for example) that should never leave the organization

### Support
- **SLA commitments** and **priority/dedicated support** — standard enterprise expectation, not a differentiator, but table stakes to be credible in this tier

---

## What Kete Workbench should NOT just copy

- Neither competitor's Enterprise tier includes anything resembling the **governance gate as an architectural chokepoint** — their audit logs are bolt-on compliance features; Kete Workbench's is structural from Tier 0. Lead with this in enterprise sales conversations — it's a real, defensible difference, not marketing language.
- Neither ties pricing to regional purchasing power. A flat $20/seat/month Enterprise add-on (Qoder's figure) is a rounding error for a Silicon Valley buyer and a real barrier for a mid-size African enterprise. Kete Workbench's Enterprise pricing should follow the same local-currency, purchasing-power-adjusted approach as the individual tier — otherwise the Enterprise tier quietly abandons the core positioning the whole product is built on.

---

## Pricing note

Don't default to per-seat USD pricing modeled directly on Kilo/Qoder's
figures. Structure options worth evaluating:
- Local-currency Enterprise pricing, scaled to regional benchmarks the
  same way the consumer tiers are
- Credits/spend-pool model (matches both competitors) but priced against
  African cloud/compute cost realities, not US-market assumptions
- Consider a reduced or waived Enterprise platform fee for
  telecom/gov/education sector clients in-region, recovering margin on
  model usage instead.
