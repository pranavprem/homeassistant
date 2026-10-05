/**
 * Animated SVG "live" placeholder for the demo camera dialog (§9.4, §10.1). Fictional and generated: no video, no
 * network. With reduced motion the animation stops on a static frame.
 */
import { css, html, LitElement, svg, type TemplateResult } from 'lit';
import { defineOnce } from '../util/define.ts';

class AgrDemoStream extends LitElement {
  static override styles = css`
    :host {
      display: block;
      inline-size: 100%;
      block-size: 100%;
      background: rgb(17 18 16);
    }
    svg {
      display: block;
      inline-size: 100%;
      block-size: 100%;
    }
    .cloud {
      animation: drift 18s linear infinite alternate;
    }
    .light {
      animation: pulse 4s ease-in-out infinite alternate;
    }
    .label {
      font:
        600 14px/1 system-ui,
        sans-serif;
      fill: #eceadf;
    }
    @keyframes drift {
      from {
        transform: translateX(-40px);
      }
      to {
        transform: translateX(60px);
      }
    }
    @keyframes pulse {
      from {
        opacity: 0.35;
      }
      to {
        opacity: 0.9;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .cloud,
      .light {
        animation: none;
      }
    }
  `;

  protected override render(): TemplateResult {
    return html`<svg viewBox="0 0 640 360" role="img" aria-label="Demo live view, fictional scene">
      ${svg`
        <rect width="640" height="360" fill="#3f4a3b"></rect>
        <rect y="230" width="640" height="130" fill="#6f7f68"></rect>
        <path d="M0 230 L180 150 L330 215 L470 140 L640 230 Z" fill="#2c3029" opacity="0.6"></path>
        <ellipse class="cloud" cx="200" cy="80" rx="90" ry="22" fill="#c9c3a8" opacity="0.5"></ellipse>
        <rect x="380" y="180" width="110" height="70" fill="#2c3029"></rect>
        <rect class="light" x="410" y="200" width="22" height="22" fill="#d8c48e"></rect>
        <text class="label" x="20" y="36">Demo live view</text>
      `}
    </svg>`;
  }
}

defineOnce('agr-demo-stream', AgrDemoStream);

declare global {
  interface HTMLElementTagNameMap {
    'agr-demo-stream': AgrDemoStream;
  }
}
