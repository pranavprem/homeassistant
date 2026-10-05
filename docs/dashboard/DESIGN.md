# Design direction

## Reference, not a clone

The supplied reference is a 1200×674 photograph/screenshot of a warm, composed
landscape smart-home dashboard. It has a slim top strip and three columns of
rounded panels: systems/upcoming/home on the left; dominant weather, climate and
media in the middle; cameras and garage/vehicle on the right. The visual language
is useful; the other household's personal content is not a product requirement.

The image is private local context at `.dashboard-local/reference-dashboard.jpg`.
Its colors below are an interpretation, not claimed pixel measurements. No image
generation is needed to build the UI; use code-native layout, icons and typography.

## Visual system

Suggested starting tokens (adjust after visually inspecting the result):

```css
--canvas: #e7e5d9;
--surface: #f5f3e9;
--surface-inset: #ebeade;
--ink: #2c3029;
--muted: #676c60;
--olive: #62745c;
--brass: #a18b50;
--plum: #69536f;
--danger: #a4453d;
--radius-panel: 24px;
--radius-inner: 15px;
--gap: 16px;
```

- Cream background, subtly distinct panels/insets, minimal borders and soft shadows.
- Elegant serif for the primary weather number and occasional editorial emphasis;
  clean sans-serif for controls, section labels and small values. Self-host licensed
  fonts with a bundled license or use good system fallbacks. No font CDN dependency.
- Short uppercase section labels with modest tracking; large useful values, not
  large decorative headings. Tabular numerals for clock, temperature and charge.
- Restrained line icons; consistent stroke/size. Color has semantic purpose.
- Muted plum can identify the media transport/volume accent. Reserve red for real
  warnings, not decorative gradients. No neon/cyberpunk or default dark SaaS look.
- Check text contrast; do not reproduce the reference's low-contrast small text.
- Buttons feel tactile, but not glossy. Brief transitions; respect reduced motion.

## Composition and content

### Header

Agraharam identity, compact household presence, actual alarm state, connection
indicator, local date/time. Avoid precise location or travel details. On phones,
prioritize status and time; use a menu/drawer for secondary information. An optional
short static greeting can replace the quote; do not require an external quote API.

### Left column — the home

Useful room/light shortcuts with status; vacuum progress/dock state; compact
appliance activity; next event only if supported. A house-health summary must be
based on named monitored inputs, never an invented blanket "All systems normal".
Put raw entity lists and infrastructure maintenance somewhere else.

### Middle column — today and comfort

Weather is the visual anchor: large number, condition, high/low when supplied,
sunset if supported, modest hourly strip. Do not invent forecast data if the
integration supports only daily forecasts. Below: grouped climate/air comfort
and a compact media card. Unit formatting comes from HA, not hardcoded °F.

### Right column — visibility and arrival

Two-by-two camera composition where suitable sources exist, otherwise use a
balanced smaller layout. Privacy tiles should look intentional, not broken.
Below: garage and available vehicle telemetry; minimal silhouette/line art rather
than scraping branded car images. Unconnected vehicles remain absent, not fake-live.

### Secondary UI

Room detail, climate, security controls, camera enlargement and media source
selection belong in keyboard-accessible drawers/dialogs. Keep Home scannable.
No public-facing entity IDs, service names, container actions or setup jargon.
Diagnostics can be behind a separate developer-only route or documented toggle.

## Responsive behavior

- Wide landscape (~1200 px content width and above): three balanced columns.
- Tablet/medium: two columns when needed; camera/media fit without clipping.
- Phone: one-column priority flow: urgent status → today/comfort → quick controls
  → camera/garage → secondary cards. Compact navigation; no shrunken desktop grid.
- Use **available container width**, not just browser width: HA's sidebar and
  toolbar reduce the actual card area. Verify expanded/collapsed sidebar cases.
- At least 44 px touch targets, visible keyboard focus, readable type and safe-area
  padding. No horizontal page scroll at 390 px. Drawers fit within small viewports.
- Support HA light/dark theme preference with a deliberately composed dark variant,
  but the cream/light design is the primary acceptance reference.

## Empty, unavailable and offline are design states

A missing optional integration can hide its tile. An existing device that goes
unavailable must remain visibly unavailable. Distinguish loading, disconnected,
privacy, missing binding, unavailable and permission denied. Keep layout stable
where practical; don't replace unknown temperatures/battery with 0 or healthy green.

The no-network demo should demonstrate these cases using fictional fixtures.
