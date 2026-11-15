# Datarails: what it does, and what we would build to match it

Gathered on 15 November 2026 from public material only: Datarails' product pages, blog and pricing page, its press
releases and the trade press, the public directory listings of its MCP connector, search-engine snippets of its support
centre, G2, Capterra and competitor write-ups, Datarails job posts, and the LICENSE files of the open-source projects
in section 6 (read through the GitHub API on 15 November 2026). Nobody signed up, logged in, asked for a demo or
filled in a form.

The aim is to build an original product with the same capabilities. We copy capabilities and workflows, never
Datarails' code, brand, UI, text or any non-public material.

**How sure each claim is.** Every claim carries a tag and a link:

- **[D]** Documented by Datarails: a product page, blog post, pricing page, press release or support article.
- **[S]** A support-centre article that we read only as a search-engine snippet. `support.datarails.com` returns 403
  to direct fetches (it did on 14 November and again today), so we have the indexed text, not the page. Treat these
  as documented but partial.
- **[R]** Reported by a third party: the press, a directory, a review site or a competitor. Competitor sources are
  named as such.
- **[I]** Our inference. It is not stated anywhere.

Our earlier research on this is in [`../research.md`](../research.md) (OpenCost and FOCUS), [`../datarails.md`](../datarails.md)
(the connector and `fake-datarails`) and the 14 November proposal *Land for Finance Teams*.

---

## Summary

