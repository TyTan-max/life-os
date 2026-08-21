# Recurring Costs Architecture Blueprint
### Unifying Bills & Subscriptions Under One Mental Model

**Prepared for:** Finance Tracking App — Product & Engineering
**Scope:** Information architecture, UI/UX, notification logic, and add-item flow for a unified "Recurring Costs" surface that preserves distinct Bills vs. Subscriptions mental models.

---

## Design Principle

Bills and Subscriptions are both "recurring debits," but users reason about them differently:

| | **Bills** | **Subscriptions** |
|---|---|---|
| Mental model | "Obligation I must pay" | "Service I'm choosing to keep paying for" |
| Core anxiety | *"Did the amount change?"* | *"Am I still getting value from this?"* |
| Primary action | Verify & pay | Evaluate & prune |
| Amount | Often variable (usage-based) | Usually fixed (until a price hike) |

The architecture below treats this as **one dataset, two lenses** — a single source of truth with type-aware rendering — rather than two separate collections that would require duplicated reminder/notification logic and make cross-cutting views (e.g., "everything due this week") harder to build.

---

## 1. Information Architecture & DB Schema

### 1.1 Unified collection with a type discriminator

Use a single `recurring_items` table with a `type` enum plus two **nullable, type-scoped metadata blocks**. This avoids the two classic failure modes: (a) one giant table with 40 mostly-null columns, or (b) two fully separate tables that duplicate due-date/reminder/notification logic and break any "show me everything due this week" query.

```json
{
  "id": "rec_8f3a1c",
  "type": "bill",                    // "bill" | "subscription"
  "name": "PG&E Electric",
  "merchant": "Pacific Gas & Electric",
  "status": "active",                // active | paused | cancelled
  "amount": 142.50,
  "currency": "USD",
  "frequency": "monthly",            // weekly | biweekly | monthly | quarterly | semiannual | yearly
  "nextDueDate": "2026-09-14",
  "accountId": "acct_checking_01",
  "categoryId": "cat_utilities",
  "autopay": true,
  "reminderDaysBefore": 3,
  "icon": "zap",
  "color": "#eab04d",
  "tags": ["essential"],
  "createdAt": "2025-01-04T00:00:00Z",
  "updatedAt": "2026-08-14T00:00:00Z",

  "billMeta": {
    "isVariable": true,
    "varianceThresholdPct": 20,       // flag if new amount deviates >20% from rolling avg
    "rollingAverageAmount": 118.30,
    "amountHistory": [
      { "date": "2026-07-14", "amount": 96.40 },
      { "date": "2026-08-14", "amount": 142.50 }
    ],
    "dueDayOfMonth": 14,
    "essential": true,                // feeds Needs/Wants budgeting split
    "lateFeeRisk": "high",
    "accountNumberMasked": "•••• 4471"
  },
  "subscriptionMeta": null
}
```

```json
{
  "id": "rec_2b7e90",
  "type": "subscription",
  "name": "Netflix",
  "merchant": "Netflix Inc.",
  "status": "active",
  "amount": 15.99,
  "currency": "USD",
  "frequency": "monthly",
  "nextDueDate": "2026-09-02",
  "accountId": "acct_checking_01",
  "categoryId": "cat_entertainment",
  "autopay": true,
  "reminderDaysBefore": 3,
  "tags": [],
  "createdAt": "2025-03-11T00:00:00Z",
  "updatedAt": "2026-08-02T00:00:00Z",

  "billMeta": null,
  "subscriptionMeta": {
    "planTier": "Premium",
    "isFreeTrial": false,
    "trialEndDate": null,
    "billingCycleAnchorDate": "2025-03-02",
    "priceHistory": [
      { "date": "2025-03-11", "amount": 13.99 },
      { "date": "2025-11-01", "amount": 15.99 }
    ],
    "usageRating": 4,                 // 1–5, self-reported or inferred
    "lastUsedAt": "2026-08-10",
    "sharedWith": ["partner"],
    "cancelUrl": "https://netflix.com/cancelplan",
    "svcCategory": "streaming"        // subscription-specific taxonomy, distinct from budget categoryId
  }
}
```

