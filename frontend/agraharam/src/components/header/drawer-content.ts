/**
 * Body styles shared by the household, house health and diagnostics drawers: labelled groups (<h3>, §5.1 heading
 * rules) holding one inset block of rows, each row a name with its value or status at the inline end.
 */
import { css } from 'lit';

export const drawerContentStyles = css`
  .lead {
    margin: 0 0 var(--agr-space-2);
    font: var(--agr-type-value);
    font-optical-sizing: auto;
    color: var(--agr-ink);
  }
  .note {
    margin: 0 0 var(--agr-space-5);
    font: var(--agr-type-meta);
    color: var(--agr-muted);
  }
  .group {
    margin: 0 0 var(--agr-space-6);
  }
  .group:last-child {
    margin-block-end: 0;
  }
  h3 {
    margin: 0 0 var(--agr-space-2);
    font: var(--agr-type-label);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--agr-muted);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
    border-radius: var(--agr-radius-inner);
    overflow: hidden;
    background: var(--agr-line);
  }
  .row {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--agr-space-3);
    min-block-size: var(--agr-target);
    margin: 0;
    padding: var(--agr-space-2) var(--agr-space-4);
    background: var(--agr-surface-inset);
  }
  .name {
    min-inline-size: 0;
    font: var(--agr-type-body);
    color: var(--agr-ink);
    overflow-wrap: anywhere;
  }
  .value {
    flex: none;
    max-inline-size: 60%;
    font: var(--agr-type-meta-strong);
    color: var(--agr-muted);
    text-align: end;
    overflow-wrap: anywhere;
  }
  .footnote {
    margin: var(--agr-space-2) 0 0;
    font: var(--agr-type-meta);
    color: var(--agr-muted);
  }
`;
