/* eslint-disable @typescript-eslint/no-explicit-any */
import { LitElement, html, css, TemplateResult, PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { HomeAssistant, LovelaceCard, LovelaceCardConfig } from 'custom-card-helpers';
import yaml from 'js-yaml';

import { SankeyConfigFileCardConfig } from './types';
import { version } from '../package.json';

/* eslint no-console: 0 */
console.info(
  `%c sankey-configfile-card %c v${version} `,
  'color: white; font-weight: bold; background: #2c5c8c',
  'color: #2c5c8c; font-weight: bold; background: white',
);

(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
  type: 'sankey-configfile-card',
  name: 'Sankey Config File Card',
  description: 'Wrapper card that loads any card configuration from an external YAML file',
  documentationURL: 'https://github.com/jebeke65/sankey-configfile-card',
});

const CARD_TAG = 'sankey-configfile-card';

@customElement(CARD_TAG)
export class SankeyConfigFileCard extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;

  @state() private _rawConfig?: SankeyConfigFileCardConfig;
  @state() private _innerCard?: LovelaceCard;
  @state() private _error?: string;

  public async setConfig(config: SankeyConfigFileCardConfig): Promise<void> {
    if (!config || typeof config !== 'object') {
      throw new Error('Invalid configuration');
    }
    if (!config.config_url && !config.card) {
      throw new Error('Either `config_url` or `card` is required');
    }

    this._rawConfig = config;
    this._error = undefined;

    // If an inline `card:` is provided, render it immediately — it acts both
    // as a ready-to-render fallback and as the base that the external YAML
    // is merged on top of.
    if (config.card) {
      await this._buildInnerCard(config.card);
    }

    if (config.config_url) {
      this._loadExternalConfig().catch(err => {
        console.error('sankey-configfile-card: config_url load failed', err);
        this._error = String(err?.message ?? err);
      });
    }
  }

  public getCardSize(): number | Promise<number> {
    if (this._innerCard && typeof (this._innerCard as any).getCardSize === 'function') {
      return (this._innerCard as any).getCardSize();
    }
    return 3;
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has('hass') && this._innerCard && this.hass) {
      this._innerCard.hass = this.hass;
    }
  }

  private _withCacheBust(url: string, enabled: boolean): string {
    if (!enabled) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}_cb=${Date.now()}`;
  }

  private async _loadExternalConfig(): Promise<void> {
    const raw = this._rawConfig;
    if (!raw?.config_url) return;

    const url = this._withCacheBust(raw.config_url, !!raw.cache_bust);
    const hass = this.hass as HomeAssistant & { fetchWithAuth?: typeof fetch };
    const doFetch = hass?.fetchWithAuth?.bind(hass) ?? fetch.bind(window);

    const resp = await doFetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to fetch ${raw.config_url}: HTTP ${resp.status}`);
    }
    const text = await resp.text();
    const loaded = yaml.load(text);
    if (!loaded || typeof loaded !== 'object') {
      throw new Error(`config_url YAML did not produce an object: ${raw.config_url}`);
    }

    // Merge loaded on top of inline `card:` (if any). Loaded keys win, so
    // external YAML can override everything — including `type:` — but the
    // inline config provides stable defaults (layout, height, theme…).
    const merged: LovelaceCardConfig = raw.card
      ? { ...raw.card, ...(loaded as Partial<LovelaceCardConfig>) }
      : (loaded as LovelaceCardConfig);

    await this._buildInnerCard(merged);
  }

  private async _buildInnerCard(innerConfig: LovelaceCardConfig): Promise<void> {
    if (!innerConfig || typeof innerConfig !== 'object' || typeof innerConfig.type !== 'string') {
      throw new Error('Loaded config must be an object with a `type` key');
    }

    const type = innerConfig.type;
    let el: LovelaceCard | null = null;

    // For `custom:...` cards, instantiate the custom element directly so we
    // can pass `isMetric` to setConfig — some cards (e.g. ha-sankey-chart)
    // require it. `helpers.createCardElement` only forwards the first arg.
    if (type.startsWith('custom:')) {
      const tag = type.slice('custom:'.length);
      const Ctor = customElements.get(tag);
      if (Ctor) {
        el = new Ctor() as LovelaceCard;
        const isMetric = this._isMetric();
        try {
          (el as any).setConfig(innerConfig, isMetric);
        } catch (err) {
          el = null;
          throw err;
        }
      } else {
        // Element not registered yet (resource still loading) — let helpers
        // handle the wait + error state.
        el = null;
      }
    }

    if (!el) {
      const helpers = await (window as any).loadCardHelpers?.();
      if (!helpers?.createCardElement) {
        throw new Error('Home Assistant card helpers are not available');
      }
      el = helpers.createCardElement(innerConfig) as LovelaceCard;
    }

    if (this.hass) {
      el!.hass = this.hass;
    }

    this._innerCard = el!;
    this._error = undefined;
    this.requestUpdate();
  }

  private _isMetric(): boolean {
    const unit = this.hass?.config?.unit_system?.temperature;
    // HA sends °C for metric, °F for imperial. Default to metric if unknown.
    return unit !== '°F';
  }

  protected render(): TemplateResult {
    if (this._error) {
      return html`
        <ha-card>
          <div class="error">
            <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
            <span>${this._error}</span>
          </div>
        </ha-card>
      `;
    }

    if (!this._innerCard) {
      return html`
        <ha-card>
          <div class="loading">Loading…</div>
        </ha-card>
      `;
    }

    return html`${this._innerCard}`;
  }

  static styles = css`
    :host {
      display: block;
    }
    .error {
      padding: 12px 16px;
      color: var(--error-color, #db4437);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .loading {
      padding: 12px 16px;
      opacity: 0.6;
      font-style: italic;
    }
  `;
}
