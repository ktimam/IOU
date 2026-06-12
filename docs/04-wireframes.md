# IOU — Wireframes (v2)

> ASCII wireframes for the v1.0 PWA. Mobile-first; desktop is the same
> layouts with a wider grid.
> Conventions: `[btn]` = button, `▮` = filled field, `[+]` = primary,
> `▾` = dropdown, `→` = navigation, `·` = optional, `✱` = encrypted field
> (rendered decrypted in the UI; the lock glyph indicates "this is sealed
> on the canister").

---

## 0. Information architecture

```
/sign-in                not signed in
/set-name               signed in, no display name
/pairs                  list of pairs (default after sign-in if no active sheet)
/pair/:pairId           pair detail, list of sheets, replace-member
/pair/new               create a new pair (or join via code)
/sheet/new              create a sheet inside a pair
/sheet/:sheetId         active sheet dashboard
/sheet/:sheetId/history full history
/sheet/:sheetId/close   close-sheet confirmation
/inbox                  candidate entries from Telegram bot
/devices                signed-in devices
/settings               donate-ICP, sign out, recovery key (v1.1)
```

---

## 1. Sign-in (no auth)

```
┌────────────────────────────────────────┐
│                                        │
│              IOU                       │
│       Track who owes whom.             │
│       Encrypted. Yours only.           │
│                                        │
│      ┌──────────────────────────┐      │
│      │  Sign in with            │      │
│      │  Internet Identity       │ [+]  │
│      └──────────────────────────┘      │
│                                        │
│      No email. No password.            │
│      No one — not even us — can        │
│      read your data.                   │
│                                        │
└────────────────────────────────────────┘
```

Flow:
- Tap `[Sign in]` → II WebAuthn popup.
- On success: if no display name → `/set-name`; else if no pair → `/pair/new`;
  else → `/pairs`.

---

## 2. Set display name

```
┌────────────────────────────────────────┐
│  Welcome                                │
│  Pick a name your partner will see.     │
│                                         │
│  Display name ✱                         │
│  ▮▮▮▮▮▮▮▮▮▮▮▮▮▮_________________        │
│                                         │
│  (12 / 32)                              │
│                                         │
│  ✱ stored encrypted on the chain        │
│                                         │
│  [Continue]                    [+]      │
└────────────────────────────────────────┘
```

The lock glyph is a "trust cue" — we surface it once on this screen, and
on the entry form, and not anywhere else. (Trust cues lose value if
overused.)

---

## 3. Pairs (default landing page)

```
┌────────────────────────────────────────┐
│ IOU                            + New   │
├────────────────────────────────────────┤
│                                        │
│  Pairs                                  │
│  ┌──────────────────────────────────┐  │
│  │ 👤 Alice  ·  👤 Bob              │  │
│  │ 1 active sheet · 2 archived      │  │
│  │ Updated 2h ago                   │  │
│  └──────────────────────────────────┘  │
│  ┌──────────────────────────────────┐  │
│  │ 👤 Alice  ·  👤 Carol            │  │
│  │ 1 active sheet · 0 archived      │  │
│  │ Updated yesterday                │  │
│  └──────────────────────────────────┘  │
│                                        │
│  Inbox (3)                       →     │
│  Devices                         →     │
│  Settings                       →      │
│                                        │
└────────────────────────────────────────┘
```

Tap a pair → pair detail with sheets list.
`+ New` → create or join a pair.
`Inbox (3)` → inbox page (badge for unread).

---

## 4. Create / join a pair

```
┌────────────────────────────────────────┐
│  Set up a new pair                      │
│                                         │
│  ┌──────────────────┐  ┌──────────────┐ │
│  │  Create          │  │  Join        │ │
│  │                  │  │              │ │
│  │  Start a new     │  │  Enter the   │ │
│  │  relationship.   │  │  code your   │ │
│  │  Share the code  │  │  partner     │ │
│  │  with your       │  │  sent you.   │ │
│  │  partner.        │  │              │ │
│  │                  │  │  Invite code │ │
│  │  [Create]   [+]  │  │  ▮▮▮▮-▮▮▮▮  │ │
│  │                  │  │              │ │
│  │                  │  │  [Join]  [+] │ │
│  └──────────────────┘  └──────────────┘ │
└────────────────────────────────────────┘
```

After **Create** (creator, pending state):

```
┌────────────────────────────────────────┐
│  Share this code with your partner      │
│                                         │
│         ┌────────────────┐             │
│         │ XXXX-XXXX-XXXX │ [Copy]      │
│         └────────────────┘             │
│                                         │
│  The code expires in 24 hours.          │
│  [Rotate code]    [Revoke]              │
│                                         │
│  Waiting for partner… (spinner)         │
└────────────────────────────────────────┘
```

After **Join** (joiner, post-success):

```
┌────────────────────────────────────────┐
│  You're paired with Alice ✓             │
│  [Create a sheet]                [+]   │
└────────────────────────────────────────┘
```

---

## 5. Pair detail (sheets list)

```
┌────────────────────────────────────────┐
│  ← Pairs      Alice  ·  Bob      ⋯      │
├────────────────────────────────────────┤
│  Active sheet                           │
│  ┌──────────────────────────────────┐  │
│  │ "House — 2026"                  │  │
│  │ Created 2026-01-12 · 42 entries  │  │
│  │ Currencies: EGP, USD             │  │
│  │ 87 days to closing window        │  │
│  │ → Open                          │  │
│  └──────────────────────────────────┘  │
│                                         │
│  Archived sheets (2)                    │
│  ┌──────────────────────────────────┐  │
│  │ "House — 2025"   closed         │  │
│  │ Final balance: EGP +120 to Alice │  │
│  │ → Open                          │  │
│  └──────────────────────────────────┘  │
│  ┌──────────────────────────────────┐  │
│  │ "Trip — Greece 2025"  archived  │  │
│  │ → Open                          │  │
│  └──────────────────────────────────┘  │
│                                         │
│  [Start a new sheet]                    │
│  [Replace member]                       │
└────────────────────────────────────────┘
```

The `⋯` menu on the top-right: "Export ledger" / "Close this sheet"
(if eligible) / "Archive this sheet" (per-user view filter).

---

## 6. Sheet dashboard (the main screen)

```
┌────────────────────────────────────────┐
│ "House — 2026"           Alice ⌄  + Add │
├────────────────────────────────────────┤
│                                         │
│  Balances                               │
│  ┌─────────────┐ ┌─────────────┐        │
│  │ EGP         │ │ USD         │        │
│  │             │ │             │        │
│  │ Alice +420  │ │ Alice +12   │        │
│  │ Bob   -420  │ │ Bob   -12   │        │
│  │             │ │             │        │
│  │ Bob owes    │ │ Bob owes    │        │
│  │ Alice E£420 │ │ Alice $12   │        │
│  └─────────────┘ └─────────────┘        │
│                                         │
│  Converted this month (1)               │
│  #42  USD $20  → EGP 1,036              │
│  (rate 51.80, frankfurter, May 12)      │
│                                         │
│  Recent                                 │
│  ── Today ────────────────────────      │
│  #42  Bob   credit  USD $20  "Pizza"   ⋯│
│       → EGP 1,036 (convert)             │
│  #41  Alice debt   EGP 250  "Coffee"  ⋯│
│  ── Yesterday ─────────────────────     │
│  #40  Alice credit  EGP 1,500 "Rent"  ⋯│
│  …                                      │
│                          [See all →]    │
│                                         │
└────────────────────────────────────────┘
```

Converted entries show the target currency **and** the original in
brackets on the entry line, plus a `→ EGP X` annotation.

---

## 7. Add / edit entry

```
┌────────────────────────────────────────┐
│  Add entry                       [×]    │
│                                         │
│  I [owe]  ·  am owed   ←──►  toggle     │
│                                         │
│  Title ✱                                │
│  ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮________________        │
│                                         │
│  Description ✱ (optional)               │
│  ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮        │
│                                         │
│  Amount ✱        Currency ✱             │
│  ▮▮▮▮▮▮▮         [USD   ▾]              │
│                                         │
│  [ ] Convert to another currency ✱      │
│   └─ Target:  [EGP    ▾]                 │
│   └─ Rate:    51.80                     │
│   └─ "from frankfurter.app, May 12"     │
│   └─ [Override]                         │
│                                         │
│  [Cancel]                [Save]   [+]   │
└────────────────────────────────────────┘
```

Behavior:
- Toggling **Convert** expands the convert section and the form
  triggers `fx.fetchRate(originalCurrency, targetCurrency, today)`.
- If the rate fetch fails, the form shows "Provider unavailable, enter
  the rate manually" and the field becomes free-form.
- "Override" lets the user type a different rate; `rateSource` becomes
  `"user"`.
- The target currency list is filtered to the sheet's enabled currencies
  (other than the entry's own currency).
- The lock glyphs (`✱`) appear only on the field labels; we don't repeat
  them in the body to keep the form readable.

---

## 8. Entry detail

```
┌────────────────────────────────────────┐
│  #42                              [×]   │
│                                         │
│  Direction                              │
│  Bob → Alice   (credit, from Bob)       │
│                                         │
│  Title                                  │
│  Pizza                                  │
│                                         │
│  Description                            │
│  Friday night dinner with the team.     │
│                                         │
│  Amount                                 │
│  USD $20.00  (2,000 minor units)        │
│  Converted to EGP 1,036.00              │
│  Rate: 51.80 (frankfurter, May 12)      │
│                                         │
│  Created                                │
│  2026-05-12 21:14 UTC  by Bob           │
│                                         │
│  ✱ Encrypted on chain                   │
│                                         │
│  [Edit]                                 │
└────────────────────────────────────────┘
```

There is no **Delete** button. The audit trail is the point.

---

## 9. Inbox (Telegram-bot candidates)

```
┌────────────────────────────────────────┐
│  Inbox                          (3)     │
├────────────────────────────────────────┤
│                                         │
│  ┌──────────────────────────────────┐   │
│  │ 📷 IMG_20260512_211422.jpg       │   │
│  │ Suggested entry:                 │   │
│  │   Pizza  ·  USD 20.00            │   │
│  │   "Friday night dinner"          │   │
│  │   source: telegram-bot:@iou_…    │   │
│  │                                  │   │
│  │ Sheet:  [House — 2026       ▾]   │   │
│  │                                  │   │
│  │ [Add to sheet]    [Dismiss]      │   │
│  └──────────────────────────────────┘   │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │ 📷 receipt_20260510.jpg          │   │
│  │ Suggested entry:                 │   │
│  │   Groceries  ·  EGP 1,500        │   │
│  │   source: telegram-bot:@iou_…    │   │
│  │                                  │   │
│  │ Sheet:  [House — 2026       ▾]   │   │
│  │                                  │   │
│  │ [Add to sheet]    [Dismiss]      │   │
│  └──────────────────────────────────┘   │
│                                         │
│  [How does this work?]                  │
└────────────────────────────────────────┘
```

Tapping **Add to sheet** opens the regular Add Entry form pre-filled
with the inbox suggestion. The user reviews and confirms.

The "How does this work?" link explains that the Telegram bot uses
the user's own OpenAI key and posts to the user's own IOU inbox — no
inference cost is paid by the project.

---

## 10. Close sheet

```
┌────────────────────────────────────────┐
│  Close "House — 2026" ?                 │
│                                         │
│  This sheet hasn't had activity in      │
│  87 days.  Closing will:                │
│                                         │
│  · freeze this sheet (read-only)        │
│  · compute the final balance            │
│  · let you start a fresh sheet with     │
│    the closing balance as the           │
│    starting entry                       │
│                                         │
│  Closing balance:                       │
│   · EGP +420 to Alice                   │
│   · USD +12 to Alice                    │
│                                         │
│  You can still see and reference this   │
│  sheet from the Archived list.          │
│                                         │
│  [Cancel]                [Close]   [+]  │
└────────────────────────────────────────┘
```

---

## 11. Devices

```
┌────────────────────────────────────────┐
│  My devices                       [×]   │
├────────────────────────────────────────┤
│                                         │
│  This device                            │
│  ┌──────────────────────────────────┐   │
│  │ 📱 iPhone Safari                 │   │
│  │ First seen: 2026-04-01           │   │
│  │ Last used: just now              │   │
│  │ [Sign out this device]           │   │
│  └──────────────────────────────────┘   │
│                                         │
│  Other devices (1)                      │
│  ┌──────────────────────────────────┐   │
│  │ 💻 MacBook Chrome                │   │
│  │ First seen: 2026-05-30           │   │
│  │ Last used: 2h ago                │   │
│  │ [Sign out]                       │   │
│  └──────────────────────────────────┘   │
│                                         │
│  [Sign out everywhere]                  │
└────────────────────────────────────────┘
```

v1 ships "this device" + a sign-out-everywhere button. The per-other-device
view is v1.1 (needs the II inter-canister call).

---

## 12. Settings

```
┌────────────────────────────────────────┐
│  Settings                               │
│                                         │
│  Account                                │
│  Display name: Alice          [edit]     │
│  Principal:  abcd…-efgh   [copy]        │
│                                         │
│  Security                               │
│  Devices                           →     │
│  Recovery key (v1.1)               ·    │
│  Auto-lock:  after 30 min inactive  ▾   │
│                                         │
│  Support                                │
│  [Donate ICP]                           │
│   · to help cover canister cycles       │
│                                         │
│  Export                                 │
│  [Download sheet (JSON)]                │
│  [Download sheet (CSV)]                 │
│                                         │
└────────────────────────────────────────┘
```

---

## 13. Empty / error states

| State | Wireframe shorthand |
|-------|---------------------|
| No pairs yet | "You aren't paired with anyone yet." → create/join card |
| Pair pending, no invite consumed | "Waiting for your partner…" with rotating code and `[Copy]` |
| Sheet, no entries | "No transactions yet. Tap + to add your first." |
| Inbox empty | "No pending entries. Send a receipt to your Telegram bot to start." |
| Inbox service unreachable | "Your Telegram bot hasn't connected in 6h. Check `bot/` README." |
| FX fetch failed | "Rate provider unavailable. Enter the rate manually." (red note) |
| Wrong invite code | Red toast: "That code isn't valid."; input shakes |
| Already in a pair (joining) | "You're already in a pair. Leave that pair first." |
| Canister unreachable | "Can't reach the network. Retrying…" with retry button |
| Rate limited | "Slow down — too many requests. Try again in 12s." |
| Replace-member: missing new member's signature | "Your new partner hasn't accepted yet." |

---

## 14. Visual style (v1.0)

- **Type:** system font stack; headings 600, body 400.
- **Palette:** light only in v1; dark mode is a v1.1 stretch.
  - Background `#FAFAF7` (warm off-white)
  - Surface `#FFFFFF` with `0 1px 3px rgba(0,0,0,0.06)` shadow
  - Accent `#3B5BFF` (single primary blue)
  - Credit text `#0E8345`, debt text `#B42318`
  - Convert annotation `#7A6BFF` (purple-ish, subtle)
- **Spacing:** 4 / 8 / 16 / 24 / 32 grid; cards 16px padding.
- **Radii:** 12px on cards, 8px on inputs, 999px on chips.
- **Icons:** lucide-react. Lock icon used sparingly as a trust cue.
- **No emoji** in the UI; status uses words and small icons.