### 1.2 Field reference

**Shared (top-level) fields**
`id`, `type`, `name`, `merchant`, `status`, `amount`, `currency`, `frequency`, `nextDueDate`, `accountId`, `categoryId`, `autopay`, `reminderDaysBefore`, `icon`, `color`, `tags`, `createdAt`, `updatedAt`

**`billMeta` (bill-only)**

| Field | Purpose |
|---|---|
| `isVariable` | Drives whether the UI shows a trend sparkline and variance alerts |
| `varianceThresholdPct` | User- or system-set % deviation that triggers a "this bill jumped" alert |
| `rollingAverageAmount` | Computed (last 3–6 cycles), used as the variance baseline |
| `amountHistory[]` | Powers the trend graph |
| `dueDayOfMonth` | Normalizes "due around the 14th" even when `nextDueDate` shifts for weekends |
| `essential` | Feeds Needs/Wants and 50/30/20-style budgeting elsewhere in the app |
| `lateFeeRisk` | Optional severity flag — biases reminder timing (utilities/rent get earlier nudges than optional bills) |
| `accountNumberMasked` | Reference-only, never full PII |

**`subscriptionMeta` (subscription-only)**

| Field | Purpose |
|---|---|
| `planTier` | "Free / Basic / Premium" — display + upsell-cancel-savings math |
| `isFreeTrial` / `trialEndDate` | Powers the "convert to paid in 3 days" alert class |
| `billingCycleAnchorDate` | Needed to compute renewal dates independent of `nextDueDate` drift |
| `priceHistory[]` | Detects silent price hikes (a subscription-specific failure mode bills don't really have) |
| `usageRating` / `lastUsedAt` | Powers the cost-to-value view and "unused subscription" nudges |
| `sharedWith[]` | Cost-splitting context, informs whether cancelling affects others |
| `cancelUrl` | One-tap deep link into the cancellation flow — the single highest-leverage subscription-specific affordance |
| `svcCategory` | Subscription-flavor taxonomy (streaming/software/fitness/gaming) — separate from the budget `categoryId` so "Subscriptions" as a budget category and "streaming vs. software" as a subscription lens can coexist |

### 1.3 Why not two tables?
A shared `getUpcoming(dateRange)` query, a shared notification scheduler, and a shared "Recurring Costs" total all need to scan the same rows regardless of type. Two tables would force every cross-cutting feature to run two queries and merge-sort the results — pure overhead for zero benefit, since the *type-specific* logic is confined to metadata that's naturally nullable.

---

## 2. UI/UX: Desktop & Mobile Layout

### 2.1 Top-level structure

```
Recurring Costs
┌─────────────────────────────────────────────┐
│  [ All ]  [ Bills ]  [ Subscriptions ]       │  ← segmented control
├─────────────────────────────────────────────┤
│  Monthly Total   Due in 7 Days   Flagged     │  ← KPI strip (context-aware, see 2.2)
├─────────────────────────────────────────────┤
│  [ type-specific view renders here ]         │
└─────────────────────────────────────────────┘
```

The segmented control is the single most important interaction: it must **persist scroll position and filters per tab** (switching to Subscriptions and back to Bills shouldn't reset the user's sort order) and should update the URL/route so it's deep-linkable and back-button-safe.

### 2.2 KPI strip — context-aware, not static

The three KPI tiles change meaning per tab, which keeps cognitive load low (users don't re-derive what a number means):

| Tab | Tile 1 | Tile 2 | Tile 3 |
|---|---|---|---|
| **All** | Total Monthly Recurring | Due in 7 Days | Items Flagged |
| **Bills** | Monthly Bills Total | Variable Bills Trending Up | Autopay Coverage (% ) |
| **Subscriptions** | Monthly Subscriptions Total | Unused (60+ days) | Renewing This Week |

### 2.3 Bills view — optimized for *verification*

Users scanning bills want to answer "did anything change, and do I have money for it" in under 5 seconds. Use a **dense table/list**, sorted by due date ascending by default:

```
NAME              AMOUNT     TREND        DUE          ACCOUNT           STATUS
⚡ PG&E Electric   $142.50    ▲ +20%  ⚠   Sep 14        Everyday Chk      Autopay
🏠 Rent            $1,800.00  ─ flat       Sep 19        Everyday Chk      Autopay
📱 Phone Bill      $85.00     ▼ -4%        Sep 18        Everyday Chk      Manual
```

- **Trend column**: a tiny inline sparkline or arrow+percentage comparing this cycle to `rollingAverageAmount`. This is the single highest-value bill-specific widget — it's the visual answer to "is this bill behaving normally."
- **Row expansion** (desktop: click row; mobile: tap): reveals a 6-month sparkline chart, full amount history, and a "why did this change" note field.
- Group headers by **"Needs" vs "Wants"** (using `billMeta.essential`) are optional but valuable for users who came from a budgeting flow — keep as a togglable grouping, not forced.

### 2.4 Subscriptions view — optimized for *evaluation and pruning*

Users scanning subscriptions want to answer "is this worth it, and should I cancel it" — a fundamentally different, lower-frequency, higher-stakes decision. Use a **card grid**, not a dense table:

```
┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│ Netflix         │  │ Peloton App     │  │ Adobe CC        │
│ $15.99/mo       │  │ $12.99/mo       │  │ $54.99/mo       │
│ ●●●●○ Used often│  │ ●○○○○ Rarely    │  │ ●●●○○ Sometimes │
│ Last: 2 days ago│  │ Last: 47 days ⚠│  │ Last: 6 days ago│
└────────────────┘  └────────────────┘  └────────────────┘
```

- **Cost-to-value indicator**: a 5-dot usage rating (self-reported via a quick prompt, or inferred from `lastUsedAt`/app-open telemetry if available) is the defining subscription widget, with zero equivalent need on the bills side.
- **Sort options**: Monthly Cost (default), Usage (ascending — surfaces prune candidates first), Renewal Date.
- **A dedicated "Cost vs. Value" quadrant chart** (optional, power-user view): X-axis = monthly cost, Y-axis = usage rating. Bottom-right quadrant (expensive + rarely used) is visually flagged red — this is the "cancel these" view.
- **Trial badges**: a small countdown chip ("Trial ends in 3 days") overlaid on the card top-right corner when `isFreeTrial` is true.
- **Price-hike badge**: small "↑ Price increased" tag when the latest `priceHistory` entry is >0% above the prior one.

### 2.5 Mobile adaptations

- Segmented control becomes a sticky top bar (persists on scroll) since it's the primary navigation for this whole surface.
- Bills table collapses to a single-column list; the trend indicator becomes an icon-only badge (▲/▼/─) to save width, full sparkline only on row-tap detail sheet.
- Subscription cards go single-column, full-width, swipeable.
- **Swipe actions** (the mobile-native affordance that replaces desktop hover-actions):
  - Bills row: swipe right → "Mark Paid," swipe left → "Edit."
  - Subscription card: swipe left → "Cancel" (deep-links to `cancelUrl` or opens a cancel-flow bottom sheet), swipe right → "Snooze reminder."
- Add button is a floating action button (FAB), bottom-right, persistent across both tabs — opens the smart-add flow described in Section 4.

---

## 3. Alerts & Notification Engine Logic

### 3.1 Design rule: alerts must be *earned*, not scheduled

The single biggest risk with a recurring-costs notification system is alert fatigue — if every bill fires a 3-day-before reminder regardless of whether anything is unusual, users start swiping away the whole category unread. Split the engine into two tiers:

- **Tier 1 — Scheduled reminders**: predictable, user-configured, low-frequency (e.g., "N days before due").
- **Tier 2 — Anomaly alerts**: unscheduled, fire only when something deviates from the expected pattern. These carry more weight precisely because they're rare.

### 3.2 Pseudo-rules — Bills

```
ON new_transaction_matched_to_bill(billItem, transaction):
  update billItem.amountHistory
  recompute billItem.rollingAverageAmount

  deviationPct = (transaction.amount - billItem.rollingAverageAmount)
                 / billItem.rollingAverageAmount * 100

  IF billItem.isVariable AND abs(deviationPct) >= billItem.varianceThresholdPct:
    fireAlert(
      type: "variable_bill_deviation",
      severity: deviationPct > 0 ? "warning" : "info",
      message: f"{billItem.name} was {abs(deviationPct)}% {deviationPct > 0 ? 'higher' : 'lower'}
                 than your {period(billItem.frequency)} average
                 (${transaction.amount} vs. ~${billItem.rollingAverageAmount})"
    )

ON daily_cron():
  FOR EACH billItem WHERE status == "active":
    daysUntilDue = billItem.nextDueDate - today

    IF daysUntilDue == billItem.reminderDaysBefore:
      fireAlert(type: "upcoming_bill", severity: "info")

    // Escalation for high-risk unpaid bills approaching/at due date
    IF billItem.lateFeeRisk == "high" AND daysUntilDue == 1 AND NOT billItem.autopay:
      fireAlert(type: "due_tomorrow_no_autopay", severity: "warning")

    IF daysUntilDue < 0 AND NOT hasMatchingTransactionSince(billItem, billItem.nextDueDate):
      fireAlert(type: "bill_overdue", severity: "critical")

    // Autopay failure detection
    IF billItem.autopay AND daysUntilDue == -1 AND NOT hasMatchingTransactionSince(billItem, billItem.nextDueDate):
      fireAlert(type: "autopay_likely_failed", severity: "critical")
```

### 3.3 Pseudo-rules — Subscriptions

```
ON daily_cron():
  FOR EACH subItem WHERE status == "active":
    daysUntilRenewal = subItem.nextDueDate - today

    IF subItem.subscriptionMeta.isFreeTrial
       AND subItem.subscriptionMeta.trialEndDate - today == 3:
      fireAlert(
        type: "trial_ending",
        severity: "warning",
        message: f"Your {subItem.name} free trial ends in 3 days —
                   you'll be charged ${subItem.amount}/{subItem.frequency}"
      )

    IF daysUntilRenewal == subItem.reminderDaysBefore
       AND NOT subItem.subscriptionMeta.isFreeTrial:
      fireAlert(type: "upcoming_renewal", severity: "info")

    daysSinceUsed = today - subItem.subscriptionMeta.lastUsedAt
    IF daysSinceUsed >= 60 AND subItem.amount >= UNUSED_ALERT_MIN_AMOUNT:
      fireAlert(
        type: "unused_subscription",
        severity: "info",
        message: f"You haven't used {subItem.name} in {daysSinceUsed} days —
                   that's ${subItem.amount * cyclesSince(daysSinceUsed, subItem.frequency)} spent unused",
        action: "Review or Cancel"
      )

ON subscriptionMeta.priceHistory updated:
  latestIncrease = newestEntry.amount - previousEntry.amount
  increasePct = latestIncrease / previousEntry.amount * 100
  IF increasePct > 0:
    fireAlert(
      type: "price_increase",
      severity: increasePct >= 15 ? "warning" : "info",
      message: f"{subItem.name} increased from ${previousEntry.amount}
                 to ${newestEntry.amount} ({increasePct}%)"
    )

ON new_recurring_item_created(item):
  duplicate = findSimilarActiveSubscription(item.merchant, item.svcCategory)
  // e.g., adding "Disney+" while "Hulu" + "ESPN+" bundle already exists,
  // or adding a second music streaming service
  IF duplicate exists:
    fireAlert(
      type: "possible_duplicate_service",
      severity: "info",
      message: f"You already track {duplicate.name} in the same category — still add {item.name}?"
    )
```

### 3.4 Notification copy principles

- **Bills**: lead with the *number* ("$142.50, up 20%") — bill anxiety is quantitative.
- **Subscriptions**: lead with the *decision* ("Trial ends in 3 days", "Cancel or keep?") — subscription anxiety is about choice, not arithmetic.
- Every anomaly alert (Tier 2) should carry a **one-tap action** (Cancel, Snooze, Mark as expected, Dismiss) — a notification that only informs, without an available next step, trains users to ignore the category.

---

## 4. User Flow: Adding a New Recurring Item

### 4.1 Step-by-step journey

```
1. Tap [+ Add] (FAB on mobile, "+ Add" button on desktop panel header)
   → Opens a single unified "Add Recurring Cost" sheet/modal
   → NOT two separate "Add Bill" / "Add Subscription" entry points —
     forcing the user to pre-classify before they've typed anything
     is the exact cognitive load this architecture is meant to avoid.

2. User types the name/merchant into a single autocomplete field
   → As they type, a merchant-lookup service suggests known matches
     ("Netflix", "PG&E", "Spotify Premium") with logos where available

3. System runs auto-classification (see 4.2) the moment merchant + amount
   + frequency are known — NOT on explicit user request
   → UI shows a soft, editable badge: "Detected as: Subscription"
   → Badge is a toggle, not a locked decision — one tap flips it to "Bill"
     if the system guessed wrong (e.g., a "variable" gym membership
     someone thinks of as a bill, not a subscription)

4. Form reveals TYPE-SPECIFIC fields only after classification,
   progressively — not all fields up front:

   Shared fields (always shown):
     Name · Amount · Frequency · Next Due Date · Account · Notify me

   If classified as Bill, additionally show:
     Category · This bill's amount varies (toggle) · Essential expense (toggle)

   If classified as Subscription, additionally show:
     Plan/tier (optional) · This is a free trial (toggle)
       → reveals "Trial ends on" date picker if toggled on
     How often do you use this? (1–5, optional, skippable)

5. User confirms → item saved, first reminder auto-scheduled per
   Section 3 defaults (editable later), confirmation toast shown
   with an "Undo" affordance for 5 seconds.
```

### 4.2 Auto-classification heuristic

Run this as a lightweight, explainable scoring function — not an opaque ML black box — so the "Detected as: X" badge can be trusted and quickly corrected:

```
FUNCTION classifyRecurringItem(merchantName, amount, frequency):
  score = 0   // positive → subscription, negative → bill

  // 1. Known merchant lookup (highest confidence signal)
  IF merchantName matches KNOWN_SUBSCRIPTION_MERCHANTS
     (Netflix, Spotify, Hulu, Adobe, iCloud, gym-chain list, SaaS list…):
    RETURN "subscription", confidence: HIGH

  IF merchantName matches KNOWN_BILL_MERCHANTS
     (utility company patterns, "rent", "mortgage", ISPs, insurers…):
    RETURN "bill", confidence: HIGH

  // 2. Heuristic scoring for unrecognized merchants
  IF frequency == "yearly": score += 2        // annual billing skews subscription
  IF frequency == "monthly": score += 1
  IF amount is round number (e.g., $9.99, $14.99, $29.00): score += 1  // classic SaaS pricing
  IF merchantName contains keywords
     ["subscription","membership","plan","premium","pro"]: score += 2
  IF merchantName contains keywords
     ["electric","water","gas co","insurance","rent","mortgage","hoa","loan"]: score -= 3
  IF amount varies >15% from any prior transaction with same merchant: score -= 2
     // variability is a bill trait, not a subscription trait

  RETURN score > 0 ? "subscription" : "bill", confidence: LOW
```

**Confidence handling in the UI:**
- `HIGH` confidence → badge shown pre-filled and calm (neutral color), user rarely needs to touch it.
- `LOW` confidence → badge shown with a subtle "not sure — check this" affordance (e.g., a dotted border or small "?" icon) so the system is honest about its own uncertainty rather than guessing silently.

### 4.3 Why this reduces cognitive load

- **One entry point, not two** — the user doesn't need to have already decided "is this a bill or a subscription" before they can even start typing, which is often the hardest part of the decision.
- **Progressive disclosure** — subscription-only fields (trial date, usage rating) never appear for a bill, and vice versa; the form never shows a field the user has to actively ignore.
- **Correctable, not locked** — auto-classification is a suggestion with a visible undo, not a hidden decision baked into the data model at creation time.