1. **FinanceOS is the product; everything else is a module on it.** Datarails launched FinanceOS on about 10 March 2026
   as a governed finance data layer between a company's systems and AI tools
   ([Fortune](https://fortune.com/2026/03/10/datarails-aims-disrupt-itself-ai-financeos-didi-gurfinkel/),
   [Datarails](https://www.datarails.com/blog/financeos-connects-data-to-ai/)) [D]. FP&A, Month-End Close, Cash,
   Spend, Desk and the AI Connector sit on it ([platform page](https://www.datarails.com/financeos-platform/)) [D].
2. **The data model is files, then tables, then metrics.** Data arrives as versioned files in *Fileboxes*, tagged by
   scenario, date, status and budget cycle. A *Data Mapper* turns each file into rows of a target table, such as
   *Financials*. A *Semantic Layer* defines dimensions and base and calculated metrics on those tables [S]. This is
   the part we must copy most closely.
3. **Excel is the working surface, not a feature.** `DR.GET` formulas read single figures. Data tables, dynamic ranges
   and drill-down read from the database. *Submit* writes a sheet back to a Filebox as a draft or final version. A
   native Google Sheets version shipped on 1 October 2026 [S][D].
4. **Planning uses forecast cycles and budget cycles.** Forecast cycles are tagged like `1+11` and `0+12`; budget
   cycles are tagged like *Top-Down* or *V1*. A budget cycle can seed a forecast. Department templates are split
   among contributors and go through approvals [S][D]. We found no published driver-based engine: the drivers live in
   the customer's own Excel [I].
5. **Consolidation is described but not shown.** Datarails documents multi-entity consolidation, FX translation,
   intercompany eliminations and allocations, and mappings keyed by account and entity. We found no public account of
   how the rate tables and elimination rules work [D].
6. **The AI is many named agents on one governed layer.** FP&A Genius (2023) and Storyboards came first. Strategy,
   Planning and Reporting agents followed in January 2026, running on Azure OpenAI. Close has a *Flux Analysis* agent
   that quantifies movements and drafts the explanation for a person to review. Spend Control has a renewal agent and
   Desk an agent that drafts replies [D][R].
7. **The MCP server has 24 tools, all read-only.** It is per-user OAuth with PKCE, every call is checked against the
   user's role and groups, and it is a paid add-on. Aggregations are asynchronous: start one, then fetch the result
   ([Hackceleration listing](https://hackceleration.com/resources/integrations/claude/datarails-financeos),
   [Agentman](https://agentman.ai/agentskills/connections/mcp-server/datarails-financeos)) [R]. The only write path
   is the DGS file upload, with Basic auth as a sync user that cannot have MFA [R].
8. **Spend (October 2026) is close to Landledger's approvals.** A request is checked against the live budget, routed,
   becomes a PO that creates a commitment, and is matched to invoices and contracts. Cards and bill pay come with it
   ([CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/10/16/datarails-rolls-out-end-to-end-spend-management-product/191837/))
   [R].
9. **Reviewers praise the Excel workflow and the support.** Datarails rates 4.6–4.7 out of 5 on G2 and Capterra, with
   4.8 for support. The recurring complaints are slow refresh on large workbooks, heavy setup and mapping, a learning
   curve, proprietary formulas, mapper changes that don't reach existing reports, and opaque pricing [R].
10. **The stack, from job posts:** Python and Django, Angular, Azure, Docker and Kubernetes, Airflow or Dagster,
    Spark, and a monolith being split into services. The Excel add-in is moving from COM to Office.js [R].
11. **No credible open-source FP&A planning product exists.** GitHub and OpenAlternative show toy projects only. We
    would build the planning core ourselves, from permissive parts.
12. **The permissive parts are good.** Univer (Apache-2.0) for the web grid and formulas, Microsoft's Office.js
    samples and custom-functions template (MIT) for the Excel add-in, Perspective (Apache-2.0) for pivots, Cube.dev or
    MetricFlow (Apache-2.0) as models for the semantic layer, and TigerBeetle (Apache-2.0) or Formance Ledger (MIT) as
    models for double entry and commitments.
13. **Avoid these for code reuse:** HyperFormula (GPLv3 or commercial), Beancount (GPL-2.0), hledger, ERPNext (GPL-3.0),
    the OCA Odoo modules and Metabase (AGPL-3.0), Mondrian, which is now BSL 1.1, and Akaunting (BSL). Odoo itself is
    LGPL-3.0, and its consolidation and budget modules aren't in the community repository.
14. **Landledger already has about a third of the work.** It has periods and the close, approvals and reservations,
    budgets with versions, a driver forecast, allocations, accruals, variance notes, anomalies, contracts, the audit
    chain, Landbright identity and an MCP server. It lacks a general ledger data layer, the mapper, a semantic layer,
    an Excel add-in, entities and FX, and cash.
15. **The recommended order** is: the data layer and uploads, then the mapper and chart of accounts, then the semantic
    layer with read MCP tools, reporting, the Excel add-in, planning, consolidation, then extending the close, spend,
    cash and the agents. The full order is in section 7.

---

## 1. Feature inventory per product

### 1.1 FinanceOS: the data layer

| Capability | What we know | Source | Sure |
|---|---|---|---|
| Positioning | A governed finance data layer that connects company data to AI tools; launched about 10–12 March 2026, operational in days | [Fortune](https://fortune.com/2026/03/10/datarails-aims-disrupt-itself-ai-financeos-didi-gurfinkel/), [IT Brief UK](https://itbrief.co.uk/story/datarails-unveils-financeos-to-power-ai-driven-finance), [blog](https://www.datarails.com/blog/financeos-connects-data-to-ai/) | D |
| Layers | Connectors → consolidation (eliminations, allocations, FX) → semantic layer (business definitions) → governance (role permissions, audit logs) → finance MCP server | [How a finance OS works](https://www.datarails.com/how-does-finance-operating-system-work/) | D |
| Connectors | 600+ sources (ERP, CRM, HRIS, banks, billing, spreadsheets); older pages say 200+ | [platform](https://www.datarails.com/financeos-platform/), [VentureBeat](https://venturebeat.com/data/cfos-are-now-getting-their-own-vibe-coding-moment-thanks-to-datarails) | D / R |
| Fileboxes | Containers of versions of files that share one structure, told apart by tags | [Filebox Overview](https://support.datarails.com/hc/en-us/articles/13813197730332) | S |
| Data Mapper | Turns unstructured source data into a structured table; choose a table, set source and target lookups, add custom fields; *Publish & Scan* rescans; *Publish & Apply to* reuses a mapper on other Fileboxes; a library of mapper templates with predefined fields | [Creating a new Data Mapper](https://support.datarails.com/hc/en-us/articles/14445024642204-Creating-a-new-Data-Mapper), [Data Mapper exercise](https://support.datarails.com/hc/en-us/articles/11711103284765) | S |
| Semantic Layer | Metrics defined once (Revenue, Gross Margin, Headcount, ARR, DSO); dimensions mapped to a column in each table; base metrics from a table, calculated metrics from other metrics in a Formula Builder; editing a metric changes it for every consumer; a dimension in use can't be deleted; Data Manager role or above to edit | [Semantic Layer overview](https://support.datarails.com/hc/en-us/articles/27013655982364-Semantic-Layer-overview), [Managing dimensions](https://support.datarails.com/hc/en-us/articles/27116614757916-Managing-dimensions), [Creating a base metric](https://support.datarails.com/hc/en-us/articles/27084938329244-Creating-a-base-metric) | S |
| Calculated values | Derived metrics stored with a table; built-in ones ship for the *Financials* table; usable in reports, the Report and Budget Builder and dashboards | [Calculated Values](https://support.datarails.com/hc/en-us/articles/14719253554460-Calculated-Values) | S |
| Real-time refresh | Data refreshes across systems within seconds of a source update (vendor claim) | [blog](https://www.datarails.com/blog/financeos-connects-data-to-ai/) | D (claim) |
| Security | SOC 2 Type II, GDPR | [blog](https://www.datarails.com/blog/financeos-connects-data-to-ai/) | D |

### 1.2 FP&A: planning

| Capability | What we know | Source | Sure |
|---|---|---|---|
| Budgeting | Central budget cycles with templates split by department, contributor input and built-in approval workflows. The Budget Module is off by default. Budget files come from the Budget Builder, the Template Library or an upload | [Planning page](https://www.datarails.com/solutions/planning-budgeting-forecasting/), [Budget Module](https://support.datarails.com/hc/en-us/articles/21955841347740-Budget-Module) | D / S |
| Forecasting | Forecast cycles tagged `1+11`, `0+12` and so on; a forecast is rolled forward; a budget cycle can seed a forecast cycle; role-limited | [Planning Overview](https://support.datarails.com/hc/en-us/articles/18024691753756-Planning-Overview), [Forecast Module](https://support.datarails.com/hc/en-us/articles/18080787149980-Forecast-Module) | S |
| Rolling forecasts | Rolling forecasts update automatically; payroll and HRIS actuals replace completed periods while the approved budget is kept apart | [Planning page](https://www.datarails.com/solutions/planning-budgeting-forecasting/), [headcount blog](https://www.datarails.com/blog/fpa-software-headcount-workforce-planning/) | D |
| Scenarios | Scenario modelling; cycles cloned into new scenarios; managed comparisons that avoid uncontrolled workbook copies; a reopen of a locked cycle is implied | [Planning page](https://www.datarails.com/solutions/planning-budgeting-forecasting/), [versions blog](https://www.datarails.com/blog/fpa-software-budget-versions-scenarios/) | D |
| Headcount | A plannable metric. Datarails' guidance keeps the headcount model in Excel or Sheets, linked to the HRIS roster, payroll actuals and posted GL cost | [Planning page](https://www.datarails.com/solutions/planning-budgeting-forecasting/), [headcount blog](https://www.datarails.com/blog/fpa-software-headcount-workforce-planning/) | D |
| Driver-based planning | Not on the product pages. Their Excel guide describes drivers (headcount, units) inside the workbook | [Excel guide](https://www.datarails.com/blog/budgeting-and-forecasting-in-excel-guide/) | D (guide only); I: no engine |
| Budget vs actual | Through reports and dashboards; cited in testimonials. The Planning module in the Office.js add-in needs at least 12 month columns | [Planning page](https://www.datarails.com/solutions/planning-budgeting-forecasting/), [Planning Module in Office JS](https://support.datarails.com/hc/en-us/articles/29884905794076) | D / S |
| Named ranges | `DR_scenario`, `DR_scenario_cycle`, `DR_prev_scenario_cycle`, `DR_planning_scenario` and `DR_tag_date` give a workbook its context; the file must be connected to a Filebox | [Planning: Named Ranges](https://support.datarails.com/hc/en-us/articles/19366628940700-Planning-Named-Ranges) | S |
| Entry points | Excel desktop or web, Google Sheets (Contributors in beta for submissions), the web app | [versions blog](https://www.datarails.com/blog/fpa-software-budget-versions-scenarios/) | D |

### 1.3 Consolidation

| Capability | What we know | Source | Sure |
|---|---|---|---|
| Multi-entity | The same process for 2 or 20 subsidiaries; drill-down from consolidated to entity | [Consolidation](https://www.datarails.com/solutions/consolidation/) | D |
| FX | Currency translation. The MCP's `get_currency_rates` returns a USD-based rate snapshot; Cash applies daily rates | [Consolidation](https://www.datarails.com/solutions/consolidation/), [connector listing](https://hackceleration.com/resources/integrations/claude/datarails-financeos), [Cash](https://www.datarails.com/products/cash/) | D / R |
| Average vs closing | Their blog advises closing rates for assets and liabilities, transaction-date rates for income and expense (a period average where it approximates them), one rate provider loaded into every report, someone approving the rate table each month, and intercompany reconciled by counterparty before consolidating | [Consolidate multiple ERPs](https://www.datarails.com/blog/consolidate-multiple-erps-without-migrating/) | D (guidance); I: that the product works this way |
| Eliminations | Intercompany eliminations; rules defined once and applied every close; intercompany matching with an audit trail | [Consolidation](https://www.datarails.com/solutions/consolidation/), [AI close blog](https://www.datarails.com/blog/ai-powered-month-end-close/) | D |
| Allocations | Named on the platform page and in the architecture article; no public detail | [platform](https://www.datarails.com/financeos-platform/), [How a finance OS works](https://www.datarails.com/how-does-finance-operating-system-work/) | D (name only) |
| Mapping | Data Mapper imports, for example, a NetSuite GL export, standardises across entities, currencies, formats and eliminations, and writes the *financials* table | [Consolidation](https://www.datarails.com/solutions/consolidation/) | D |

### 1.4 Month-End Close and the Flux Analysis agent

| Capability | What we know | Source | Sure |
|---|---|---|---|
| Checklist and tasks | Step-based, customisable checklists; owners and deadlines; manual and system tasks | [Close](https://www.datarails.com/products/close/) | D |
| Reconciliations | Automated matching across accounts, entities and systems; only exceptions go to reviewers | [Close](https://www.datarails.com/products/close/), [AI close blog](https://www.datarails.com/blog/ai-powered-month-end-close/) | D |
| Sign-off and audit | Built-in sign-off; full change log; supporting documents stored centrally; version history | [Close](https://www.datarails.com/products/close/) | D |
| Flux Analysis agent | One of the close's *Inflow Agents*. It quantifies reconciliation movements and drafts the explanation, which a person reviews | [What can AI do in FP&A](https://www.datarails.com/blog/what-can-ai-do-in-fpa/) | D |
| Flux method | Pull actuals mapped to one chart of accounts; learn each account's normal pattern; flag movements beyond thresholds set per account type, cost centre and entity; compare with budget and the prior period; name the drivers; draft a narrative; flag items for a person | [AI close blog](https://www.datarails.com/blog/ai-powered-month-end-close/) | D (described as a method) |
| Materiality | A competitor's comparison says the agent flags anomalies against your materiality thresholds and drills into the P&L and balance sheet | [DOKKA comparison](https://dokka.com/datarails-vs-floqast-vs-dokka/) (competitor) | R |
| Other close AI | AI-suggested accruals from history; journal-entry flagging; a predicted close date from open items | [AI close blog](https://www.datarails.com/blog/ai-powered-month-end-close/) | D |
| People decide | AI drafts entries, ranks variances and drafts commentary; people accept, post entries, sign board packs and own the explanations | [What can AI do in FP&A](https://www.datarails.com/blog/what-can-ai-do-in-fpa/) | D |

### 1.5 Cash management and AR

| Capability | What we know | Source | Sure |
|---|---|---|---|
| Bank data | Live sync of bank accounts, credit cards and crypto wallets across entities | [Cash](https://www.datarails.com/products/cash/) | D |
| Cash forecasting | From inflows, outflows and GL data; scenario analysis; daily FX conversion | [Cash](https://www.datarails.com/products/cash/) | D |
| Drill-down | Any figure to its transactions; live numbers in Excel | [Cash](https://www.datarails.com/products/cash/) | D |
| Setup | 2–3 weeks after the bank connection, with a dedicated support manager | [Cash](https://www.datarails.com/products/cash/) | D |
| Receivables | A *Receivables* module is listed in the Expert plan. AR agents are named as a use case. We found no public description of either | [pricing](https://www.datarails.com/pricing/), [blog](https://www.datarails.com/blog/financeos-connects-data-to-ai/) | D (name only) |

### 1.6 Spend: requests, POs and commitments

| Capability | What we know | Source | Sure |
|---|---|---|---|
| Requests against the budget | Staff request against the live budget; the owner and Finance see budget, committed and remaining before approving. The page shows an example of a request against a budget line with its committed amount | [Spend](https://www.datarails.com/products/spend/), [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/10/16/datarails-rolls-out-end-to-end-spend-management-product/191837/) | D / R |
| Routing | An approvals panel with owner and Finance steps; routing rules aren't described | [Spend](https://www.datarails.com/products/spend/) | D |
| POs and commitments | Approved requests become POs that create commitments against the plan; the commitment stays linked through contract, invoice, payment and reconciliation | [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/10/16/datarails-rolls-out-end-to-end-spend-management-product/191837/) | R |
| Invoices and bills | Invoices captured, coded and matched to POs and contracts; mismatches flagged; bills scheduled for payment | [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/10/16/datarails-rolls-out-end-to-end-spend-management-product/191837/), [Spend](https://www.datarails.com/products/spend/) | R / D |
| Cards | Physical and virtual cards with controls; transactions coded automatically | [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/10/16/datarails-rolls-out-end-to-end-spend-management-product/191837/) | R |
| Spend Control (Feb 2026) | A contract hub, duplicate-subscription detection, renewal and expiry alerts, contract terms reconciled to payments; an agent reviews terms, benchmarks alternatives and drafts renewal requests | [Pulse 2.0](https://pulse2.com/datarails-launches-spend-control-to-eliminate-zombie-subscriptions/) | R |
| ERP | Spend reconciles to the ERP | [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/10/16/datarails-rolls-out-end-to-end-spend-management-product/191837/) | R |

### 1.7 Reporting: dashboards, Storyboards, board packs

| Capability | What we know | Source | Sure |
|---|---|---|---|
| Reports | P&L, balance sheet, cash flow and custom reports; department budget reports | [FP&A](https://www.datarails.com/products/fpa/) | D |
| Dashboards | Refreshed on demand or on a schedule; no design or code. Excel ranges are published to dashboards as *Embedded Ranges* (formerly *Published Ranges*) and are edited in Datarails, not Excel | [FP&A](https://www.datarails.com/products/fpa/), [Dashboards Embedded Ranges](https://support.datarails.com/hc/en-us/articles/20186867779996-Dashboards-Embedded-Ranges) | D / S |
| Storyboards | Turns dashboard widgets into slides; data stays live; slideshow or PDF export; launched July 2023 | [Storyboards overview](https://support.datarails.com/hc/en-us/articles/10679934480284-Storyboards-overview), [Genius release](https://prnewswire.com/news-releases/datarails-announces-full-rollout-of-fpa-genius-the-chatgpt-for-the-cfos-office-301880753.html) | S / D |
| Board packs | Agents produce PowerPoint, PDF or Excel from a question; first-draft board packs that a person signs | [VentureBeat](https://venturebeat.com/data/cfos-are-now-getting-their-own-vibe-coding-moment-thanks-to-datarails), [What can AI do in FP&A](https://www.datarails.com/blog/what-can-ai-do-in-fpa/) | R / D |
| Insights | Scheduled AI summaries sent to chosen recipients | [Datarails AI](https://www.datarails.com/platform/ai/) | D |
| Mobile | A mobile app | [platform](https://www.datarails.com/financeos-platform/) | D |

### 1.8 Genius and the AI agents

| Agent or feature | What it does | Source | Sure |
|---|---|---|---|
| FP&A Genius (July 2023) | Chat over budgets, forecasts, variance and spend, with charts and draft slides | [press release](https://prnewswire.com/news-releases/datarails-announces-full-rollout-of-fpa-genius-the-chatgpt-for-the-cfos-office-301880753.html) | D |
| Strategy, Planning, Reporting agents (January 2026, with the $70M Series C) | Strategy weighs options; Planning does ad-hoc forecasts and what-ifs; Reporting explains actuals. All produce PowerPoint, PDF or Excel. They run on Azure OpenAI | [Datarails AI](https://www.datarails.com/platform/ai/), [VentureBeat](https://venturebeat.com/data/cfos-are-now-getting-their-own-vibe-coding-moment-thanks-to-datarails), [CFO Dive](https://www.cfodive.com/news/finance-tech-firm-datarails-raises-70m-rolls-ai-agents/810174/) | D / R |
| Flux Analysis agent | See 1.4 | [blog](https://www.datarails.com/blog/what-can-ai-do-in-fpa/) | D |
| Renewal agent | See Spend Control in 1.6 | [Pulse 2.0](https://pulse2.com/datarails-launches-spend-control-to-eliminate-zombie-subscriptions/) | R |
| Desk (September 2026) | A ticketing system for finance: one owner per request from intake to close; the agent gathers the invoices, payments and contracts behind a request and drafts a reply a person sends; team permissions; an immutable audit trail | [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/09/10/datarails-unveils-ticketing-system-for-finance-teams/190032/), [Desk](https://www.datarails.com/products/desk) | R / D |
| FinanceOS AI Connector | The MCP server, for Claude, ChatGPT, Copilot, Cursor and others; see 2.6 | [blog](https://www.datarails.com/blog/financeos-connects-data-to-ai/) | D |
| Custom agents | Professional services design agents for a customer | [blog](https://www.datarails.com/blog/financeos-connects-data-to-ai/) | D |
| Write-back | The architecture article says agents need scoped credentials and an approval gate before writing to source systems; write tools are on the roadmap | [How a finance OS works](https://www.datarails.com/how-does-finance-operating-system-work/), [Agentman](https://agentman.ai/agentskills/connections/mcp-server/datarails-financeos) | D / R |

### 1.9 The Excel add-in

| Capability | What we know | Source | Sure |
|---|---|---|---|
| Two generations | The legacy COM add-in (*Flex*) and a new Office.js add-in that runs on Windows, Mac and the web. Files from one don't work in the other | [Dynamic Ranges in the Office JS Add-In](https://support.datarails.com/hc/en-us/articles/29112192412444), [New add-in installation](https://support.datarails.com/hc/en-us/articles/29825734451996) | S |
| Formulas | `DR.GET` returns one figure, for example a value filtered by reporting month, scenario, data type and account ID. `DR.RANGE` filters a span, `DR.INCLUDE` a list (not both in one formula), and `DR.MONTH`, `DR.QUARTER` and `DR.YEAR` filter by period. The value argument can aggregate (average, count unique) | [Flex: Formulas](https://support.datarails.com/hc/en-us/articles/17609935489308), [DR.Include](https://support.datarails.com/hc/en-us/articles/14554692234908-Datarails-Flex-Add-In-Average-and-Count-unique-with-DR-Include) | S |
| Data tables | Filtered extracts of a table into a sheet: Add, Edit, Manage | [Flex: Data Tables](https://support.datarails.com/hc/en-us/articles/17609926354588) | S |
| Dynamic ranges | Report blocks that resize with the data; in Office.js one range can be split into sections, each refreshed with its own filter value | [Flex: Dynamic Ranges](https://support.datarails.com/hc/en-us/articles/17609968522780), [Office JS](https://support.datarails.com/hc/en-us/articles/29112192412444) | S |
| Drill-down | *Drill Down by Field* and *Drill Details*, from a formula to its rows; the file must be connected | [Drill Down](https://support.datarails.com/hc/en-us/articles/15909927563804-Datarails-Add-In-Drill-Down) | S |
| Refresh | Pulls the latest data, including changes to datasets, mappings and groupings | [Data sync and refresh](https://support.datarails.com/hc/en-us/articles/12621449778716-Data-sync-and-refresh-Overview) | S |
| Submit | Sends the workbook to its Filebox as a new version, as draft or final when the Filebox uses status tags. A connected CSV disables Submit, Refresh, formulas and drill-down; use .xlsx | [Filebox search results](https://support.datarails.com/hc/en-us/articles/14377465336220-Filebox-Versions-Tags), [Add-in overview](https://support.datarails.com/hc/en-us/articles/29885235917468-The-Datarails-Excel-Add-In-Overview) | S |
| Publish | A report becomes a web dashboard (Embedded Range), a PowerPoint chart, values or PDF | [2.2 Flex](https://support.datarails.com/hc/en-us/articles/8236849348381-2-2-Flex-the-Excel-Add-In) | S |
| Google Sheets (1 October 2026) | The same formulas through a builder panel, tables and reports, refresh that keeps custom columns, drill-down from any cell, global filters that limit a sheet to authorised data, static export | [press release](https://www.prnewswire.com/il/news-releases/datarails-now-natively-integrates-with-google-sheets-for-finance-teams-302895700.html) | D |
| Claude for Excel | A support article titled *Getting Started with Datarails on Claude for Excel* exists; we have the title only | [article title](https://support.datarails.com/hc/en-us/articles/25874100800668-Getting-Started-with-Datarails-on-Claude-for-Excel) | S (title) |

**How templates map to the data model [I].** A planning template is an .xlsx connected to a Filebox whose tags give it
a scenario and cycle (read in the sheet through the `DR_*` named ranges). A Data Mapper reads the submitted version
into the target table, with lookups from source columns to fields. `DR.GET` and data tables read that table back by
field names. So a template is input (Submit → Filebox version → mapper → table) and output (table → formulas). That
both directions pass through the mapper explains a G2 complaint: a mapper change doesn't carry through existing
reports ([search summary of G2](https://g2.com/products/datarails/reviews?page=2)) [R].

### 1.10 Governance

| Capability | What we know | Source | Sure |
|---|---|---|---|
| Roles | Viewer, Collaborator, Manager, Admin and Super Admin; rolling out in H2 2026 to replace Super Admin, Admin, Contributor and Viewer. Only a Super Admin manages groups or makes a Super Admin | [Roles & Permissions](https://support.datarails.com/hc/en-us/articles/28179335507996-New-Permissions-Roles-Permissions-Overview), [Admin Settings](https://support.datarails.com/hc/en-us/articles/5220326041489-Admin-Settings) | S |
| Object sharing | A role grants no data: each table, Filebox, dashboard and report must be shared. Deactivating a user keeps their permissions for reactivation | [Roles & Permissions](https://support.datarails.com/hc/en-us/articles/28179335507996-New-Permissions-Roles-Permissions-Overview) | S |
| Final versions | Only Filebox owners save a version as Final | [Filebox Versions & Tags](https://support.datarails.com/hc/en-us/articles/14377465336220-Filebox-Versions-Tags) | S |
| Mapping governance | Effective-dated mapping versions; each report names the mapping version it uses; lookup notifications list unmapped accounts; a log of each change with author, date, reason and approval is advised | [CoA before FP&A](https://www.datarails.com/blog/fix-chart-of-accounts-before-fpa-implementation/), [CoA changes](https://www.datarails.com/blog/fpa-historical-data-chart-of-accounts-changes/) | D |
| Audit and lineage | Audit trails, data lineage and version control are claimed; no public detail of the log | [platform](https://www.datarails.com/financeos-platform/) | D (claim) |
| AI governance | MCP calls are checked per user and per query against roles and groups; one advertised OAuth scope | [Agentman](https://agentman.ai/agentskills/connections/mcp-server/datarails-financeos) | R |

---

## 2. Data model, as far as it can be inferred

### 2.1 The objects

| Object | What it is | Source | Sure |
|---|---|---|---|
| **Filebox** | A container of file versions that share one structure. Holds templates and folders (the MCP's `list_filebox`). An *Integration Filebox* receives connector loads; *Upload via API* lets DGS write to it | [Filebox Overview](https://support.datarails.com/hc/en-us/articles/13813197730332), [Integration Filebox](https://support.datarails.com/hc/en-us/articles/13711447215900-Integration-Filebox), [apis.io](https://apis.io/apis/datarails/data-gateway-service/) | S / R |
| **Version** | One upload or Submit into a Filebox, with a name and tags | [Filebox Versions & Tags](https://support.datarails.com/hc/en-us/articles/14377465336220-Filebox-Versions-Tags) | S |
| **Tags** | *Scenario* (Actuals, Budget, Forecast), *Date* (yearly, monthly), *File Status* (Draft, Final), *Budget Cycle* (Budget only). Changing a Filebox's tags clears its versions' tags | same | S |
| **Data Mapper** | Per Filebox: source columns → fields of a target table, with lookups and custom fields; carries the chart-of-accounts hierarchy columns | [Data Mapper exercise](https://support.datarails.com/hc/en-us/articles/11711103284765) | S |
| **Table / data model** | A target table such as *Financials*, with fields and calculated values. The MCP calls these *data models* and gives each an ID and aliases | [Calculated Values](https://support.datarails.com/hc/en-us/articles/14719253554460-Calculated-Values), [connector](https://hackceleration.com/resources/integrations/claude/datarails-financeos) | S / R |
| **Field / aliased field** | A column; an alias is its business label and description (`list_aliased_fields`) | [connector](https://hackceleration.com/resources/integrations/claude/datarails-financeos) | R |
| **Dimension** | A shared business axis (Department, Region, Product, Customer) mapped to a column in each table | [Semantic Layer](https://support.datarails.com/hc/en-us/articles/27013655982364-Semantic-Layer-overview) | S |
| **Business metric** | Base (from a table) or calculated (from metrics); one definition for every consumer | same | S |
| **Scenario** | A tag, not a separate store: Actuals, Budget, Forecast | [Filebox Versions & Tags](https://support.datarails.com/hc/en-us/articles/14377465336220-Filebox-Versions-Tags) | S |
| **Cycle** | Forecast cycle (`1+11`, `0+12`) or budget cycle (*Top-Down*, *V1*) | [Planning Overview](https://support.datarails.com/hc/en-us/articles/18024691753756-Planning-Overview) | S |
| **Entity, account** | Fields on the financials table; mappings key on account and entity together | [CoA changes](https://www.datarails.com/blog/fpa-historical-data-chart-of-accounts-changes/) | D |
| **Data Type** | A field whose example value is *Activity* | [DR.GET results](https://support.datarails.com/hc/en-us/articles/17609935489308) | S |
| **Company profile** | Named text sections about the company, for AI context | [connector](https://hackceleration.com/resources/integrations/claude/datarails-financeos) | R |

**Inferred shape of the Financials table [I].** From the `DR.GET` example and the mapper articles, a row is about:
`reporting_month, entity, account_id, account (name), CoA hierarchy levels (e.g. P&L line, group, category),
department or cost centre, other dimensions, scenario, data_type (Activity or Balance), amount, currency, filebox,
version`. *Activity* versus *Balance* is the classic split between period movements (P&L) and closing balances
(balance sheet). Datarails doesn't state that split; it follows from the field name and the example.

### 2.2 How ERP and GL data reach the chart of accounts

1. A connector, a file upload or DGS puts a GL or trial balance export into a Filebox as a tagged version, such as
   *Actuals*, October 2026 ([Integration Filebox](https://support.datarails.com/hc/en-us/articles/13711447215900-Integration-Filebox),
   [Consolidation](https://www.datarails.com/solutions/consolidation/)) [S][D].
2. The Filebox's Data Mapper maps the source columns to the *Financials* fields, looks each source account up in a
   mapping table to get the chart-of-accounts hierarchy, and adds custom fields. A new entity's mapper starts with
   empty mapping columns that someone fills in ([Data Mapper exercise](https://support.datarails.com/hc/en-us/articles/11711103284765))
   [S].
3. The mapping key is account plus entity, so the same account number in two entities doesn't collide. Unmapped
   accounts raise lookup notifications for review
   ([CoA changes](https://www.datarails.com/blog/fpa-historical-data-chart-of-accounts-changes/)) [D].
4. *Publish & Scan* re-runs the mapping over the Filebox. *Publish & Apply to* reuses one mapper for several Fileboxes,
   for example one per entity ([Creating a new Data Mapper](https://support.datarails.com/hc/en-us/articles/14445024642204-Creating-a-new-Data-Mapper))
   [S].
5. Eliminations and FX are applied in consolidation before the semantic layer reads the result
   ([How a finance OS works](https://www.datarails.com/how-does-finance-operating-system-work/)) [D].

Reviewers confirm that mapping is where implementations spend their time: one says it took back-and-forth before
it worked ([Capterra search results](https://www.capterra.com/p/177451/DataRails/reviews/)) [R].

### 2.3 The MCP tools (FinanceOS AI Connector)

Endpoint `https://mcp.datarails.com/mcp`. OAuth sign-in with PKCE (S256), authorization-code and refresh grants, one
scope (`datarails`). A paid add-on that a Super Admin enables in *AI Center*. Every call is checked against the user's
role and groups. Rows are paged 100 at a time; aggregation responses are size-capped and report the total; a
`x-ratelimit-limit: 120` header was observed, with no published window
([Agentman](https://agentman.ai/agentskills/connections/mcp-server/datarails-financeos),
[Hackceleration](https://hackceleration.com/resources/integrations/claude/datarails-financeos),
[Claude directory](https://claude.com/connectors/datarails-financeos)) [R].

All 24 tools are read-only:

| Group | Tools |
|---|---|
| Catalogue | `list_data_models`, `get_fields_by_id`, `list_aliased_fields`, `list_business_metrics`, `list_filebox`, `list_xl_functions` |
| Rows | `get_data_by_id`, `get_data_by_alias` |
| Aggregation (asynchronous) | `start_aggregation_by_id`, `start_aggregation_by_alias`, `get_aggregation_result_by_id`, `get_aggregation_result_by_alias` |
| Distinct values (asynchronous) | `start_distinct_values_by_id`, `start_distinct_values_by_alias`, `get_distinct_values_result_by_id`, `get_distinct_values_result_by_alias` |
| Profiling | `profile_numeric_fields`, `profile_categorical_fields` |
| Context | `get_currency_rates`, `list_company_profile_sections`, `get_company_profile_sections`, `get_org_users`, `get_workflow_guide`, `get_connector_status` |

Every query tool comes in two forms: by table ID and by business alias. Our `fake-datarails` has five of these
(`list_data_models`, `list_aliased_fields`, `list_business_metrics`, `query_data_model`, `list_filebox`), and
`query_data_model` is our own name, not theirs ([`../datarails.md`](../datarails.md)). A fuller fake would take the 24
names above.

### 2.4 The upload API (Data Gateway Service)

`POST https://app.datarails.com/api/v1/fileboxes/upload_file`, multipart, with a CSV or Excel file, the Filebox UUID,
a version name and version tags. HTTP Basic as a *sync user* that must not have MFA. The Filebox must have *Upload via
API* enabled. A snippet of the official page also shows an `include_in_dashboard` setting. No OpenAPI spec is published
([apis.io](https://apis.io/apis/datarails/data-gateway-service/),
[DGS documentation](https://support.datarails.com/hc/en-us/articles/14616773038620-Data-Gateway-Service-DGS-API-Documentation))
[R][S]. No webhooks and no public Spend API were found [I, from absence].

### 2.5 Architecture hints from job posts

- Python and Django on the backend, Angular on the front end, REST, Celery and RabbitMQ, microservices and event
  streams ([AI Builder role](https://www.datarails.com/company/careers/4407952009/)) [D].
- Azure preferred, Docker and Kubernetes, a move from a monolith to services; Office.js or C# COM experience for the
  add-in ([Principal Engineer](https://jobs.qumracapital.com/companies/datarails/jobs/64005930-principal-engineer)) [R].
- Batch ETL and ELT with Airflow or Dagster, Spark, data warehouses and lakes
  ([Senior Backend, Data Platform](https://jobs.qumracapital.com/companies/datarails/jobs/43092523-senior-backend-developer-data-platform))
  [R].
- AI on Azure OpenAI so data stays in an enterprise boundary
  ([VentureBeat](https://venturebeat.com/data/cfos-are-now-getting-their-own-vibe-coding-moment-thanks-to-datarails))
  [R].
- No database is named in any post we found [I: unknown].

---

## 3. Integrations

The integrations directory groups more than a hundred systems
([integrations](https://www.datarails.com/integrations/)) [D]:

| Kind | Examples |
|---|---|
| ERP | NetSuite, Sage Intacct, Business Central, SAP Business One, SAP ECC, ByDesign, Oracle Fusion, JD Edwards, Acumatica, Epicor, Dynamics 365/NAV/AX/GP, Sage X3, Infor, Deltek, Priority |
| GL and accounting | QuickBooks Online and Desktop, Xero, Exact, Hashavshevet, DATEV, Sage 50 |
| CRM | Salesforce, HubSpot, Zoho, Pipedrive |
| HRIS and payroll | ADP, Paychex, Paylocity, Dayforce, UKG, Gusto, Rippling, BambooHR, HiBob, Workday |
| Banks, payments, expenses | HSBC, Bank of America CashPro, Mercury, Stripe, Square, Ramp, Navan, Concur, Coupa, Bill.com |
| Billing | Chargebee, Maxio, Stripe |
| Warehouses and databases | Snowflake, BigQuery, Redshift, Synapse, Fabric, Databricks, SQL Server, PostgreSQL, MySQL, S3, GCS |
| BI | Power BI, Tableau, Looker, Metabase |
| Files | Google Sheets, SharePoint, OneDrive, SFTP |

How data comes in:

- **Native connectors** per system, which load into an Integration Filebox
  ([integrations](https://www.datarails.com/integrations/),
  [Integration Filebox](https://support.datarails.com/hc/en-us/articles/13711447215900-Integration-Filebox)) [D][S].
- **Excel and Google Sheets Submit** into a Filebox (1.9) [S][D].
- **File upload** in the app and **DGS** for scripts (2.4) [S][R].
- **SFTP, cloud storage and warehouses** as sources ([integrations](https://www.datarails.com/integrations/)) [D].
- **Email**: a support article titled *Sync Datarails with Email* exists
  ([title](https://support.datarails.com/hc/en-us/articles/5460703446929-Sync-Datarails-with-Email)) [S, title only].
- **Custom APIs** built for a customer ([integrations](https://www.datarails.com/integrations/)) [D].
- Plans cap the number of integrations: 1 on Professional, 2 on Premium, 3 on Expert
  ([pricing](https://www.datarails.com/pricing/)) [D].

---

## 4. What users praise and complain about

Ratings: G2 about 4.6 out of 5 from about 334–370 reviews; Capterra 4.7 from about 233–250, with 4.8 for support
([G2](https://www.g2.com/products/datarails), [Capterra](https://www.capterra.com/p/177451/DataRails/reviews/)) [R]. We
read G2 and Capterra through search summaries, because both refuse direct fetches.

**Keep:**

- **Excel stays the surface.** Ease of use and the Excel integration are the top themes on G2
  ([G2](https://www.g2.com/products/datarails)) [R].
- **Support and onboarding.** The highest-scored area ([Capterra](https://www.capterra.com/p/177451/DataRails/reviews/)) [R].
- **Templates and fast reporting.** Out-of-the-box templates, dashboards, Storyboards, less manual work
  ([Cube's review](https://www.cubesoftware.com/blog/datarails-reviews), a competitor) [R].
- **Time saved at close** once the mapping works ([Capterra](https://www.capterra.com/p/177451/DataRails/reviews/)) [R].

**Do better:**

| Complaint | Source | What we would do [I] |
|---|---|---|
| Large workbooks are slow to refresh and load; big dynamic ranges bog Excel down | [G2](https://g2.com/products/datarails/reviews_and_filters?page=2), [Capterra](https://capterra.com/p/177451/DataRails/reviews/?page=6) | Compute on the server; send the add-in only the cells it shows; refresh per range; batch custom-function calls |
| Setup and mapping are long; one rollout ran well over plan | [Capterra](https://www.capterra.com/p/177451/DataRails/reviews/), [G2](https://www.g2.com/products/datarails) | Suggest mappings from account names and history; show unmapped accounts as a list to clear, with totals reconciled to the source |
| A mapper change doesn't reach existing dashboards and reports | [G2 via search](https://g2.com/products/datarails/reviews?page=2) | Versioned mappings that every report names, with a preview of what a new version changes, then a re-run |
| Steep learning curve; the interface isn't intuitive | [Capterra](https://capterra.com/p/177451/DataRails/reviews/?page=6) | Fewer object types; plain names; a guided first month |
| Proprietary formulas are hard to change; formulas are tricky at first | [Cube's review](https://www.cubesoftware.com/blog/datarails-reviews), [G2](https://www.g2.com/products/datarails) | One function with named arguments and a builder panel; formulas that read like the metric's name |
| Viewers need licences; permissions take time | [Cube's review](https://www.cubesoftware.com/blog/datarails-reviews) | Roles from Landbright groups; viewers free |
| Limited exports and BI; some still chart in Excel | [G2](https://www.g2.com/products/datarails), [Cube's review](https://www.cubesoftware.com/blog/datarails-reviews) | CSV, XLSX and an open query API from day one |
| Opaque pricing; said to cost more than peers | [Cube's review](https://www.cubesoftware.com/blog/datarails-reviews) | Not our problem as an internal tool |
| Google Sheets was sync-only (fixed 1 October 2026) | [Cube's review](https://www.cubesoftware.com/blog/datarails-reviews), [press release](https://www.prnewswire.com/il/news-releases/datarails-now-natively-integrates-with-google-sheets-for-finance-teams-302895700.html) | Excel first, Sheets later |
| No write tools over MCP; a sync user without MFA for uploads | [Agentman](https://agentman.ai/agentskills/connections/mcp-server/datarails-financeos), [apis.io](https://apis.io/apis/datarails/data-gateway-service/) | Write tools that create pending changes a person accepts; scoped keys, not shared users |

---

## 5. Comparable products: ideas to borrow

| Product | Distinctive | Borrow | Source |
|---|---|---|---|
| **Cube** | Two-way sync between Excel or Sheets and a central cube; multi-dimensional fetch and push; a semantic layer and a multi-currency engine; Strategist, Planner, Analyst and Data Manager agents grounded in the chart of accounts | Push from a sheet by dimension, not by file | [Cube platform](https://www.cubesoftware.com/platform), [strategic finance](https://www.cubesoftware.com/strategic-finance-software) |
| **Vena** | Excel-native on Microsoft 365; Template Studio with prebuilt OPEX and income statement templates; Planning and Reporting agents in Copilot that turn a prompt into a driver-based plan; an MCP server | A template studio; prompt to driver plan | [Vena releases](https://www.venasolutions.com/product-release/fy27/spring/customer), [Vena Copilot](https://venasolutions.com/blog/vena-copilot-ai-agents), [ERP Research](https://erpresearch.com/erp-add-ons/fpa-planning/vena-solutions) |
| **Pigment** | Its own modelling engine of *Blocks* (dimension lists, transaction lists, metrics, properties); a Modeler Agent that builds blocks, formulas and boards from language, with a person reviewing; Frames for app UI; an engine that splits storage and compute | A model of typed blocks; agent-built changes as reviewed proposals | [Modeler Agent](https://kb.pigment.com/docs/configure-and-run-the-modeler-agent), [Alpha FMC](https://alphafmc.com/insights/accelerating-enterprise-planning-pigments-latest-innovations/) |
| **Mosaic** (HiBob since February 2025) | Strategic finance with headcount planning at its heart; now joined to an HRIS | Headcount plan fed by the HRIS roster | [HiBob](https://www.hibob.com/news/hibob-acquires-financial-planning-and-analysis-platform-mosaic-expanding-capabilities-to-empower-people-first-cfos/), [CB Insights](https://www.cbinsights.com/company/mosaic-5) |
| **Abacum** | Workforce planning from HRIS and payroll with variance as it appears; scenarios with bounded drivers | Bounds on scenario drivers | [Abacum headcount](https://abacum.ai/use-cases/headcount-planning), [scenarios](https://abacum.io/use-cases/scenario-planning) |
| **Planful** | Predict Signals: a normal range learned from history, values outside it flagged high, medium or low, resolutions carried across reports and templates; Predict Projections with a person adjusting; consolidation with eliminations at any parent | Anomaly flags inside templates, before submission | [Signals](https://help.planful.com/docs/how-to-use-predict-signals-in-dynamic-reports), [Projections](https://planful.com/pressrelease/planful-announces-newest-addition-to-predict-suite-of-native-ai-ml-applications-predict-projections/), [consolidation](https://planful.com/product/consolidation/) |
| **Causal** (Lucanet since October 2024) | Named variables and readable formulas instead of cell references; dimensions, scenarios, versions; LLM-drafted first models | Formulas over named metrics | [Lucanet](https://www.lucanet.com/en/press-releases/causal-joins-the-lucanet-group-31-10-2024/), [profile](https://yespress.io/products/causal.md) |

---

## 6. Open-source building blocks

Each licence was read from the repository's LICENSE file through the GitHub API on 15 November 2026, with stars and
the last push date. **Permissive** means MIT, Apache-2.0 or BSD. **Study only** means copyleft or source-available:
read the design, never copy code. **Avoid** marks AGPL, GPL, SSPL and BSL for code reuse.

### Ledgers and double entry

| Project | Licence | Use | Verdict |
|---|---|---|---|
| [formancehq/ledger](https://github.com/formancehq/ledger) | MIT | Programmable double-entry ledger; Numscript transactions, idempotency keys, bulk; v3 on main is a Raft cluster on Pebble | Permissive. A model for postings and idempotency; we keep Postgres |
| [tigerbeetle/tigerbeetle](https://github.com/tigerbeetle/tigerbeetle) | Apache-2.0 | Debit-credit ledger; two-phase *pending* transfers (reserve, post part or all, void, expire) and balance limits checked when reserving ([docs](https://docs.tigerbeetle.com/coding/two-phase-transfers/)) | Permissive. The cleanest model for **commitments**: request → pending, PO → post, cancel → void |
| [blnkfinance/blnk](https://github.com/blnkfinance/blnk) | Apache-2.0 | Ledger with balances and inflight transactions | Permissive; a second reference |
| [ledger/ledger](https://github.com/ledger/ledger) | BSD-3-Clause | Plain-text accounting | Permissive; little to reuse |
| [beancount/beancount](https://github.com/beancount/beancount) | GPL-2.0 | Plain-text accounting with a clear booking model | Avoid for code; study the booking rules |
| [simonmichael/hledger](https://github.com/simonmichael/hledger) | GPL-3.0 | Plain-text accounting | Avoid for code |

### Spreadsheets and grids in the web

| Project | Licence | Use | Verdict |
|---|---|---|---|
| [dream-num/univer](https://github.com/dream-num/univer) | Apache-2.0 (core) | Web SDK for Sheets and Docs: models, formula engine, rendering, plugins, headless use in Node. Collaboration server and some plugins are commercial | Permissive core. **The web grid and formula engine** for templates in the browser |
| [dream-num/Luckysheet](https://github.com/dream-num/Luckysheet) | MIT | Archived; Univer is its successor | Don't start on it |
| [ruilisi/fortune-sheet](https://github.com/ruilisi/fortune-sheet) | MIT | A Luckysheet fork in React and TypeScript | Permissive; a lighter alternative |
| [gristlabs/grist-core](https://github.com/gristlabs/grist-core) | Apache-2.0 | Relational spreadsheet on SQLite; Python formulas; access rules; webhooks; the full edition adds features | Permissive core. A model for typed tables with formulas and access rules |
| [ironcalc/IronCalc](https://github.com/ironcalc/IronCalc) | Apache-2.0 | Spreadsheet engine in Rust with xlsx read and write | Permissive; a server-side calculator and xlsx reader |
| [jspreadsheet/ce](https://github.com/jspreadsheet/ce) | MIT | A light web grid | Permissive |
| [myliang/x-spreadsheet](https://github.com/myliang/x-spreadsheet) | MIT | Web grid; no push since 2024 | Permissive, stale |
| [finos/perspective](https://github.com/finos/perspective) | Apache-2.0 | Data grid, pivot and charts on WebAssembly and Arrow, for large and streaming data | Permissive. **Pivots and drill-down** in reports |
| [glideapps/glide-data-grid](https://github.com/glideapps/glide-data-grid) | MIT | Canvas data grid for millions of rows | Permissive |
| [ag-grid/ag-grid](https://github.com/ag-grid/ag-grid) | MIT (community) / commercial (enterprise) | Grid; pivoting is enterprise | Community only |
| [formulajs/formulajs](https://github.com/formulajs/formulajs) | MIT | Excel functions in JavaScript | Permissive |
| [LesterLyu/fast-formula-parser](https://github.com/LesterLyu/fast-formula-parser) | MIT | Excel formula parser | Permissive |
| [handsontable/hyperformula](https://github.com/handsontable/hyperformula) | GPL-3.0 or proprietary | Headless formula engine | Avoid for code reuse |

### The Excel add-in

| Project | Licence | Use | Verdict |
|---|---|---|---|
| [OfficeDev/Office-Add-in-samples](https://github.com/OfficeDev/Office-Add-in-samples) | MIT | Samples including `excel-custom-functions-sync`, `excel-shared-runtime-scenario`, `excel-shared-runtime-global-state`, `excel-data-types-explorer`, `auth`, `office-contextual-tabs` | Permissive. **The starting point for the add-in** |
| [OfficeDev/Excel-Custom-Functions](https://github.com/OfficeDev/Excel-Custom-Functions) | MIT | Template for custom functions defined in TypeScript with JSDoc metadata | Permissive |
| [OfficeDev/generator-office](https://github.com/OfficeDev/generator-office) | MIT | Yeoman project generator | Permissive |

Custom functions are defined in JavaScript or TypeScript with a `@customfunction` comment that generates their
metadata. A shared runtime lets the functions and the task pane share state, which Microsoft recommends. They run in
Excel on Windows, Mac and the web, but not on iPad or on perpetual Office 2021 and earlier, and they need read-write
document permission ([Microsoft Learn](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-overview))
[D, Microsoft].

### Semantic layers and metrics

| Project | Licence | Use | Verdict |
|---|---|---|---|
| [cube-js/cube](https://github.com/cube-js/cube) | Apache-2.0 by default, some packages MIT | Semantic layer: cubes, measures, dimensions, joins, pre-aggregations, SQL and REST APIs | Permissive. A model, or a component, for **metrics over the financials table** |
| [dbt-labs/metricflow](https://github.com/dbt-labs/metricflow) | Apache-2.0 (LICENSE file; an old README badge says AGPL) | Metric definitions compiled to SQL with joins | Permissive. A model for base and derived metrics |
| [malloydata/malloy](https://github.com/malloydata/malloy) | MIT | A semantic query language | Permissive |

### BI and reporting

| Project | Licence | Use | Verdict |
|---|---|---|---|
| [apache/superset](https://github.com/apache/superset) | Apache-2.0 | Dashboards and charts | Permissive; heavy for our needs |
| [evidence-dev/evidence](https://github.com/evidence-dev/evidence) | MIT | Reports from SQL and Markdown as a static site | Permissive. A model for **report packages** and board packs |
| [rilldata/rill](https://github.com/rilldata/rill) | Apache-2.0 | Metrics dashboards on DuckDB or ClickHouse | Permissive; fits Clickland |
| [lightdash/lightdash](https://github.com/lightdash/lightdash) | MIT except `ee/` | BI on dbt metrics | Permissive outside `ee/` |
| [duckdb/duckdb](https://github.com/duckdb/duckdb) | MIT | In-process analytics | Permissive; a fast engine for report queries |
| [apache/kylin](https://github.com/apache/kylin) | Apache-2.0 | OLAP cubes | Permissive; heavy |
| [metabase/metabase](https://github.com/metabase/metabase) | AGPL-3.0 / commercial | BI | Avoid for code reuse |
| [pentaho/mondrian](https://github.com/pentaho/mondrian) | BSL 1.1 (current LICENSE) | OLAP server | Avoid; it is no longer open source |

### Planning

No credible open-source FP&A planning product exists. A GitHub search for *FP&A*, *financial planning analysis* and
*budgeting forecasting* returns student and portfolio projects with a handful of stars. OpenAlternative's FP&A
category lists only OpenBB, an investment research tool, and Bigcapital, which is accounting software
([OpenAlternative](https://openalternative.co/categories/business-software/finance-accounting/financial-planning-analysis-fp-a)).
OpenBB is Apache-2.0 but serves investment teams, not planning. The planning core (cycles, scenarios, templates,
drivers, submissions) is ours to design. That is also where Datarails is thinnest in public.

### Accounting systems: consolidation and FX logic to study

| Project | Licence | What to study | Verdict |
|---|---|---|---|
| [frappe/erpnext](https://github.com/frappe/erpnext) | GPL-3.0 | `exchange_rate_revaluation`, `accounting_dimension`, `budget` and `budget_distribution`, `cost_center_allocation`, `period_closing_voucher`, `accounting_period`, `finance_book`; reports `consolidated_financial_statement` and `consolidated_trial_balance` | Avoid for code; study the designs |
| [odoo/odoo](https://github.com/odoo/odoo) | LGPL-3.0 | Multi-company and currency in the community edition. We found no consolidation or budget module in `addons/`, so those are Enterprise (proprietary) [I, from the listing] | Study only |
| [OCA/mis-builder](https://github.com/OCA/mis-builder) | AGPL-3.0 | Management reports from KPI templates over accounts and periods, with `mis_builder_budget` for budgets by KPI | Avoid for code; the closest open design to a report template plus budget |
| [OCA/account-consolidation](https://github.com/OCA/account-consolidation), [OCA/currency](https://github.com/OCA/currency), [OCA/account-budgeting](https://github.com/OCA/account-budgeting), [OCA/account-financial-reporting](https://github.com/OCA/account-financial-reporting) | AGPL-3.0 | Consolidation, rate updates, budgets, financial reports | Avoid for code |
| Bigcapital, Midday, Firefly III, Lago | AGPL-3.0 | Accounting, finance and billing apps | Avoid for code |
| Akaunting | BSL (Akaunting's terms) | Accounting app | Avoid |

### Top five

1. **Univer** (Apache-2.0): a web grid and formula engine for templates, with headless use on the server.
2. **Office.js samples, the custom-functions template and the generator** (MIT): the Excel add-in's skeleton, with
   functions, a shared runtime and auth.
3. **Perspective** (Apache-2.0): pivots, grids and drill-down for reports.
4. **Cube.dev** (Apache-2.0 or MIT) or **MetricFlow** (Apache-2.0): the semantic layer's model of dimensions, base and
   derived metrics, and joins.
5. **TigerBeetle** (Apache-2.0), with **Formance Ledger** (MIT): the double-entry and pending-transfer model for
   commitments and corrections, rebuilt in our own Postgres.

Close behind: Grist (Apache-2.0) for typed tables with formulas and access rules, IronCalc (Apache-2.0) for xlsx on the
server, DuckDB (MIT) for report queries, and Evidence (MIT) for report packages.

---

## 7. Suggested modules, in build order

The current design treats Landledger as the technology-spend subledger that feeds Datarails
([`../plan.md`](../plan.md), [`../architecture.md`](../architecture.md)). To match Datarails we need a general finance
data layer above it. **Our suggestion [I]:** build it as a sibling product that reuses Landledger's libraries (money,
audit chain, approvals, periods, identity), with Landledger becoming its first source, as it now feeds Datarails. The
alternative is to grow Landledger itself; that is the user's call.

Each module's *Has* line says what Landledger already covers; the paths are in `docs/`.

**M0 · Foundations (reuse).** Exact money in micro-units with an ISO currency, append-only records and corrections,
the hash-chained audit log, Landbright sign-in with roles from groups, SCIM, keys and webhooks.
- *Has:* all of it ([money.md](../money.md), [identity.md](../identity.md), [approvals.md](../approvals.md)).
- *Outcome:* nothing new for users; the rest builds on it.

**M1 · Data layer: datasets, versions, uploads.** The Filebox equivalent: a dataset has one schema and many versions,
each tagged with scenario, period, status (draft or final, final only by the owner) and cycle. Uploads come in CSV and
XLSX through the console, an upload API with scoped keys (not a shared user), and Landledger's snapshot as a built-in
source. Each version keeps its sha256.
- *Needs:* a dataset and version store, file parsing (IronCalc or a CSV/XLSX reader), tags, retention.
- *Has:* versioned budgets, snapshots with sha256, the Datarails upload's file shapes ([datarails.md](../datarails.md)).
- *Outcome:* a controller uploads October's trial balance for two entities and sees each version, who sent it and its
  status.

**M2 · Mapper and chart of accounts.** A chart of accounts with a hierarchy (P&L and balance-sheet lines), entities,
and mapping tables keyed by source system, entity and account. Mappings are versioned and effective-dated; every
report names its version. Unmapped accounts form a list to clear, and mapped totals reconcile to the source. Mapping
templates per ERP, and suggested mappings from names and history. Activity and balance rows go into one financials
table.
- *Needs:* the financials table (2.1's inferred shape), mapping versions, a rescan, a preview of what a new version
  changes.
- *Has:* cost centre codes, allocation rules with versions and a preview ([allocation.md](../allocation.md)).
- *Outcome:* two entities' GLs on one chart of accounts, with no unmapped account left and a total that ties to the
  source.

**M3 · Semantic layer and read MCP.** Dimensions mapped to columns across tables, base and calculated metrics, business
aliases, and permission by role, group and object. A query API for rows, aggregations, distinct values and profiles,
with the same tools over MCP (2.3's 24, under our own names), and a currency-rate tool.
- *Needs:* a metric compiler on the model of Cube.dev or MetricFlow; Postgres, DuckDB or Clickland for the queries.
- *Has:* an MCP server with `spend_by` and `budget_status` ([spend.md](../spend.md)).
- *Outcome:* Claude, through Landflow, answers "operating expense by department against budget, October" with the
  asker's permissions, and every figure matches the console's.

**M4 · Reporting.** P&L, balance sheet, cash flow and budget-vs-actual reports from report templates; drill-down to
rows; dashboards; CSV, XLSX and PDF; scheduled insights; a month-end report package.
- *Needs:* a report definition (rows as metric or account ranges, columns as scenario × period), Perspective for
  pivots.
- *Has:* Overview, Explore with drill-down, Budgets, Copy for Excel, the month-end package ([spend.md](../spend.md),
  [close.md](../close.md)).
- *Outcome:* a CFO opens October's P&L against budget and drills from a line to the journal rows behind it.

**M5 · Excel add-in.** Office.js with a shared runtime. One function (for example `=LAND.GET(metric, filters…)`)
with a builder panel; data tables and dynamic ranges; drill-down to a new sheet; *Refresh* per range; *Submit* a
connected template as a draft or final version; publish a range to a dashboard. Server-side computation and batched
calls, to avoid the refresh complaint.
- *Needs:* the Microsoft samples (section 6); M1 and M3; auth through Landbright.
- *Has:* nothing beyond Copy for Excel.
- *Outcome:* an analyst builds a department report in Excel from live figures and submits the department's budget
  from the same workbook.

**M6 · Planning.** Budget cycles and forecast cycles (`1+11` and so on), scenarios cloned and compared, templates
split by department with contributors, submissions and approvals, locked cycles reopened only by request, a driver
library (headcount × loaded cost, usage × rate), and a headcount plan from the HRIS roster and payroll actuals. Rolling
forecasts that replace closed months with actuals. A browser editor in Univer for people without Excel.
- *Needs:* M1 to M5; an HRIS source (a fake first).
- *Has:* budget versions from CSV or Datarails, a driver forecast with a P10–P90 band and forecast history for
  technology spend, approvals with policies and deadlines ([spend.md](../spend.md), [variance-notes.md](../variance-notes.md),
  [approvals.md](../approvals.md)).
- *Outcome:* FY27 budget collected from every department in templates, approved, locked; a Q1 reforecast cloned from
  it.

**M7 · Consolidation.** Entities with functional currencies, rate tables (average, closing, historical) approved
monthly, translation with a translation-adjustment line, intercompany matching by counterparty and elimination rules
applied every close, and allocations of shared cost.
- *Needs:* M2's entity-aware mapping; FX rates (the missing piece in Landledger); study ERPNext's revaluation and
  consolidated reports and OCA's modules, without copying code.
- *Has:* the allocation engine with direct and spread layers ([allocation.md](../allocation.md)); FX is refused with
  422 today ([plan.md](../plan.md)).
- *Outcome:* a group P&L in USD from a USD and an ILS entity, with intercompany eliminated and drill-down to each
  entity.

**M8 · Close, extended to the whole ledger.** The checklist with owners and deadlines across the GL, reconciliations
with only the exceptions shown, a flux agent over every account (materiality per account type, entity and cost centre;
movement against the prior period and budget; drivers; a draft a person accepts), accrual suggestions, and a predicted
close date.
- *Has:* the ten computed close steps, the two-signature lock, reopening by request, accruals, variance notes drafted
  by an agent and checked against the snapshot, anomalies with a median and MAD ([close.md](../close.md),
  [accruals.md](../accruals.md), [variance-notes.md](../variance-notes.md), [anomalies.md](../anomalies.md)).
- *Outcome:* on business day 1, every account above materiality has a drafted explanation waiting for a reviewer.

**M9 · Spend, extended beyond technology.** Requests against any budget line, POs, commitments as pending amounts
posted by invoices and voided on cancel (TigerBeetle's model), three-way matching, contracts and renewals with an agent
that drafts the renewal case.
- *Has:* requests, policies, reservations in the budget left, invoices with reconciliation, contracts and seats
  ([approvals.md](../approvals.md), [invoices.md](../invoices.md), [contracts.md](../contracts.md)).
- *Outcome:* a marketing request for an agency retainer is checked against the budget left, approved, becomes a
  commitment, and is released when the invoice posts.

**M10 · Cash and AR.** Bank balances and transactions (a fake bank first; real feeds need the user's decision), a
13-week cash forecast from AR, AP and payroll, AR ageing, and a collections agent that drafts reminders a person sends.
- *Has:* nothing.
- *Outcome:* a weekly cash position and forecast by entity and currency.

**M11 · Agents, board packs and a finance desk.** Planning, reporting and strategy agents as Landflow flows over M3's
tools; storyboards that turn report widgets into a slide deck or PDF with live figures; a request inbox for finance
in which the agent gathers the records and drafts the reply. **Write tools over MCP that create pending changes a
person accepts**, which Datarails doesn't offer.
- *Has:* Landflow flows, the agents' unit economics, the variance-note drafter ([agents.md](../agents.md),
  [integrations.md](../integrations.md)); Clickland for observing it all.
- *Outcome:* "Draft the October board pack" yields a deck whose every number links to its query, for the CFO to
  edit and sign.

**Why this order [I].** M1 to M3 are the data layer that everything reads; Datarails' own reviews show mapping is where
the work is. M4 and M5 give finance something to use every day before planning starts. Planning (M6) needs templates,
Submit and the semantic layer. Consolidation (M7) needs FX and entity mapping, which planning can live without for a
single-entity start. M8 and M9 extend what Landledger already does well. Cash (M10) needs outside bank data, so it
waits for a decision. Agents (M11) improve as every earlier module adds tools, so a first agent can ship with M3 and
grow from there.

---

## Open questions

- **Separate product or a larger Landledger?** Section 7 suggests a sibling; the decision is the user's.
- **The query engine.** Postgres alone, DuckDB beside it, or Clickland's ClickHouse for large GL detail? It depends on
  data volume; no figures yet.
- **Activity versus balance.** Inferred from one field name. Our own model should store both explicitly whatever
  Datarails does.
- **What we couldn't read:** support articles in full, G2 and Capterra pages, and the Datarails demo videos (no
  YouTube walkthrough turned up in search). The [S] rows rest on indexed snippets.
