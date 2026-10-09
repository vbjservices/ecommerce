import './styles.css';
import { readPublicConfig } from './config';
import { createBrowserDatabase } from './supabase';
import { checkAccess } from './auth';
import {
  readRecentCandidates,
  readRecentDiscoveryCandidates,
  readSalesChannels,
} from './workspace-repository';
import { isWorkspaceSnapshotFresh, type WorkspaceSnapshot } from './workspace-cache';
import {
  INITIAL_SHIPPING_MARKET,
  NOT_CHECKED_SHIPPING,
  shippingMarketStatusLabel,
} from '../domain/shipping';
import { compareDecimalAmounts, estimateReviewEconomics } from '../domain/reviews';
import { importedProductHash, readWorkspaceRoute } from './workspace-route';

const app = document.querySelector<HTMLElement>('#app')!;
const carouselTimers = new Set<number>();
const shopifyCallbackMessages: Record<string, string> = {
  connected: 'Shopify authorization completed successfully.',
  unsupported_request: 'The Shopify callback used an unsupported request. Start the connection again.',
  not_configured: 'The Shopify server secrets are incomplete.',
  approval_unverified: 'Shopify approval could not be verified. Start the connection again.',
  request_expired: 'The Shopify connection request expired. Start the connection again.',
  product_access_missing: 'Shopify did not grant product access. Confirm the app requests write_products.',
  token_storage_invalid: 'The Shopify token encryption key is invalid.',
  connection_save_failed: 'The Shopify connection could not be saved. Try connecting again.',
};
const initialUrl = new URL(window.location.href);
const shopifyCallbackCode = initialUrl.searchParams.get('shopify');
let shopifyCallbackNotice = shopifyCallbackCode
  ? shopifyCallbackMessages[shopifyCallbackCode] ?? 'The Shopify connection could not be completed.'
  : null;
if (initialUrl.searchParams.has('shopify')) {
  initialUrl.searchParams.delete('shopify');
  window.history.replaceState(null, '', `${initialUrl.pathname}${initialUrl.search}${initialUrl.hash}`);
}
const europeMarketCodes = new Set([
  'AL', 'AD', 'AT', 'BY', 'BE', 'BA', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IS', 'IE', 'IT', 'XK', 'LV', 'LI', 'LT', 'LU', 'MT', 'MD', 'MC',
  'ME', 'NL', 'MK', 'NO', 'PL', 'PT', 'RO', 'SM', 'RS', 'SK', 'SI', 'ES', 'SE', 'CH',
  'UA', 'GB', 'VA',
]);

function stopCarousels() {
  for (const timer of carouselTimers) window.clearInterval(timer);
  carouselTimers.clear();
}

// All API/user text uses textContent. HTML templates below contain static markup only.
function message(title: string, detail: string) {
  stopCarousels();
  app.innerHTML = '<section class="panel narrow"><p class="eyebrow">Workspace access</p><h1></h1><p class="description"></p><div class="actions"></div></section>';
  app.querySelector('h1')!.textContent = title;
  app.querySelector('.description')!.textContent = detail;
}

