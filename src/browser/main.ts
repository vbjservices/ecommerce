import './styles.css';
import { readPublicConfig } from './config';
import { createBrowserDatabase } from './supabase';
import { checkAccess } from './auth';
import { readRecentCandidates, readRecentDiscoveryCandidates } from './workspace-repository';
import { isWorkspaceSnapshotFresh, type WorkspaceSnapshot } from './workspace-cache';
import {
  INITIAL_SHIPPING_MARKET,
  NOT_CHECKED_SHIPPING,
  shippingMarketStatusLabel,
} from '../domain/shipping';

const app = document.querySelector<HTMLElement>('#app')!;
const carouselTimers = new Set<number>();

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

  function shippingOverview(candidate: WorkspaceSnapshot['candidates'][number]) {
    const quotes = productShippingQuotes(candidate);
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

  function shippingQuoteDetails(candidate: WorkspaceSnapshot['candidates'][number]) {
    const quotes = productShippingQuotes(candidate);
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
      provider_unavailable: 'CJ is temporarily unavailable. Try again shortly.',
      candidate_not_found: 'This product is no longer available to this workspace.',
      invalid_provider_payload: 'CJ returned product data that could not be safely imported.',
      persistence_failed: 'Supabase could not save the result. Check that all migrations ran.',
      quote_failed: 'The shipping estimate could not be completed.',
    } as Record<string, string>)[code ?? ''] ?? fallback;
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

  function metric(label: string, value: string) {
    const item = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
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

  function renderDiscoveryCandidates(current: WorkspaceSnapshot) {
    const list = app.querySelector('.discovery-candidates')!;
    if (!current.discoveryCandidates.length) {
      list.innerHTML = '<div class="empty compact"><h3>No Discovery V2 runs yet</h3><p>Run the trusted discovery command after applying its migration.</p></div>';
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'discovery-list';
    const importedProductIds = new Set(current.candidates.map(
      (candidate) => candidate.supplier_products.external_product_id,
    ));
    for (const candidate of current.discoveryCandidates) {
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
        metric('Shipping', shippingMarketStatusLabel(NOT_CHECKED_SHIPPING)),
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
      const cardActions = document.createElement('div');
      cardActions.className = 'card-actions';
      const importButton = document.createElement('button');
      importButton.type = 'button';
      const alreadyImported = importedProductIds.has(candidate.external_product_id);
      importButton.textContent = alreadyImported ? 'Imported' : 'Import product';
      importButton.disabled = alreadyImported;
      const importStatus = document.createElement('span');
      importStatus.className = 'import-status';
      importStatus.setAttribute('role', 'status');
      importButton.addEventListener('click', async () => {
        importButton.disabled = true;
        importButton.textContent = 'Importing…';
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
      <p class="account"></p><nav class="workspace-tabs" role="tablist" aria-label="Product workspace views">
      <button id="discovery-tab" type="button" role="tab" data-view="discovery">Discovery <span class="tab-count"></span></button>
      <button id="imported-tab" type="button" role="tab" data-view="imported">Imported products <span class="tab-count"></span></button></nav>
      <section class="panel discovery-panel" role="tabpanel" aria-labelledby="discovery-tab" data-panel="discovery"><div class="section-heading"><h2>Discovery shortlist</h2><span class="badge">Evidence ranked</span></div>
      <div class="discovery-candidates"></div></section>
      <section class="panel" role="tabpanel" aria-labelledby="imported-tab" data-panel="imported"><div class="section-heading"><h2>Imported products</h2><span class="badge">Supabase store</span></div>
      <div class="candidates"></div></section><p class="footnote refresh-status" role="status"></p>
      <p class="footnote">Costs, stock, and shipping are timestamped supplier estimates. Market demand and margin still need review.</p></section>`;
    app.querySelector('.account')!.textContent = `Signed in as ${access.email}`;
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
    tabs[0]!.querySelector('.tab-count')!.textContent = String(current.discoveryCandidates.length);
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
      ul.className = 'candidate-list';
      for (const candidate of candidates) {
        const li = document.createElement('li');
        li.className = 'candidate-card';
        const media = imageCarousel(
          candidate.products.title,
          [...candidate.products.image_urls, candidate.products.image_url],
          'candidate-media',
        );
        const body = document.createElement('div');
        body.className = 'candidate-body';
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

        const shipping = shippingOverview(candidate);
        const facts = document.createElement('dl');
        facts.className = 'candidate-facts';
        facts.append(
          metric('Supplier cost', supplierCost(candidate)),
          metric('Variants', String(candidate.supplier_products.supplier_variants.length)),
          metric('Reported stock', supplierStock(candidate)),
          metric('Last checked', new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium', timeStyle: 'short',
          }).format(new Date(candidate.supplier_products.last_seen_at))),
          metric('Shipping', shipping.status),
          metric('Est. shipping · 1 unit', shipping.cost),
        );

        const sourceUrl = safeSourceUrl(candidate.supplier_products.source_url);
        body.append(heading, facts);
        const quoteDetails = shippingQuoteDetails(candidate);
        if (quoteDetails) body.append(quoteDetails);
        const cardActions = document.createElement('div');
        cardActions.className = 'card-actions';
        const quoteButton = document.createElement('button');
        quoteButton.type = 'button';
        const checkedDestinations = productShippingQuotes(candidate).length;
        quoteButton.textContent = checkedDestinations === 0
          ? 'Start worldwide shipping scan'
          : checkedDestinations < INITIAL_SHIPPING_MARKET.totalDestinations
            ? 'Continue worldwide shipping scan'
            : 'Refresh worldwide shipping';
        const quoteStatus = document.createElement('span');
        quoteStatus.className = 'import-status';
        quoteStatus.setAttribute('role', 'status');
        quoteButton.addEventListener('click', async () => {
          quoteButton.disabled = true;
          quoteButton.textContent = 'Checking shipping…';
          quoteStatus.textContent = 'Checking the next 20 destinations. This can take around 30 seconds.';
          const result = await client.functions.invoke('quote-cj-shipping', {
            body: { candidateId: candidate.id },
          });
          if (result.error) {
            quoteButton.disabled = false;
            quoteButton.textContent = 'Try shipping again';
            quoteStatus.textContent = await functionErrorMessage(
              result.error,
              'Shipping check failed. Confirm the migration and function deployment.',
            );
            return;
          }
          quoteButton.textContent = 'Shipping checked';
          quoteStatus.textContent = 'Worldwide shipping coverage updated.';
          await refresh({ force: true, background: true });
        });
        cardActions.append(quoteButton, quoteStatus);
        if (sourceUrl) {
          const link = document.createElement('a');
          link.className = 'source-link';
          link.href = sourceUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = 'View supplier product \u2197';
          cardActions.append(link);
        }
        body.append(cardActions);
        li.append(media, body);
        ul.append(li);
      }
      list.append(ul);
    }
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
      const [candidates, discoveryCandidates] = await Promise.all([
        readRecentCandidates(client),
        readRecentDiscoveryCandidates(client),
      ]);
      if (current !== revision) return;
      snapshot = { access, candidates, discoveryCandidates, fetchedAt: Date.now() };
      renderWorkspace(snapshot);
    } catch (error) {
      if (current !== revision) return;
      if (preserveWorkspace && snapshot) {
        renderWorkspace(snapshot, `Refresh failed. Showing data from ${cacheTime(snapshot.fetchedAt)}.`);
        return;
      }
      message('Workspace unavailable', error instanceof Error ? error.message : 'Please try again shortly.');
      action('Try again', () => { void refresh({ force: true }); });
      action('Sign out', () => { void signOut(); });
    }
  }

  function refresh(options: { force?: boolean; background?: boolean } = {}) {
    if (!options.force && isWorkspaceSnapshotFresh(snapshot)) {
      if (!app.querySelector('.workspace')) renderWorkspace(snapshot);
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
}

void start();