async function start() {
  let config;
  try { config = readPublicConfig(__PUBLIC_CONFIG__); }
  catch {
    message('Workspace setup pending', 'The Supabase connection has not been configured. Once setup is complete, sign in here with your internal account.');
    const note = document.createElement('p');
    note.className = 'footnote';
    note.textContent = 'Administrator: follow the Supabase setup steps in the repository documentation.';
    app.querySelector('.panel')!.append(note);
    return;
  }
  const client = createBrowserDatabase(config);
  let revision = 0;
  let snapshot: WorkspaceSnapshot | null = null;
  let refreshInFlight: Promise<void> | null = null;
  let activeView: 'discovery' | 'imported' = 'discovery';
  let tooltipSequence = 0;

  function action(label: string, handler: () => void) {
    const button = document.createElement('button');
    button.textContent = label;
    button.addEventListener('click', handler);
    app.querySelector('.actions')!.append(button);
  }

  async function signOut() {
    revision++;
    snapshot = null;
    message('Signing out…', 'Clearing this workspace session.');
    const result = await client.auth.signOut({ scope: 'local' });
    if (result.error) {
      message('Sign-out could not complete', 'Please try again. Closing this tab also clears its stored session.');
      action('Try again', () => { void signOut(); });
    } else { login(); }
  }

  function login() {
    app.innerHTML = `<section class="panel narrow">
      <p class="eyebrow">Workspace access</p><h1>Sign in</h1>
      <p class="description">Use your internal account to open the ecommerce workspace.</p>
      <form><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="username" required />
      <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required />
      <p class="form-error" role="alert"></p><button type="submit">Sign in to workspace <span aria-hidden="true">→</span></button></form>
      <p class="footnote">Access is managed by your workspace administrator.</p></section>`;
    const form = app.querySelector('form')!;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button')!;
      button.disabled = true;
      const data = new FormData(form);
      try {
        const result = await client.auth.signInWithPassword({ email: String(data.get('email')), password: String(data.get('password')) });
        if (result.error) throw new Error();
        (form.elements.namedItem('password') as HTMLInputElement).value = '';
        // SIGNED_IN below performs one authoritative workspace load.
      } catch {
        form.querySelector('.form-error')!.textContent = 'Sign-in failed. Check your email and password, or try again shortly.';
        button.disabled = false;
      }
    });
  }

  function cacheTime(fetchedAt: number) {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(fetchedAt);
  }

  function supplierCost(candidate: WorkspaceSnapshot['candidates'][number]) {
    const priced = candidate.supplier_products.supplier_variants.filter(
      (variant): variant is typeof variant & { cost: number | string; currency: string } =>
        variant.cost !== null && variant.currency !== null,
    );
    if (!priced.length) return 'Unknown';
    const currencies = new Set(priced.map((variant) => variant.currency));
    if (currencies.size !== 1) return 'Multiple currencies';
    const values = priced.map((variant) => Number(variant.cost));
    if (values.some((value) => !Number.isFinite(value))) return 'Unknown';
    const currency = priced[0]!.currency;
    const formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    const min = Math.min(...values);
    const max = Math.max(...values);
    return min === max ? formatter.format(min) : `${formatter.format(min)} \u2013 ${formatter.format(max)}`;
  }

  function supplierStock(candidate: WorkspaceSnapshot['candidates'][number]) {
    const known = candidate.supplier_products.supplier_variants
      .map((variant) => variant.stock)
      .filter((stock): stock is number => stock !== null);
    return known.length
      ? new Intl.NumberFormat().format(known.reduce((total, stock) => total + stock, 0))
      : 'Unknown';
  }

  function productShippingQuotes(candidate: WorkspaceSnapshot['candidates'][number]) {
    return [...candidate.supplier_products.supplier_variants]
      .sort((left, right) => {
        if (left.shipping_quotes.length !== right.shipping_quotes.length) {
          return right.shipping_quotes.length - left.shipping_quotes.length;
        }
        const newest = (quotes: typeof left.shipping_quotes) => Math.max(
          0, ...quotes.map((quote) => Date.parse(quote.quoted_at)).filter(Number.isFinite),
        );
        return newest(right.shipping_quotes) - newest(left.shipping_quotes);
      })[0]?.shipping_quotes ?? [];
  }

  function shippingOverview<Quote extends {
    available: boolean; cost: number | string | null; currency: string | null;
  }>(quotes: Quote[]) {
    if (!quotes.length) return {
      status: shippingMarketStatusLabel(NOT_CHECKED_SHIPPING),
      cost: 'Not checked',
    };
    const available = quotes.filter((quote) => quote.available);
    const unchecked = Math.max(0, INITIAL_SHIPPING_MARKET.totalDestinations - quotes.length);
    const coverage = unchecked
      ? `${available.length} confirmed · ${unchecked} unchecked`
      : `${available.length}/${INITIAL_SHIPPING_MARKET.totalDestinations} confirmed`;
    const priced = available.filter(
      (quote): quote is typeof quote & { cost: number | string; currency: string } =>
        quote.cost !== null && quote.currency !== null,
    );
    const currencies = new Set(priced.map((quote) => quote.currency));
    if (!priced.length || currencies.size !== 1) return { status: `Worldwide · ${coverage}`, cost: 'Unavailable' };
    const values = priced.map((quote) => Number(quote.cost));
    if (values.some((value) => !Number.isFinite(value))) return { status: `Worldwide · ${coverage}`, cost: 'Unknown' };
    const formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: priced[0]!.currency });
    const min = Math.min(...values);
    const max = Math.max(...values);
    return {
      status: `Worldwide · ${coverage}`,
      cost: min === max ? formatter.format(min) : `${formatter.format(min)} – ${formatter.format(max)}`,
    };
  }

  function shippingQuoteDetails<Quote extends {
    destination_country_code: string; available: boolean; cost: number | string | null;
    currency: string | null; delivery_days_min: number | null; delivery_days_max: number | null;
    shipping_method: string | null;
  }>(quotes: Quote[]) {
    if (!quotes.length) return null;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Worldwide shipping by checked country';
    const coverage = document.createElement('p');
    coverage.textContent = `${quotes.length} of ${INITIAL_SHIPPING_MARKET.totalDestinations} destinations checked. Unchecked does not mean unavailable.`;
    const list = document.createElement('ul');
    const names = new Intl.DisplayNames(undefined, { type: 'region' });
    for (const quote of [...quotes].sort((left, right) =>
      left.destination_country_code.localeCompare(right.destination_country_code))) {
      const destination = names.of(quote.destination_country_code) ?? quote.destination_country_code;
      const item = document.createElement('li');
      if (!quote.available || quote.cost === null || !quote.currency) {
        item.textContent = `${destination}: unavailable`;
      } else {
        const cost = new Intl.NumberFormat(undefined, {
          style: 'currency', currency: quote.currency,
        }).format(Number(quote.cost));
        const delivery = quote.delivery_days_min === null || quote.delivery_days_max === null
          ? ''
          : quote.delivery_days_min === quote.delivery_days_max
            ? ` · ${quote.delivery_days_min} days`
            : ` · ${quote.delivery_days_min}–${quote.delivery_days_max} days`;
        item.textContent = `${destination}: ${cost} · ${quote.shipping_method ?? 'Method unknown'}${delivery}`;
      }
      list.append(item);
    }
    details.append(summary, coverage, list);
    return details;
  }

  async function functionErrorMessage(error: unknown, fallback: string) {
    const context = error && typeof error === 'object' && 'context' in error
      ? (error as { context?: unknown }).context
      : null;
    let code: string | null = null;
    if (context instanceof Response) {
      const payload = await context.clone().json().catch(() => null) as { error?: unknown } | null;
      code = typeof payload?.error === 'string' ? payload.error : null;
    }
    return ({
      integration_not_configured: 'The CJ Edge secret is not configured.',
      provider_authentication: 'CJ rejected the configured API key.',
      provider_rate_limited: 'CJ\'s API point limit is temporarily exhausted. Try again after it replenishes.',
      provider_unavailable: 'CJ is temporarily unavailable. Try again shortly.',
      candidate_not_found: 'This product is no longer available to this workspace.',
      invalid_provider_payload: 'CJ returned product data that could not be safely imported.',
      persistence_failed: 'Supabase could not save the result. Check that all migrations ran.',
      quote_failed: 'The shipping estimate could not be completed.',
      review_validation_failed: 'Some review fields are invalid. Check the entered values.',
      review_candidate_not_found: 'This imported product is no longer available for review.',
      review_variant_mismatch: 'The selected variants no longer match this product. Refresh and try again.',
      review_incomplete: 'Select at least one market and one priced variant before approval.',
      review_fx_rate_required: 'Enter the current cost-to-EUR exchange rate before approval.',
      review_cost_missing: 'Every selected variant needs a current supplier cost before approval.',
      review_shipping_evidence_missing: 'Every selected market needs a confirmed shipping quote before approval.',
      review_rejection_note_required: 'Add a review note explaining why the product is rejected.',
      shopify_not_configured: 'Shopify is not configured in Supabase Edge Function Secrets.',
      shopify_not_connected: 'Connect the Shopify store before creating a draft.',
      shopify_token_unavailable: 'The saved Shopify connection could not be decrypted. Reconnect the store.',
      shopify_connection_persistence_failed: 'Supabase could not start the Shopify connection. Confirm the OAuth migration ran.',
      listing_candidate_not_approved: 'Approve the current product review before creating a Shopify draft.',
      listing_review_missing: 'Save and approve a product review before creating a Shopify draft.',
      listing_review_incomplete: 'The approved review no longer has a complete priced variant selection.',
      listing_in_progress: 'A Shopify draft request is already running. Refresh again shortly.',
      shopify_authentication_failed: 'Shopify rejected the configured app credentials.',
      shopify_product_rejected: 'Shopify rejected the draft data. Check the function logs for its private response.',
      shopify_response_invalid: 'Shopify returned an incomplete draft response. Try again shortly.',
      shopify_variant_mapping_missing: 'Shopify created the draft but did not return every variant mapping. Retry to reconcile it.',
      shopify_unavailable: 'Shopify is temporarily unavailable. Try again shortly.',
      listing_reconciliation_failed: 'The Shopify draft was created, but Supabase could not reconcile it. Retrying is safe.',
      listing_persistence_failed: 'Supabase could not prepare the Shopify draft. Confirm the listing migration ran.',
    } as Record<string, string>)[code ?? ''] ?? fallback;
  }

  function shippingScanControls(
    body: { candidateId: string } | { discoveryCandidateId: string },
    checkedDestinations: number,
  ) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = checkedDestinations === 0
      ? 'Start worldwide shipping scan'
      : checkedDestinations < INITIAL_SHIPPING_MARKET.totalDestinations
        ? 'Continue worldwide shipping scan'
        : 'Refresh worldwide shipping';
    const status = document.createElement('span');
    status.className = 'import-status';
    status.setAttribute('role', 'status');
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Checking shipping…';
      status.textContent = 'Checking the next 8 destinations. This can take around 20 seconds.';
      const result = await client.functions.invoke('quote-cj-shipping', { body });
      if (result.error) {
        button.disabled = false;
        button.textContent = 'Try shipping again';
        status.textContent = await functionErrorMessage(
          result.error,
          'Shipping check failed. Confirm the migration and function deployment.',
        );
        return;
      }
      button.textContent = 'Shipping checked';
      status.textContent = 'Worldwide shipping coverage updated.';
      await refresh({ force: true, background: true });
    });
    return { button, status };
  }

  function discoveryCost(candidate: WorkspaceSnapshot['discoveryCandidates'][number]) {
    const observation = candidate.supplier_product_observations[0];
    if (observation?.supplier_cost_min === null || observation?.supplier_cost_min === undefined ||
        observation.supplier_cost_max === null || !observation.currency) return 'Unknown';
    const min = Number(observation.supplier_cost_min);
    const max = Number(observation.supplier_cost_max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 'Unknown';
    const formatter = new Intl.NumberFormat(undefined, {
      style: 'currency', currency: observation.currency,
    });
    return min === max ? formatter.format(min) : `${formatter.format(min)} – ${formatter.format(max)}`;
  }

  function count(value: number | null | undefined) {
    return value === null || value === undefined ? 'Unknown' : new Intl.NumberFormat().format(value);
  }

  function deliveryWindow(candidate: WorkspaceSnapshot['discoveryCandidates'][number]) {
    const observation = candidate.supplier_product_observations[0];
    if (observation?.delivery_days_min === null || observation?.delivery_days_min === undefined ||
        observation.delivery_days_max === null) return 'Unknown';
    return observation.delivery_days_min === observation.delivery_days_max
      ? `${observation.delivery_days_min} days`
      : `${observation.delivery_days_min}–${observation.delivery_days_max} days`;
  }

  function metric(label: string, value: string, explanation?: string) {
    const item = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.append(document.createTextNode(label));
    if (explanation) {
      const help = document.createElement('span');
      help.className = 'field-help-overlay';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'field-help-trigger';
      button.textContent = 'i';
      button.setAttribute('aria-label', `About ${label}`);
      const tooltip = document.createElement('span');
      tooltip.className = 'field-help-tooltip';
      tooltip.id = `field-help-${++tooltipSequence}`;
      tooltip.setAttribute('role', 'tooltip');
      tooltip.textContent = explanation;
      button.setAttribute('aria-describedby', tooltip.id);
      help.append(button, tooltip);
      term.append(help);
    }
    detail.textContent = value;
    item.append(term, detail);
    return item;
  }

  function safeSourceUrl(value: string | null) {
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.href : null;
    } catch { return null; }
  }

  function imageCarousel(title: string, values: Array<string | null>, sizeClass: string) {
    const frame = document.createElement('div');
    frame.className = `${sizeClass} product-carousel`;
    const urls = [...new Set(values.map(safeSourceUrl).filter((url): url is string => url !== null))];
    if (!urls.length) {
      const fallback = document.createElement('span');
      fallback.textContent = 'No image';
      frame.append(fallback);
      return frame;
    }
    const track = document.createElement('div');
    track.className = 'carousel-track';
    for (const [index, url] of urls.entries()) {
      const image = document.createElement('img');
      image.src = url;
      image.alt = urls.length === 1 ? title : `${title}, image ${index + 1} of ${urls.length}`;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      track.append(image);
    }
    frame.append(track);
    if (urls.length === 1) return frame;

    let current = 0;
    let timer: number | null = null;
    let pausedByUser = false;
    const counter = document.createElement('span');
    counter.className = 'carousel-counter';
    const show = (next: number) => {
      current = (next + urls.length) % urls.length;
      track.style.transform = `translateX(-${current * 100}%)`;
      counter.textContent = `${current + 1} / ${urls.length}`;
    };
    const stop = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      carouselTimers.delete(timer);
      timer = null;
    };
    const start = () => {
      stop();
      if (pausedByUser || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      timer = window.setInterval(() => {
        if (!document.hidden) show(current + 1);
      }, 4_500);
      carouselTimers.add(timer);
    };
    const control = (direction: -1 | 1, label: string, symbol: string) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `carousel-control ${direction < 0 ? 'previous' : 'next'}`;
      button.setAttribute('aria-label', label);
      button.textContent = symbol;
      button.addEventListener('click', () => { show(current + direction); start(); });
      return button;
    };
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'carousel-toggle';
    const updateToggle = () => {
      toggle.textContent = pausedByUser ? '▶' : 'Ⅱ';
      toggle.setAttribute('aria-label', `${pausedByUser ? 'Play' : 'Pause'} images for ${title}`);
    };
    toggle.addEventListener('click', () => {
      pausedByUser = !pausedByUser;
      updateToggle();
      if (pausedByUser) stop(); else start();
    });
    updateToggle();
    frame.append(
      control(-1, `Previous image for ${title}`, '‹'),
      control(1, `Next image for ${title}`, '›'),
      toggle,
      counter,
    );
    frame.addEventListener('mouseenter', stop);
    frame.addEventListener('mouseleave', start);
    frame.addEventListener('focusin', stop);
    frame.addEventListener('focusout', (event) => {
      if (!frame.contains(event.relatedTarget as Node | null)) start();
    });
    show(0);
    start();
    return frame;
  }

  function formatCurrency(value: string | number, currency: string) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return 'Unknown';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
    } catch {
      return `${value} ${currency}`;
    }
  }

  function shopifyListingPanel(
    candidate: WorkspaceSnapshot['candidates'][number],
    salesChannels: WorkspaceSnapshot['salesChannels'],
  ) {
    const listing = candidate.listings.find((item) => item.sales_channels.provider === 'shopify');
    const connectedChannel = listing?.sales_channels.id
      ? salesChannels.find((channel) =>
          channel.id === listing.sales_channels.id && channel.connection_status === 'connected')
      : salesChannels.find((channel) =>
          channel.provider === 'shopify' && channel.connection_status === 'connected');
    const section = document.createElement('section');
    section.className = 'channel-listing-panel';
    if (candidate.status !== 'approved' && !listing) {
      section.hidden = true;
      return section;
    }

    const heading = document.createElement('div');
    heading.className = 'channel-listing-heading';
    const title = document.createElement('h3');
    title.textContent = 'Shopify draft';
    const badge = document.createElement('span');
    badge.className = `badge listing-${listing?.status ?? 'ready'}`;
    badge.textContent = listing?.status ?? 'ready';
    heading.append(title, badge);

    const detail = document.createElement('p');
    detail.className = 'channel-listing-detail';
    const stale = Boolean(listing && candidate.review &&
      Date.parse(candidate.review.updated_at) > Date.parse(listing.source_review_updated_at));
    if (!listing) {
      detail.textContent = 'The approved review is ready to create as an unpublished Shopify product.';
    } else if (listing.status === 'draft') {
      const count = listing.channel_listing_variants.length;
      detail.textContent = stale
        ? 'The review changed after the last Shopify sync. Update the draft before using it.'
        : `Unpublished draft saved with ${count} explicit variant mapping${count === 1 ? '' : 's'}${listing.synced_at ? ` · synced ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(listing.synced_at))}` : ''}.`;
    } else if (listing.status === 'failed') {
      detail.textContent = 'The last Shopify attempt failed without publishing the product. Retrying uses the same product identity.';
    } else if (listing.status === 'syncing' || listing.status === 'pending') {
      detail.textContent = 'The Shopify draft request is being processed.';
    } else {
      detail.textContent = `The recorded Shopify listing is ${listing.status}.`;
    }

    const actions = document.createElement('div');
    actions.className = 'channel-listing-actions';
    const status = document.createElement('span');
    status.className = 'review-status';
    status.setAttribute('role', 'status');
    if (candidate.status === 'approved' && listing?.status !== 'active' && listing?.status !== 'archived') {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = listing?.status === 'draft'
        ? stale ? 'Update Shopify draft' : 'Resync Shopify draft'
        : listing?.status === 'failed' ? 'Try Shopify draft again' : 'Create Shopify draft';
      if (listing?.status === 'syncing' || listing?.status === 'pending') {
        button.disabled = true;
        button.textContent = 'Creating Shopify draft…';
      } else if (!connectedChannel) {
        button.disabled = true;
        button.textContent = 'Connect Shopify first';
      }
      button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = listing ? 'Updating Shopify draft…' : 'Creating Shopify draft…';
        status.textContent = 'Sending approved content and selected variants to Shopify…';
        const result = await client.functions.invoke('publish-shopify-draft', {
          body: { candidateId: candidate.id, salesChannelId: connectedChannel?.id },
        });
        if (result.error) {
          button.disabled = false;
          button.textContent = listing ? 'Try Shopify draft again' : 'Create Shopify draft';
          status.textContent = await functionErrorMessage(
            result.error, 'The Shopify draft could not be created. Confirm the function deployment and secrets.',
          );
          return;
        }
        status.textContent = 'Unpublished Shopify draft saved.';
        await refresh({ force: true, background: true });
      });
      actions.append(button);
    }
    const store = listing?.sales_channels.external_account_id;
    const numericProductId = listing?.external_listing_id?.match(/^gid:\/\/shopify\/Product\/(\d+)$/)?.[1];
    if (store && numericProductId && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(store)) {
      const link = document.createElement('a');
      link.className = 'source-link';
      link.href = `https://${store}/admin/products/${numericProductId}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open Shopify draft ↗';
      actions.append(link);
    }
    actions.append(status);
    section.append(heading, detail, actions);
    return section;
  }

  function shopifyConnectionPanel(current: WorkspaceSnapshot) {
    const panel = document.createElement('section');
    panel.className = 'shopify-connection-panel';
    const connected = current.salesChannels.find(
      (channel) => channel.provider === 'shopify' && channel.connection_status === 'connected',
    );
    const copy = document.createElement('div');
    const heading = document.createElement('h2');
    heading.textContent = connected ? 'Shopify connected' : 'Connect Shopify';
    const detail = document.createElement('p');
    detail.textContent = connected
      ? `${connected.external_account_id ?? connected.name} can receive unpublished product drafts.`
      : 'Connect the permanent myshopify.com address for your existing store.';
    copy.append(heading, detail);
    if (shopifyCallbackNotice) {
      const notice = document.createElement('p');
      notice.className = 'review-status';
      notice.setAttribute('role', 'status');
      notice.textContent = shopifyCallbackNotice;
      copy.append(notice);
      shopifyCallbackNotice = null;
    }
    const controls = document.createElement('div');
    controls.className = 'shopify-connection-controls';
    if (connected) {
      const badge = document.createElement('span');
      badge.className = 'badge eligibility-pass';
      badge.textContent = 'Connected';
      controls.append(badge);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'store-name.myshopify.com';
      input.setAttribute('aria-label', 'Permanent Shopify store domain');
      input.autocomplete = 'off';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Connect store';
      const status = document.createElement('span');
      status.className = 'review-status';
      status.setAttribute('role', 'status');
      button.addEventListener('click', async () => {
        const shopDomain = input.value.trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
          status.textContent = 'Enter the permanent store-name.myshopify.com address.';
          input.focus();
          return;
        }
        button.disabled = true;
        button.textContent = 'Opening Shopify…';
        status.textContent = 'Preparing a secure Shopify approval request…';
        const result = await client.functions.invoke('start-shopify-connection', {
          body: { shopDomain },
        });
        const authorizationUrl = result.data && typeof result.data === 'object' &&
          'authorizationUrl' in result.data && typeof result.data.authorizationUrl === 'string'
          ? result.data.authorizationUrl : null;
        if (result.error || !authorizationUrl) {
          button.disabled = false;
          button.textContent = 'Try connection again';
          status.textContent = await functionErrorMessage(
            result.error,
            'The Shopify connection could not be started. Confirm the function deployment and secrets.',
          );
          return;
        }
        try {
          const target = new URL(authorizationUrl);
          if (target.protocol !== 'https:' || target.hostname !== shopDomain ||
              target.pathname !== '/admin/oauth/authorize') throw new Error();
          window.location.assign(target.href);
        } catch {
          button.disabled = false;
          button.textContent = 'Try connection again';
          status.textContent = 'The server returned an invalid Shopify approval address.';
        }
      });
      controls.append(input, button, status);
    }
    panel.append(copy, controls);
    return panel;
  }

  function reviewEditor(
    candidate: WorkspaceSnapshot['candidates'][number],
    standalone = false,
  ) {
    const review = candidate.review;
    const variants = candidate.supplier_products.supplier_variants;
    const productQuotes = productShippingQuotes(candidate);
    const sourceCurrencies = new Set([
      ...variants.map((variant) => variant.currency).filter((value): value is string => value !== null),
      ...productQuotes.map((quote) => quote.currency).filter((value): value is string => value !== null),
    ]);
    const costCurrency = review?.cost_currency ?? [...sourceCurrencies][0] ?? 'USD';
    const retailCurrency = review?.retail_currency ?? 'EUR';
    const reviewVariants = new Map(review?.product_review_variants.map(
      (variant) => [variant.supplier_variant_id, variant],
    ) ?? []);
    const selectedMarkets = new Set(review?.target_market_codes ?? []);
    const quoteByMarket = new Map(productQuotes
      .filter((quote) => quote.available && quote.cost !== null && quote.currency === costCurrency)
      .map((quote) => [quote.destination_country_code, quote]));
    const marketCodes = [...new Set([
      ...[...quoteByMarket.keys()].filter((code) => europeMarketCodes.has(code)),
      ...selectedMarkets,
    ])].sort();
    const names = new Intl.DisplayNames(undefined, { type: 'region' });

    const container = standalone ? document.createElement('section') : document.createElement('details');
    container.className = `review-panel${standalone ? ' standalone' : ''}`;
    if (!standalone && candidate.status === 'ready_for_review') {
      (container as HTMLDetailsElement).open = true;
    }
    const heading = document.createElement(standalone ? 'h2' : 'summary');
    heading.textContent = review ? 'Product review and pricing' : 'Prepare product for approval';
    const form = document.createElement('form');
    form.className = 'review-form';
    form.noValidate = true;

    const contentGrid = document.createElement('div');
    contentGrid.className = 'review-content-grid';
    const titleLabel = document.createElement('label');
    titleLabel.textContent = 'Store title';
    const titleInput = document.createElement('input');
    titleInput.maxLength = 255;
    titleInput.required = true;
    titleInput.value = review?.title ?? candidate.products.title;
    titleLabel.append(titleInput);
    const descriptionLabel = document.createElement('label');
    descriptionLabel.textContent = 'Store description';
    const descriptionInput = document.createElement('textarea');
    descriptionInput.maxLength = 10_000;
    descriptionInput.rows = 5;
    descriptionInput.value = review?.description ?? candidate.products.description ?? '';
    descriptionLabel.append(descriptionInput);
    contentGrid.append(titleLabel, descriptionLabel);

    const assumptions = document.createElement('fieldset');
    assumptions.className = 'review-assumptions';
    const assumptionsLegend = document.createElement('legend');
    assumptionsLegend.textContent = 'Pricing assumptions';
    const fxLabel = document.createElement('label');
    fxLabel.textContent = `${costCurrency} to ${retailCurrency} exchange rate`;
    const fxInput = document.createElement('input');
    fxInput.type = 'number';
    fxInput.min = '0.00000001';
    fxInput.step = '0.0001';
    fxInput.inputMode = 'decimal';
    fxInput.value = review?.cost_to_retail_fx_rate === null || review?.cost_to_retail_fx_rate === undefined
      ? costCurrency === retailCurrency ? '1' : ''
      : String(review.cost_to_retail_fx_rate);
    fxLabel.append(fxInput);
    const reserveLabel = document.createElement('label');
    reserveLabel.textContent = 'Variable cost reserve %';
    const reserveInput = document.createElement('input');
    reserveInput.type = 'number';
    reserveInput.min = '0';
    reserveInput.max = '99.999';
    reserveInput.step = '0.1';
    reserveInput.inputMode = 'decimal';
    reserveInput.value = String(review?.cost_reserve_percent ?? 0);
    reserveLabel.append(reserveInput);
    const assumptionHelp = document.createElement('p');
    assumptionHelp.className = 'field-help';
    assumptionHelp.textContent = 'Use the reserve for payment fees, VAT, advertising, returns, and other variable costs. Estimates use the highest selected-market quote from the scanned representative variant; verify materially different variants before publishing.';
    assumptions.append(assumptionsLegend, fxLabel, reserveLabel, assumptionHelp);

    const markets = document.createElement('fieldset');
    markets.className = 'review-markets';
    const marketLegend = document.createElement('legend');
    marketLegend.textContent = 'European target markets';
    markets.append(marketLegend);
    const marketInputs = new Map<string, HTMLInputElement>();
    if (!marketCodes.length) {
      const empty = document.createElement('p');
      empty.className = 'field-help';
      empty.textContent = 'Run the worldwide shipping scan until at least one European destination is confirmed.';
      markets.append(empty);
    } else {
      const marketGrid = document.createElement('div');
      marketGrid.className = 'market-grid';
      for (const code of marketCodes) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = code;
        input.checked = selectedMarkets.has(code);
        const available = quoteByMarket.has(code);
        if (!available) label.classList.add('market-unavailable');
        const name = names.of(code) ?? code;
        label.append(input, document.createTextNode(`${name}${available ? '' : ' · quote unavailable'}`));
        marketInputs.set(code, input);
        marketGrid.append(label);
      }
      markets.append(marketGrid);
    }

    const variantSection = document.createElement('section');
    variantSection.className = 'review-variants';
    const variantHeading = document.createElement('div');
    variantHeading.className = 'review-variant-heading';
    const variantTitle = document.createElement('h3');
    variantTitle.textContent = 'Variants and retail pricing';
    const applySuggestions = document.createElement('button');
    applySuggestions.type = 'button';
    applySuggestions.className = 'secondary-button';
    applySuggestions.textContent = 'Apply suggested prices';
    variantHeading.append(variantTitle, applySuggestions);
    const variantTable = document.createElement('div');
    variantTable.className = 'variant-review-table';
    const variantControls: Array<{
      selected: HTMLInputElement; price: HTMLInputElement; economics: HTMLElement;
      suggestion: HTMLButtonElement; cost: string | null;
    }> = [];

    const selectedMarketCodes = () => [...marketInputs]
      .filter(([, input]) => input.checked).map(([code]) => code);
    const worstShippingCost = () => {
      const selectedCodes = selectedMarketCodes();
      const quotes = selectedCodes.map((code) => quoteByMarket.get(code)).filter(
        (quote): quote is NonNullable<typeof quote> => quote !== undefined && quote.cost !== null,
      );
      if (!quotes.length || quotes.length !== selectedCodes.length) return null;
      return quotes.reduce((highest, quote) =>
        compareDecimalAmounts(quote.cost!, highest.cost!) === 1 ? quote : highest).cost;
    };
    const updateEconomics = () => {
      const shippingCost = worstShippingCost();
      for (const control of variantControls) {
        if (!control.cost || shippingCost === null || !fxInput.value) {
          control.economics.textContent = 'Landed cost unavailable';
          control.suggestion.textContent = 'Suggested price unavailable';
          delete control.suggestion.dataset.price;
          continue;
        }
        const preview = estimateReviewEconomics({
          supplierCost: control.cost,
          shippingCost,
          retailPrice: control.price.value || '1',
          costToRetailFxRate: fxInput.value,
          costReservePercent: reserveInput.value || '0',
        });
        if (!preview) {
          control.economics.textContent = 'Check pricing assumptions';
          control.suggestion.textContent = 'Suggested price unavailable';
          delete control.suggestion.dataset.price;
          continue;
        }
        control.suggestion.textContent = `Suggested ${formatCurrency(preview.suggestedRetailPrice, retailCurrency)}`;
        control.suggestion.dataset.price = preview.suggestedRetailPrice;
        control.economics.textContent = control.price.value
          ? `Landed ${formatCurrency(preview.landedCost, retailCurrency)} · Gross ${formatCurrency(preview.grossProfit, retailCurrency)} (${(preview.grossMarginBasisPoints / 100).toFixed(1)}%) · Contribution ${formatCurrency(preview.contributionProfit, retailCurrency)} (${(preview.contributionMarginBasisPoints / 100).toFixed(1)}%)`
          : `Landed ${formatCurrency(preview.landedCost, retailCurrency)}`;
      }
    };

    for (const variant of variants) {
      const saved = reviewVariants.get(variant.id);
      const row = document.createElement('div');
      row.className = 'variant-review-row';
      const identity = document.createElement('label');
      identity.className = 'variant-choice';
      const selected = document.createElement('input');
      selected.type = 'checkbox';
      selected.checked = saved?.selected ?? false;
      const thumbnail = document.createElement('div');
      thumbnail.className = 'variant-thumbnail';
      if (variant.image_url) {
        const image = document.createElement('img');
        image.src = variant.image_url;
        image.alt = 'Supplier image for this variant';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.referrerPolicy = 'no-referrer';
        thumbnail.append(image);
      } else {
        thumbnail.textContent = 'No image';
      }
      const optionText = Object.entries(variant.product_variants.options)
        .map(([name, value]) => `${name}: ${value}`).join(' · ');
      const variantName = document.createElement('span');
      variantName.textContent = optionText || variant.product_variants.sku || variant.external_variant_id;
      identity.append(selected, variantName);
      const facts = document.createElement('span');
      facts.className = 'variant-source-facts';
      facts.textContent = `${variant.cost === null || !variant.currency ? 'Cost unknown' : formatCurrency(variant.cost, variant.currency)} · ${variant.stock === null ? 'Stock unknown' : `${new Intl.NumberFormat().format(variant.stock)} stock`}`;
      const priceLabel = document.createElement('label');
      priceLabel.className = 'variant-price';
      priceLabel.textContent = `${retailCurrency} price`;
      const price = document.createElement('input');
      price.type = 'number';
      price.min = '0.01';
      price.step = '0.01';
      price.inputMode = 'decimal';
      price.value = saved?.retail_price === null || saved?.retail_price === undefined
        ? '' : String(saved.retail_price);
      priceLabel.append(price);
      const economics = document.createElement('span');
      economics.className = 'variant-economics';
      const suggestion = document.createElement('button');
      suggestion.type = 'button';
      suggestion.className = 'price-suggestion';
      suggestion.addEventListener('click', () => {
        if (!suggestion.dataset.price) return;
        price.value = suggestion.dataset.price;
        selected.checked = true;
        updateEconomics();
      });
      selected.addEventListener('change', updateEconomics);
      price.addEventListener('input', updateEconomics);
      row.append(thumbnail, identity, facts, priceLabel, economics, suggestion);
      variantTable.append(row);
      variantControls.push({
        selected, price, economics, suggestion,
        cost: variant.cost === null ? null : String(variant.cost),
      });
    }
    for (const input of marketInputs.values()) input.addEventListener('change', updateEconomics);
    fxInput.addEventListener('input', updateEconomics);
    reserveInput.addEventListener('input', updateEconomics);
    applySuggestions.addEventListener('click', () => {
      updateEconomics();
      for (const control of variantControls) {
        if (!control.selected.checked || !control.suggestion.dataset.price) continue;
        control.price.value = control.suggestion.dataset.price;
      }
      updateEconomics();
    });
    variantSection.append(variantHeading, variantTable);

    const notesLabel = document.createElement('label');
    notesLabel.textContent = 'Review notes';
    const notesInput = document.createElement('textarea');
    notesInput.maxLength = 5_000;
    notesInput.rows = 3;
    notesInput.placeholder = 'Record pricing assumptions, risks, or a rejection reason.';
    notesInput.value = review?.notes ?? '';
    notesLabel.append(notesInput);

    const resultStatus = document.createElement('p');
    resultStatus.className = 'review-status';
    resultStatus.setAttribute('role', 'status');
    const actions = document.createElement('div');
    actions.className = 'review-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = review ? 'Save review changes' : 'Save review';
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.textContent = candidate.status === 'approved' ? 'Reapprove changes' : 'Approve for Shopify draft';
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'danger-button';
    reject.textContent = 'Reject product';
    actions.append(save, approve, reject, resultStatus);

    const submit = async (action: 'save' | 'approve' | 'reject') => {
      for (const button of [save, approve, reject]) button.disabled = true;
      resultStatus.textContent = action === 'approve' ? 'Approving review…' : action === 'reject' ? 'Recording rejection…' : 'Saving review…';
      const result = await client.functions.invoke('review-product', {
        body: {
          candidateId: candidate.id,
          action,
          title: titleInput.value,
          description: descriptionInput.value,
          retailCurrency,
          costCurrency,
          costToRetailFxRate: fxInput.value || null,
          costReservePercent: reserveInput.value || '0',
          targetMarketCodes: selectedMarketCodes(),
          notes: notesInput.value,
          variants: variants.map((variant, index) => ({
            supplierVariantId: variant.id,
            selected: variantControls[index]!.selected.checked,
            retailPrice: variantControls[index]!.price.value || null,
          })),
        },
      });
      if (result.error) {
        for (const button of [save, approve, reject]) button.disabled = false;
        resultStatus.textContent = await functionErrorMessage(
          result.error, 'The review could not be saved. Confirm the migration and function deployment.',
        );
        return;
      }
      resultStatus.textContent = action === 'approve'
        ? 'Approved for Shopify draft creation.'
        : action === 'reject' ? 'Rejection recorded.' : 'Review saved.';
      await refresh({ force: true, background: true });
    };
    save.addEventListener('click', () => { void submit('save'); });
    approve.addEventListener('click', () => { void submit('approve'); });
    reject.addEventListener('click', () => { void submit('reject'); });

    form.addEventListener('submit', (event) => event.preventDefault());
    form.append(contentGrid, assumptions, markets, variantSection, notesLabel, actions);
    if (review?.product_review_events.length) {
      const history = document.createElement('details');
      history.className = 'review-history';
      const historySummary = document.createElement('summary');
      historySummary.textContent = `Review history (${review.product_review_events.length})`;
      const list = document.createElement('ul');
      for (const event of [...review.product_review_events].sort((left, right) =>
        Date.parse(right.created_at) - Date.parse(left.created_at))) {
        const item = document.createElement('li');
        item.textContent = `${event.event_type} · ${new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium', timeStyle: 'short',
        }).format(new Date(event.created_at))}${event.note ? ` · ${event.note}` : ''}`;
        list.append(item);
      }
      history.append(historySummary, list);
      form.append(history);
    }
    container.append(heading, form);
    updateEconomics();
    return container;
  }

  function renderDiscoveryCandidates(current: WorkspaceSnapshot) {
    const list = app.querySelector('.discovery-candidates')!;
    const importedProductIds = new Set(current.candidates.map(
      (candidate) => candidate.supplier_products.external_product_id,
    ));
    const candidates = current.discoveryCandidates.filter(
      (candidate) => !importedProductIds.has(candidate.external_product_id),
    );
    if (!candidates.length) {
      list.innerHTML = '<div class="empty compact"><h3>No products waiting in Discovery</h3><p>Run product discovery to find more products. Imported products stay available in their own tab.</p></div>';
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'discovery-list';
    for (const candidate of candidates) {
      const li = document.createElement('li');
      li.className = 'discovery-card';
      const imageFrame = imageCarousel(
        candidate.title,
        [...candidate.image_urls, candidate.image_url],
        'discovery-image',
      );
      const body = document.createElement('div');
      body.className = 'discovery-body';
      const heading = document.createElement('div');
      heading.className = 'candidate-heading';
      const identity = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = candidate.title;
      const context = document.createElement('p');
      context.className = 'candidate-supplier';
      context.textContent = `${candidate.suppliers.name} · “${candidate.discovery_runs.original_query}” · ${candidate.discovery_runs.profile_id}`;
      identity.append(title, context);
      const eligibility = document.createElement('span');
      eligibility.className = `badge eligibility-${candidate.eligibility_status}`;
      eligibility.textContent = candidate.eligibility_status;
      heading.append(identity, eligibility);
      const facts = document.createElement('dl');
      facts.className = 'candidate-facts discovery-facts';
      const strategyCount = new Set(candidate.discovery_occurrences.map((item) => item.strategy)).size;
      const observation = candidate.supplier_product_observations[0];
      const shipping = shippingOverview(candidate.shipping_quotes);
      facts.append(
        metric('Score', String(Math.round(Number(candidate.score)))),
        metric('Confidence', `${Math.round(Number(candidate.confidence))}%`),
        metric('Coverage', `${Math.round(Number(candidate.coverage))}%`),
        metric('Relevance', candidate.relevance_level),
        metric('Strategies', String(strategyCount)),
        metric('Supplier cost', discoveryCost(candidate)),
        metric('Reported stock', count(observation?.inventory)),
        metric('Verified stock', count(observation?.verified_inventory)),
        metric('CJ listings', count(observation?.listing_count)),
        metric('Delivery estimate', deliveryWindow(candidate)),
        metric('Variants', 'After import'),
        metric('Shipping', shipping.status),
        metric('Est. shipping · 1 unit', shipping.cost),
      );
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Why this product?';
      details.append(summary);
      for (const [label, values] of [
        ['Positive', candidate.assessment.positiveEvidence],
        ['Review', [
          ...candidate.assessment.eligibility.reasons,
          ...candidate.assessment.risks.map((risk) => risk.explanation),
        ]],
        ['Unknown', candidate.assessment.unknownEvidence],
      ] as const) {
        if (!values.length) continue;
        const group = document.createElement('div');
        group.className = 'evidence-group';
        const labelElement = document.createElement('b');
        labelElement.textContent = label;
        const evidenceList = document.createElement('ul');
        for (const value of [...new Set(values)]) {
          const item = document.createElement('li');
          item.textContent = value;
          evidenceList.append(item);
        }
        group.append(labelElement, evidenceList);
        details.append(group);
      }
      body.append(heading, facts, details);
      const quoteDetails = shippingQuoteDetails(candidate.shipping_quotes);
      if (quoteDetails) body.append(quoteDetails);
      const cardActions = document.createElement('div');
      cardActions.className = 'card-actions';
      const shippingControls = shippingScanControls(
        { discoveryCandidateId: candidate.id }, candidate.shipping_quotes.length,
      );
      cardActions.append(shippingControls.button, shippingControls.status);
      const importButton = document.createElement('button');
      importButton.type = 'button';
      importButton.textContent = 'Import to workspace';
      const importStatus = document.createElement('span');
      importStatus.className = 'import-status';
      importStatus.setAttribute('role', 'status');
      importButton.addEventListener('click', async () => {
        importButton.disabled = true;
        importButton.textContent = 'Importing to workspace…';
        importStatus.textContent = '';
        const result = await client.functions.invoke('import-cj-product', {
          body: { discoveryCandidateId: candidate.id },
        });
        if (result.error) {
          importButton.disabled = false;
          importButton.textContent = 'Try import again';
          importStatus.textContent = await functionErrorMessage(
            result.error,
            'Import failed. Check the function deployment and try again.',
          );
          return;
        }
        importButton.textContent = 'Imported';
        importStatus.textContent = 'Saved to Imported products.';
        await refresh({ force: true, background: true });
      });
      cardActions.append(importButton, importStatus);
      const sourceUrl = safeSourceUrl(candidate.source_url);
      if (sourceUrl) {
        const link = document.createElement('a');
        link.className = 'source-link';
        link.href = sourceUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'View supplier product ↗';
        cardActions.append(link);
      }
      body.append(cardActions);
      li.append(imageFrame, body);
      ul.append(li);
    }
    list.append(ul);
  }

  function renderWorkspace(current: WorkspaceSnapshot, status = `Updated ${cacheTime(current.fetchedAt)}`) {
    stopCarousels();
    const { access, candidates } = current;
    app.innerHTML = `<section class="workspace"><div class="workspace-heading"><div><p class="eyebrow">Overview</p><h1>Product workspace</h1></div><div class="actions"></div></div>
      <p class="account"></p><div class="shopify-connection-slot"></div><nav class="workspace-tabs" role="tablist" aria-label="Product workspace views">
      <button id="discovery-tab" type="button" role="tab" data-view="discovery">Discovery <span class="tab-count"></span></button>
      <button id="imported-tab" type="button" role="tab" data-view="imported">Imported products <span class="tab-count"></span></button></nav>
      <section class="panel discovery-panel" role="tabpanel" aria-labelledby="discovery-tab" data-panel="discovery"><div class="section-heading"><h2>Discovery shortlist</h2><span class="badge">Evidence ranked</span></div>
      <div class="discovery-candidates"></div></section>
      <section class="panel" role="tabpanel" aria-labelledby="imported-tab" data-panel="imported"><div class="section-heading"><h2>Imported products</h2><span class="badge">Supabase store</span></div>
      <div class="candidates"></div></section><p class="footnote refresh-status" role="status"></p>
      <p class="footnote">Costs, stock, and shipping are timestamped supplier estimates. Market demand and margin still need review.</p></section>`;
    app.querySelector('.account')!.textContent = `Signed in as ${access.email}`;
    app.querySelector('.shopify-connection-slot')!.append(shopifyConnectionPanel(current));
    app.querySelector('.refresh-status')!.textContent = status;
    action('Refresh', () => { void refresh({ force: true, background: true }); });
    action('Sign out', () => { void signOut(); });
    const selectView = (view: 'discovery' | 'imported') => {
      activeView = view;
      for (const tab of app.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
        const selected = tab.dataset.view === view;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
      for (const panel of app.querySelectorAll<HTMLElement>('[role="tabpanel"]')) {
        panel.hidden = panel.dataset.panel !== view;
      }
    };
    const tabs = app.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    const importedIds = new Set(candidates.map((candidate) => candidate.supplier_products.external_product_id));
    const discoveryCount = current.discoveryCandidates.filter(
      (candidate) => !importedIds.has(candidate.external_product_id),
    ).length;
    tabs[0]!.querySelector('.tab-count')!.textContent = String(discoveryCount);
    tabs[1]!.querySelector('.tab-count')!.textContent = String(candidates.length);
    for (const tab of tabs) {
      tab.addEventListener('click', () => selectView(tab.dataset.view as 'discovery' | 'imported'));
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const next = tab === tabs[0] ? tabs[1]! : tabs[0]!;
        next.focus();
        selectView(next.dataset.view as 'discovery' | 'imported');
      });
    }
    selectView(activeView);
    renderDiscoveryCandidates(current);
    const list = app.querySelector('.candidates')!;
    if (!candidates.length) {
      list.innerHTML = '<div class="empty"><span class="empty-mark" aria-hidden="true">＋</span><h3>No candidates yet</h3><p>Products will appear here after the first supplier import.</p></div>';
    } else {
      const ul = document.createElement('ul');
      ul.className = 'candidate-list imported-product-list';
      for (const candidate of candidates) {
        const li = document.createElement('li');
        li.className = 'imported-product-card';
        const link = document.createElement('a');
        link.className = 'imported-product-link';
        link.href = importedProductHash(candidate.id);
        link.addEventListener('click', () => { activeView = 'imported'; });
        const media = document.createElement('div');
        media.className = 'imported-product-media';
        const imageUrl = [...candidate.products.image_urls, candidate.products.image_url]
          .map(safeSourceUrl).find((value): value is string => value !== null);
        if (imageUrl) {
          const image = document.createElement('img');
          image.src = imageUrl;
          image.alt = '';
          image.loading = 'lazy';
          image.decoding = 'async';
          image.referrerPolicy = 'no-referrer';
          media.append(image);
        } else {
          media.textContent = 'No image';
        }
        const body = document.createElement('div');
        body.className = 'imported-product-summary';
        const heading = document.createElement('div');
        heading.className = 'candidate-heading';
        const identity = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = candidate.products.title;
        const supplier = document.createElement('p');
        supplier.className = 'candidate-supplier';
        supplier.textContent = `${candidate.supplier_products.suppliers.name} \u00b7 ${candidate.supplier_products.external_product_id}`;
        identity.append(title, supplier);
        const status = document.createElement('span');
        status.className = 'badge';
        status.textContent = candidate.status.replaceAll('_', ' ');
        heading.append(identity, status);

        const productQuotes = productShippingQuotes(candidate);
        const shipping = shippingOverview(productQuotes);
        const facts = document.createElement('dl');
        facts.className = 'candidate-facts imported-product-facts';
        facts.append(
          metric('Supplier cost', supplierCost(candidate)),
          metric('Variants', String(candidate.supplier_products.supplier_variants.length)),
          metric('Reported stock', supplierStock(candidate)),
          metric('Shipping', shipping.status),
        );
        const open = document.createElement('span');
        open.className = 'imported-product-open';
        open.textContent = 'Open product →';
        body.append(heading, facts, open);
        link.append(media, body);
        li.append(link);
        ul.append(li);
      }
      list.append(ul);
    }
  }

  function renderImportedProduct(
    current: WorkspaceSnapshot,
    candidate: WorkspaceSnapshot['candidates'][number],
    status = `Updated ${cacheTime(current.fetchedAt)}`,
  ) {
    stopCarousels();
    activeView = 'imported';
    app.innerHTML = `<section class="workspace imported-product-page">
      <div class="product-page-nav"></div>
      <div class="workspace-heading"><div><p class="eyebrow">Imported product</p><h1></h1></div><div class="actions"></div></div>
      <p class="account"></p>
      <section class="panel product-detail-panel"><div class="product-detail-hero"></div><div class="product-detail-content"></div></section>
      <p class="footnote refresh-status" role="status"></p>
      <p class="footnote">Costs, stock, and shipping are timestamped supplier estimates. Market demand and margin still need review.</p>
    </section>`;
    const back = document.createElement('a');
    back.className = 'product-page-back';
    back.href = `${window.location.pathname}${window.location.search}`;
    back.textContent = '← Back to imported products';
    back.addEventListener('click', (event) => {
      event.preventDefault();
      window.history.pushState(null, '', `${window.location.pathname}${window.location.search}`);
      renderWorkspace(current);
    });
    app.querySelector('.product-page-nav')!.append(back);
    app.querySelector('h1')!.textContent = candidate.products.title;
    app.querySelector('.account')!.textContent = `Signed in as ${current.access.email}`;
    app.querySelector('.refresh-status')!.textContent = status;
    action('Refresh', () => { void refresh({ force: true, background: true }); });
    action('Sign out', () => { void signOut(); });

    const productQuotes = productShippingQuotes(candidate);
    const shipping = shippingOverview(productQuotes);
    const hero = app.querySelector('.product-detail-hero')!;
    const media = imageCarousel(
      candidate.products.title,
      [...candidate.products.image_urls, candidate.products.image_url],
      'product-detail-media',
    );
    const summary = document.createElement('div');
    summary.className = 'product-detail-summary';
    const identity = document.createElement('div');
    identity.className = 'candidate-heading';
    const supplier = document.createElement('p');
    supplier.className = 'candidate-supplier';
    supplier.textContent = `${candidate.supplier_products.suppliers.name} · ${candidate.supplier_products.external_product_id}`;
    const candidateStatus = document.createElement('span');
    candidateStatus.className = 'badge';
    candidateStatus.textContent = candidate.status.replaceAll('_', ' ');
    identity.append(supplier, candidateStatus);
    const facts = document.createElement('dl');
    facts.className = 'candidate-facts product-detail-facts';
    facts.append(
      metric('Supplier cost', supplierCost(candidate),
        'The latest CJ supplier price or price range across imported variants. This is not the customer selling price.'),
      metric('Variants', String(candidate.supplier_products.supplier_variants.length),
        'The number of supplier variants currently stored for this product, such as colors, sizes, or bundles.'),
      metric('Reported stock', supplierStock(candidate),
        'The sum of the latest inventory values CJ reported for the stored variants. Supplier inventory is not proof of customer demand.'),
      metric('Last checked', new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium', timeStyle: 'short',
      }).format(new Date(candidate.supplier_products.last_seen_at)),
      'When the supplier product data was last retrieved. Cost and stock may have changed since this time.'),
      metric('Shipping', shipping.status,
        'Destination coverage from stored shipping checks. Unchecked destinations remain unknown rather than unavailable.'),
      metric('Est. shipping · 1 unit', shipping.cost,
        'The current one-unit shipping cost range across confirmed destinations. Quotes vary by destination, variant, method, and time.'),
    );
    const cardActions = document.createElement('div');
    cardActions.className = 'card-actions';
    const shippingControls = shippingScanControls({ candidateId: candidate.id }, productQuotes.length);
    cardActions.append(shippingControls.button, shippingControls.status);
    const sourceUrl = safeSourceUrl(candidate.supplier_products.source_url);
    if (sourceUrl) {
      const source = document.createElement('a');
      source.className = 'source-link';
      source.href = sourceUrl;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      source.textContent = 'View supplier product ↗';
      cardActions.append(source);
    }
    summary.append(identity, facts, cardActions);
    hero.append(media, summary);

    const content = app.querySelector('.product-detail-content')!;
    const quoteDetails = shippingQuoteDetails(productQuotes);
    if (quoteDetails) content.append(quoteDetails);
    content.append(
      reviewEditor(candidate, true),
      shopifyListingPanel(candidate, current.salesChannels),
    );
  }

  function renderCurrentRoute(
    current: WorkspaceSnapshot,
    status = `Updated ${cacheTime(current.fetchedAt)}`,
  ) {
    const route = readWorkspaceRoute(window.location.hash);
    if (route.kind === 'workspace') {
      renderWorkspace(current, status);
      return;
    }
    const candidate = current.candidates.find((item) => item.id === route.candidateId);
    if (candidate) {
      renderImportedProduct(current, candidate, status);
      return;
    }
    message('Imported product not found', 'This product is not available in the current workspace data.');
    action('Back to imported products', () => {
      activeView = 'imported';
      window.history.pushState(null, '', `${window.location.pathname}${window.location.search}`);
      renderWorkspace(current);
    });
  }

  async function performRefresh(background: boolean) {
    const current = ++revision;
    const preserveWorkspace = background && snapshot !== null && app.querySelector('.workspace') !== null;
    if (preserveWorkspace) {
      app.querySelector('.refresh-status')!.textContent = 'Refreshing quietly…';
    } else {
      message('Checking access…', 'Connecting to your workspace.');
    }
    try {
      const access = await checkAccess(client);
      if (current !== revision) return;
      if (access.status === 'signed_out') { login(); return; }
      if (access.status === 'denied') {
        message('Access not granted', 'Your account is signed in, but has not been authorized for this workspace. Contact your administrator.');
        action('Sign out', () => { void signOut(); });
        return;
      }
      const [candidates, discoveryCandidates, salesChannels] = await Promise.all([
        readRecentCandidates(client),
        readRecentDiscoveryCandidates(client),
        readSalesChannels(client),
      ]);
      if (current !== revision) return;
      snapshot = { access, candidates, discoveryCandidates, salesChannels, fetchedAt: Date.now() };
      renderCurrentRoute(snapshot);
    } catch (error) {
      if (current !== revision) return;
      if (preserveWorkspace && snapshot) {
        renderCurrentRoute(snapshot, `Refresh failed. Showing data from ${cacheTime(snapshot.fetchedAt)}.`);
        return;
      }
      message('Workspace unavailable', error instanceof Error ? error.message : 'Please try again shortly.');
      action('Try again', () => { void refresh({ force: true }); });
      action('Sign out', () => { void signOut(); });
    }
  }

  function refresh(options: { force?: boolean; background?: boolean } = {}) {
    if (!options.force && isWorkspaceSnapshotFresh(snapshot)) {
      if (!app.querySelector('.workspace')) renderCurrentRoute(snapshot);
      return Promise.resolve();
    }
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = performRefresh(options.background === true).finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }

  // Keep the callback synchronous; Supabase calls inside it can deadlock Auth.
  client.auth.onAuthStateChange((event, session) => {
    // Token rotation does not change membership or candidate data.
    if (event === 'TOKEN_REFRESHED') return;
    // Supabase can repeat SIGNED_IN for the current session, including on tab focus.
    if (event === 'SIGNED_IN' && snapshot?.access.userId === session?.user.id) return;
    revision++; // Discard in-flight responses after meaningful session changes.
    refreshInFlight = null;
    if (event === 'SIGNED_OUT') {
      snapshot = null;
      login();
      return;
    }
    if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'USER_UPDATED') {
      snapshot = null;
      setTimeout(() => { void refresh({ force: true }); }, 0);
    }
  });
  // Keep the current screen on tab switches. Revalidate quietly only after the cache expires.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !isWorkspaceSnapshotFresh(snapshot)) {
      void refresh({ background: snapshot !== null });
    }
  });
  window.addEventListener('hashchange', () => {
    if (snapshot) renderCurrentRoute(snapshot);
  });
}

void start();
