const prisma = require('../services/db');
const { webAppUrl } = require('../utils/publicUrls');
const logger = require('../services/logger');
// isEffectiveAdmin se requiruje lazy uvnitř handlerů — roleController ↔ auditController
// mají cyklus a top-level require by rozbil pořadí načítání (isEffectiveAdmin undefined).
let Stripe = null;

try {
  Stripe = require('stripe');
} catch {
  Stripe = null;
}

/**
 * Billing & Subscription Automation Controller
 */
const bankTransfer = require('../config/bankTransfer');
const { isAppOwnerRole } = require('../utils/authz');

class BillingController {
  /**
   * Canonical paid plans. Older ids are accepted only as aliases to avoid
   * breaking stale UI clients, but persisted tiers are Starter/Professional/Agency.
   */
  PLAN_MAP = {
    starter_monthly: {
      type: 'plan',
      targetValue: 'Starter',
      name: 'Nexus Starter',
      prices: { CZK: 290, EUR: 12, GBP: 10, USD: 13 },
      profilesLimit: 5,
      recurring: { interval: 'month', interval_count: 1 }
    },
    pro_monthly: {
      type: 'plan',
      targetValue: 'Professional',
      name: 'Nexus Professional',
      prices: { CZK: 990, EUR: 39, GBP: 35, USD: 45 },
      profilesLimit: 10,
      recurring: { interval: 'month', interval_count: 1 }
    },
    agency_monthly: {
      type: 'plan',
      targetValue: 'Agency',
      name: 'Nexus Agency',
      prices: { CZK: 2490, EUR: 99, GBP: 85, USD: 109 },
      profilesLimit: 20,
      recurring: { interval: 'month', interval_count: 1 }
    },
    ai_module: {
      type: 'addon',
      targetValue: 'ai_features',
      name: 'AI Optimizer Pack',
      prices: { CZK: 490, EUR: 20, GBP: 18, USD: 22 }
    },
    ai_opt: {
      type: 'addon',
      targetValue: 'ai_features',
      name: 'AI Optimizer Pack',
      prices: { CZK: 1200, EUR: 48, GBP: 42, USD: 52 }
    },
    analytics_module: {
      type: 'addon',
      targetValue: 'analytics',
      name: 'Analytics Module',
      prices: { CZK: 390, EUR: 16, GBP: 14, USD: 18 }
    },
    api_access: {
      type: 'addon',
      targetValue: 'api_access',
      name: 'Developer API Access',
      prices: { CZK: 290, EUR: 12, GBP: 10, USD: 13 }
    },
    senior_op: {
      type: 'addon',
      targetValue: 'senior_operator',
      name: 'Senior Operator Role',
      prices: { CZK: 500, EUR: 20, GBP: 18, USD: 22 }
    },
    vip_supp: {
      type: 'addon',
      targetValue: 'vip_support',
      name: 'Priority VIP Support',
      prices: { CZK: 2000, EUR: 80, GBP: 70, USD: 88 }
    },
    extra_profiles: {
      type: 'addon',
      targetValue: 'extra_profiles',
      name: 'Extra Profiles Pack',
      prices: { CZK: 250, EUR: 10, GBP: 9, USD: 11 }
    }
  };

  PLAN_ALIASES = {
    starter: 'starter_monthly',
    basic: 'starter_monthly',
    pro: 'pro_monthly',
    professional: 'pro_monthly',
    agency: 'agency_monthly',
    enterprise: 'agency_monthly',
    monthly: 'pro_monthly'
  };

  MARKET_CURRENCY = {
    cz: 'CZK',
    eu: 'EUR',
    uk: 'GBP',
    us: 'USD'
  };

  get stripe() {
    if (!process.env.STRIPE_SECRET_KEY) return null;
    if (!Stripe) return null;
    if (!this._stripe) {
      this._stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    }
    return this._stripe;
  }

  normalizePlanId(planId) {
    const raw = String(planId || '').trim();
    const lower = raw.toLowerCase();
    return this.PLAN_ALIASES[lower] || raw;
  }

  normalizeCurrency(currency, market) {
    const fromMarket = this.MARKET_CURRENCY[String(market || '').toLowerCase()];
    const normalized = String(currency || fromMarket || 'CZK').toUpperCase();
    return ['CZK', 'EUR', 'GBP', 'USD'].includes(normalized) ? normalized : 'CZK';
  }

  normalizeStripeStatus(status) {
    if (status === 'active' || status === 'trialing') return 'ACTIVE';
    if (status === 'past_due' || status === 'unpaid' || status === 'incomplete' || status === 'incomplete_expired') return 'PAST_DUE';
    if (status === 'canceled') return 'CANCELLED';
    return status ? String(status).toUpperCase() : 'ACTIVE';
  }

  priceFor(item, currency) {
    const value = item.prices?.[currency] ?? item.price;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  toMinorUnits(amount) {
    return Math.round(Number(amount) * 100);
  }

  fromMinorUnits(amount) {
    const parsed = Number(amount);
    return Number.isFinite(parsed) ? parsed / 100 : null;
  }

  fromStripeTimestamp(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed * 1000) : null;
  }

  fallbackExpiresAt(days = 30) {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  // Zalozni adresa pro navrat ze Stripe. V bezne situaci se nepouzije — klient
  // posila `successUrl: window.location.href` (PlansDashboard.jsx a dalsi),
  // takze navrat jde za prohlizecem. Zalohu potrebuje jen volani, ktere adresu
  // neposlalo.
  //
  // Driv tu byla zapsana `https://nexus-sync-8d50b.web.app/settings`, tedy
  // jmeno odvozene od Firebase projektu. Prestehovani webu by z ni udelalo
  // odkaz nikam — a poznalo by se to az ve chvili, kdy se nekdo vraci z platby.
  // Bere se proto z `webAppUrl()`, tedy z APP_URL nebo z ALLOWED_ORIGINS.
  zalozniAdresaNavratu() {
    const zaklad = webAppUrl();
    if (!zaklad) {
      // Relativni ani prazdna adresa Stripe neprojde, a poslat uzivatele na
      // zanikly host je horsi nez selhat nahlas.
      throw new Error(
        'Nelze sestavit navratovou adresu pro Stripe: klient neposlal successUrl ' +
        'a server nema APP_URL ani https origin v ALLOWED_ORIGINS.'
      );
    }
    return `${zaklad}/settings`;
  }

  checkoutUrl(baseUrl, status) {
    const url = baseUrl || this.zalozniAdresaNavratu();
    const separator = url.includes('?') ? '&' : '?';
    return status === 'success'
      ? `${url}${separator}checkout=success&session_id={CHECKOUT_SESSION_ID}`
      : `${url}${separator}checkout=cancelled`;
  }

  portalReturnUrl(baseUrl) {
    return baseUrl || this.zalozniAdresaNavratu();
  }

  safeJson(value, fallback = {}) {
    try {
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  async resolveBillingItem(planId, currency) {
    const canonicalPlanId = this.normalizePlanId(planId);
    const config = this.PLAN_MAP[canonicalPlanId];
    if (!config) return null;

    return {
      ...config,
      id: canonicalPlanId,
      price: this.priceFor(config, currency),
      currency,
      durationDays: config.type === 'plan' ? 30 : 30,
      metadata: {
        profilesLimit: config.profilesLimit ? String(config.profilesLimit) : ''
      }
    };
  }

  stripePriceEnvKey(planId, currency) {
    const normalized = String(planId || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    return `STRIPE_PRICE_${normalized}_${currency}`;
  }

  stripeLookupKey(planId, currency, item) {
    const cadence = item.type === 'plan'
      ? `${item.recurring?.interval || 'month'}_${item.recurring?.interval_count || 1}`
      : 'one_time';
    return `nexus_${String(planId).toLowerCase()}_${currency.toLowerCase()}_${cadence}`.replace(/[^a-z0-9_]/g, '_');
  }

  async getOrCreateStripePrice(planId, currency, item) {
    const envKey = this.stripePriceEnvKey(planId, currency);
    if (process.env[envKey]) return process.env[envKey];

    if (!this.stripe?.prices?.list || !this.stripe?.prices?.create) return null;

    try {
      const lookupKey = this.stripeLookupKey(planId, currency, item);
      const existing = await this.stripe.prices.list({
        lookup_keys: [lookupKey],
        active: true,
        limit: 1
      });

      if (existing?.data?.[0]?.id) return existing.data[0].id;

      const payload = {
        currency: currency.toLowerCase(),
        unit_amount: this.toMinorUnits(item.price),
        lookup_key: lookupKey,
        product_data: {
          name: item.name || `Nexus ${item.targetValue}`,
          metadata: {
            planId,
            type: item.type,
            targetValue: item.targetValue,
            ...(item.metadata || {})
          }
        },
        metadata: {
          planId,
          type: item.type,
          targetValue: item.targetValue,
          currency
        }
      };

      if (item.type === 'plan') {
        payload.recurring = item.recurring || { interval: 'month', interval_count: 1 };
      }

      const created = await this.stripe.prices.create(payload);
      return created?.id || null;
    } catch (error) {
      logger.warn('[Billing] Stripe price sync failed; falling back to inline price_data:', error.message);
      return null;
    }
  }

  async getOrCreateStripeCustomer(agencyId, userEmail) {
    const agency = await prisma.agency.findUnique({
      where: { id: agencyId },
      select: { id: true, name: true, email: true, stripeCustomerId: true }
    });

    if (agency?.stripeCustomerId) {
      return { agency, customerId: agency.stripeCustomerId };
    }

    const customer = await this.stripe.customers.create({
      email: agency?.email || userEmail || undefined,
      name: agency?.name || undefined,
      metadata: { agencyId }
    });

    if (customer?.id) {
      await prisma.agency.update({
        where: { id: agencyId },
        data: { stripeCustomerId: customer.id }
      });
    }

    return { agency, customerId: customer?.id || null };
  }

  async createCheckoutSession(req, res) {
    try {
      // Billing je vyhrazené Agency Adminovi / App Ownerovi (ne Operator/Model).
      const { isEffectiveAdmin } = require('./roleController');
      if (!(await isEffectiveAdmin(req.user?.role, req.user?.agencyId))) {
        return res.status(403).json({ message: 'Only agency admins can manage billing' });
      }
      const { agencyId } = req.user;
      if (!agencyId) {
        return res.status(403).json({
          code: 'agency_required',
          message: 'Billing checkout requires an agency-scoped user.'
        });
      }

      const {
        planId: requestedPlanId,
        paymentMethod = 'card',
        checkoutMode: requestedCheckoutMode = 'redirect',
        successUrl,
        cancelUrl,
        currency: requestedCurrency,
        market
      } = req.body;
      const planId = this.normalizePlanId(requestedPlanId);
      const currency = this.normalizeCurrency(requestedCurrency, market);
      const checkoutMode = String(requestedCheckoutMode || '').toLowerCase() === 'embedded' ? 'embedded' : 'redirect';

      if (paymentMethod !== 'card' && paymentMethod !== 'transfer') {
        return res.status(400).json({
          code: 'unsupported_payment_method',
          message: 'Supported payment methods: card, transfer.'
        });
      }

      // Převod se nabízí, jen když je zapnutý. Vystavit platební pokyny dřív,
      // než je čím platby párovat, znamená vybrat peníze a nezapnout službu.
      if (paymentMethod === 'transfer' && !bankTransfer.jeZapnuty()) {
        return res.status(400).json({
          code: 'bank_transfer_disabled',
          message: 'Bank transfer is not enabled on this backend.'
        });
      }

      const planConfig = await this.resolveBillingItem(planId, currency);
      if (!planConfig) {
        return res.status(400).json({ message: `Invalid planId: ${requestedPlanId}` });
      }

      const { type, targetValue, price, durationDays = 30 } = planConfig;
      if (!price) return res.status(400).json({ message: `Price is not configured for ${planId} in ${currency}` });

      if (paymentMethod === 'transfer') {
        return this.createBankTransferOrder(res, {
          agencyId, planId, requestedPlanId, type, targetValue, price, currency, market, durationDays
        });
      }

      const mockBillingAllowed = process.env.NODE_ENV === 'test' ||
        (process.env.NODE_ENV !== 'production' && process.env.ALLOW_MOCK_BILLING === 'true');
      if (process.env.STRIPE_SECRET_KEY && !Stripe && !mockBillingAllowed) {
        return res.status(503).json({
          code: 'stripe_dependency_missing',
          message: 'Stripe SDK is not installed on the backend.'
        });
      }

      if (!this.stripe && !mockBillingAllowed) {
        return res.status(503).json({
          code: 'stripe_not_configured',
          message: 'Stripe is not configured. Set STRIPE_SECRET_KEY on the backend.'
        });
      }

      const expiresAt = this.fallbackExpiresAt(durationDays);
      const note = {
        type,
        targetValue,
        planId,
        requestedPlanId: requestedPlanId || null,
        paymentMethod: 'card',
        provider: this.stripe ? 'stripe' : 'mock',
        currency,
        market: market || null
      };

      const subscription = await prisma.subscription.create({
        data: {
          agencyId,
          plan: targetValue,
          status: 'PENDING',
          amountPaid: price,
          currency,
          expiresAt,
          provider: this.stripe ? 'stripe' : 'mock',
          providerStatus: 'checkout_pending',
          note: JSON.stringify(note)
        }
      });

      if (!this.stripe && mockBillingAllowed) {
        const mockUrl = `${successUrl || 'http://localhost:3000/success'}?session_id=${subscription.id}`;
        return res.json({
          paymentMethod: 'card',
          provider: 'mock',
          id: subscription.id,
          localSubscriptionId: subscription.id,
          url: mockUrl,
          message: 'Mock checkout session created'
        });
      }

      const { customerId } = await this.getOrCreateStripeCustomer(agencyId, req.user.email);
      let checkoutCustomerId = customerId;
      let stripePriceId = await this.getOrCreateStripePrice(planId, currency, planConfig);
      const mode = type === 'plan' ? 'subscription' : 'payment';
      const metadata = {
        localSubscriptionId: subscription.id,
        agencyId,
        planId,
        type,
        targetValue
      };

      const buildLineItem = (priceId) => priceId
        ? { quantity: 1, price: priceId }
        : {
          quantity: 1,
          price_data: {
            currency: currency.toLowerCase(),
            unit_amount: this.toMinorUnits(price),
            product_data: {
              name: planConfig.name || `Nexus ${targetValue}`,
              metadata: {
                planId,
                type,
                targetValue,
                ...(planConfig.metadata || {})
              }
            },
            ...(mode === 'subscription' ? { recurring: planConfig.recurring || { interval: 'month', interval_count: 1 } } : {})
          }
        };

      const buildCustomerPayload = (linkedCustomerId) => linkedCustomerId
        ? { customer: linkedCustomerId }
        : { customer_email: req.user.email || undefined };

      const buildSessionPayload = (priceId, linkedCustomerId) => {
        const payload = {
          mode,
          line_items: [buildLineItem(priceId)],
          client_reference_id: subscription.id,
          metadata,
          allow_promotion_codes: true,
          ...buildCustomerPayload(linkedCustomerId)
        };

        if (checkoutMode === 'embedded') {
          payload.ui_mode = 'embedded_page';
          payload.return_url = this.checkoutUrl(successUrl, 'success');
          payload.redirect_on_completion = 'if_required';
        } else {
          payload.success_url = this.checkoutUrl(successUrl, 'success');
          payload.cancel_url = this.checkoutUrl(cancelUrl || successUrl, 'cancel');
        }

        if (mode === 'subscription') {
          payload.subscription_data = { metadata };
        } else {
          payload.payment_intent_data = { metadata };
        }

        return payload;
      };

      const attempts = [];
      const pushAttempt = (label, priceId, linkedCustomerId) => {
        const exists = attempts.some(attempt => attempt.priceId === priceId && attempt.linkedCustomerId === linkedCustomerId);
        if (!exists) attempts.push({ label, priceId, linkedCustomerId });
      };

      pushAttempt(stripePriceId ? 'configured_price' : 'inline_price_data', stripePriceId, checkoutCustomerId);
      if (stripePriceId) pushAttempt('inline_price_data', null, checkoutCustomerId);
      if (checkoutCustomerId) pushAttempt('inline_price_data_customer_email', null, null);

      let session;
      let lastCheckoutError = null;
      for (const attempt of attempts) {
        const sessionPayload = buildSessionPayload(attempt.priceId, attempt.linkedCustomerId);
        try {
          session = await this.stripe.checkout.sessions.create(sessionPayload);
          stripePriceId = attempt.priceId;
          checkoutCustomerId = attempt.linkedCustomerId;
          break;
        } catch (error) {
          lastCheckoutError = error;
          logger.warn(`[Billing] Stripe checkout attempt failed (${attempt.label}); trying next fallback:`, error.message);
        }
      }

      if (!session) throw lastCheckoutError || new Error('Stripe checkout session was not created');

      const sessionCustomerId = typeof session.customer === 'string'
        ? session.customer
        : session.customer?.id || checkoutCustomerId || null;

      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          paymentRef: session.id,
          provider: 'stripe',
          providerStatus: 'checkout_created',
          stripeCheckoutSessionId: session.id,
          stripeCustomerId: sessionCustomerId,
          stripePriceId,
          note: JSON.stringify({ ...note, stripeSessionId: session.id, stripeMode: mode, stripeCheckoutMode: checkoutMode, stripeCustomerId: sessionCustomerId, stripePriceId })
        }
      });

      res.json({
        paymentMethod: 'card',
        provider: 'stripe',
        checkoutMode,
        id: session.id,
        localSubscriptionId: subscription.id,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
        clientSecret: checkoutMode === 'embedded' ? session.client_secret || null : null,
        url: session.url,
        message: 'Stripe Checkout session created'
      });
    } catch (error) {
      logger.error('[Billing] Create Session Error:', error);
      res.status(500).json({ message: 'Failed to initialize payment' });
    }
  }

  /**
   * Objednávka k zaplacení převodem.
   *
   * Nezapíná nic. Vytvoří jen čekající předplatné s variabilním symbolem a
   * vrátí platební pokyny; aktivuje se teprve tehdy, až dorazí peníze —
   * automaticky přes fioSyncWorker, nebo ručně potvrzením App Ownera.
   *
   * `amountPaid` tu neznamená „zaplaceno", ale „očekáváno". Na tuhle hodnotu
   * se v `_activateSubscription` porovnává skutečně přijatá částka, takže
   * nesmí chybět — bez ní by šlo aktivovat plán poslaním jedné koruny.
   */
  async createBankTransferOrder(res, { agencyId, planId, requestedPlanId, type, targetValue, price, currency, market, durationDays }) {
    // Jedna nezaplacená objednávka na plán stačí. Bez tohohle by každé
    // kliknutí vyrobilo další VS a zákazník by měl na výběr z pěti různých
    // symbolů, z nichž čtyři by nikdy nikdo nespároval.
    const stavajici = await prisma.subscription.findFirst({
      where: { agencyId, status: 'PENDING', provider: 'bank_transfer', plan: targetValue },
      orderBy: { createdAt: 'desc' },
    });
    if (stavajici && stavajici.paymentRef) {
      return res.json(this.bankTransferOdpoved(stavajici, { planId, price, currency }));
    }

    // VS musí být jedinečný — párování jde výhradně přes něj. Kolize by
    // znamenala, že platba jedné agentury aktivuje předplatné jiné.
    let vs = null;
    for (let pokus = 0; pokus < 5 && !vs; pokus += 1) {
      const kandidat = bankTransfer.vygenerujVS();
      const obsazeny = await prisma.subscription.findFirst({ where: { paymentRef: kandidat } });
      if (!obsazeny) vs = kandidat;
    }
    if (!vs) {
      logger.error('[Billing] Nepodařilo se vygenerovat jedinečný variabilní symbol');
      return res.status(503).json({ code: 'vs_generation_failed', message: 'Could not allocate a payment reference.' });
    }

    const splatnost = new Date(Date.now() + bankTransfer.SPLATNOST_DNI * 24 * 60 * 60 * 1000);
    const note = {
      type,
      targetValue,
      planId,
      requestedPlanId: requestedPlanId || null,
      paymentMethod: 'transfer',
      provider: 'bank_transfer',
      currency,
      market: market || null,
      dueAt: splatnost.toISOString(),
    };

    const subscription = await prisma.subscription.create({
      data: {
        agencyId,
        plan: targetValue,
        status: 'PENDING',
        amountPaid: price,
        currency,
        // Předplatné poběží od zaplacení, ne od objednání — `expiresAt` se
        // při aktivaci přepočítá. Tady drží jen splatnost objednávky.
        expiresAt: this.fallbackExpiresAt(durationDays),
        provider: 'bank_transfer',
        providerStatus: 'awaiting_transfer',
        paymentRef: vs,
        note: JSON.stringify(note),
      },
    });

    logger.info(`[Billing] Objednávka převodem: agentura ${agencyId}, plán ${targetValue}, VS ${vs}, ${price} ${currency}`);
    return res.json(this.bankTransferOdpoved(subscription, { planId, price, currency }));
  }

  /** Platební pokyny pro klienta. Token k Fio API se sem nikdy nedostane. */
  bankTransferOdpoved(subscription, { planId, price, currency }) {
    const udaje = bankTransfer.bankovniUdaje();
    const note = this.safeJson(subscription.note);
    return {
      paymentMethod: 'transfer',
      provider: 'bank_transfer',
      id: subscription.id,
      localSubscriptionId: subscription.id,
      status: subscription.status,
      planId,
      pokyny: {
        ...udaje,
        castka: price ?? subscription.amountPaid,
        mena: currency || subscription.currency,
        variabilniSymbol: subscription.paymentRef,
        splatnostDo: note.dueAt || null,
        automatickePotvrzeni: bankTransfer.maAutomatickeParovani(),
      },
    };
  }

  /**
   * Které způsoby platby server opravdu umí.
   *
   * Bez tohohle by klient nabízel převod i tam, kde není zapnutý, uživatel
   * by klikl a dostal chybu. Nabízet platbu, která nefunguje, je horší než
   * ji nenabízet vůbec.
   */
  async getPaymentMethods(req, res) {
    return res.json({
      card: Boolean(this.stripe) || process.env.NODE_ENV === 'test' || process.env.ALLOW_MOCK_BILLING === 'true',
      transfer: bankTransfer.jeZapnuty(),
    });
  }

  /**
   * Čekající platby převodem — seznam pro ruční potvrzení.
   *
   * Vidí je jedině App Owner, protože potvrzení je zásah do peněz napříč
   * agenturami: kdyby to směl Agency Admin, potvrdil by si vlastní platbu sám.
   */
  async listPendingTransfers(req, res) {
    if (!isAppOwnerRole(req.user?.role)) {
      return res.status(403).json({ message: 'Only the app owner can review bank transfers' });
    }
    const cekajici = await prisma.subscription.findMany({
      where: { status: 'PENDING', provider: 'bank_transfer' },
      include: { agency: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return res.json({
      ok: true,
      automatickeParovani: bankTransfer.maAutomatickeParovani(),
      polozky: cekajici.map((s) => {
        const note = this.safeJson(s.note);
        return {
          id: s.id,
          agentura: s.agency?.name || s.agencyId,
          agencyId: s.agencyId,
          email: s.agency?.email || null,
          plan: s.plan,
          castka: s.amountPaid,
          mena: s.currency,
          variabilniSymbol: s.paymentRef,
          vytvoreno: s.createdAt,
          splatnostDo: note.dueAt || null,
          poSplatnosti: note.dueAt ? new Date(note.dueAt) < new Date() : false,
        };
      }),
    });
  }

  /**
   * Ruční potvrzení přijaté platby.
   *
   * Existuje pro případ, kdy není nastavený token k Fio API nebo banka
   * nedostupná. Bez téhle možnosti platí, že zákazník zaplatí a nestane se
   * nic — u platební funkce nejhorší možný výsledek.
   *
   * Potvrzující tvrdí, že peníze dorazily. Proto to smí jedině App Owner,
   * proto se to zapisuje do auditu se jménem a proto se sem předává
   * OČEKÁVANÁ částka: kontrola v `_activateSubscription` se tím nevypíná,
   * jen se prohlašuje, že přišla celá.
   */
  async confirmBankTransfer(req, res) {
    if (!isAppOwnerRole(req.user?.role)) {
      return res.status(403).json({ message: 'Only the app owner can confirm bank transfers' });
    }
    const { subscriptionId, note: poznamka } = req.body || {};
    if (!subscriptionId) return res.status(400).json({ message: 'subscriptionId required' });

    const objednavka = await prisma.subscription.findFirst({
      where: { id: String(subscriptionId), status: 'PENDING', provider: 'bank_transfer' },
    });
    if (!objednavka) return res.status(404).json({ message: 'Pending bank transfer not found' });
    if (!objednavka.paymentRef) return res.status(409).json({ message: 'Order has no payment reference' });

    const vysledek = await this._activateSubscription(objednavka.paymentRef, true, {
      provider: 'bank_transfer_manual',
      providerStatus: 'confirmed_manually',
      amount: objednavka.amountPaid,
      currency: objednavka.currency,
    });

    if (!vysledek.success) {
      logger.warn(`[Billing] Ruční potvrzení VS ${objednavka.paymentRef} selhalo: ${vysledek.message}`);
      return res.status(409).json({ ok: false, message: vysledek.message });
    }

    // Zápis do auditu je součást operace, ne kosmetika: je to jediná stopa
    // o tom, kdo prohlásil, že peníze dorazily.
    try {
      // Načteno až tady: auditController a billingController se odkazují
      // navzájem a při načtení na začátku souboru by `logAction` byl
      // undefined. Zápis do auditu je v try/catch, takže by to neshodilo
      // potvrzení — jen by tiše nevznikla jediná stopa o tom, kdo peníze
      // prohlásil za přijaté.
      const { logAction } = require('./auditController');
      await logAction(
        objednavka.agencyId,
        req.user.userId,
        'BANK_TRANSFER_CONFIRMED',
        JSON.stringify({
          subscriptionId: objednavka.id,
          variabilniSymbol: objednavka.paymentRef,
          castka: objednavka.amountPaid,
          mena: objednavka.currency,
          plan: objednavka.plan,
          poznamka: poznamka || null,
        })
      );
    } catch (e) {
      logger.error('[Billing] Potvrzení proběhlo, ale nezapsalo se do auditu:', e.message);
    }

    logger.info(`[Billing] Platba převodem potvrzena ručně: VS ${objednavka.paymentRef}, agentura ${objednavka.agencyId}, potvrdil ${req.user.userId}`);
    return res.json({ ok: true, targetValue: vysledek.targetValue });
  }

  async createPortalSession(req, res) {
    try {
      // Billing portal (zrušení předplatného, změna platby) — jen Agency Admin / App Owner.
      const { isEffectiveAdmin } = require('./roleController');
      if (!(await isEffectiveAdmin(req.user?.role, req.user?.agencyId))) {
        return res.status(403).json({ message: 'Only agency admins can manage billing' });
      }
      if (!this.stripe) {
        const code = process.env.STRIPE_SECRET_KEY && !Stripe ? 'stripe_dependency_missing' : 'stripe_not_configured';
        return res.status(503).json({
          code,
          message: code === 'stripe_dependency_missing'
            ? 'Stripe SDK is not installed on the backend.'
            : 'Stripe is not configured. Set STRIPE_SECRET_KEY on the backend.'
        });
      }

      const agency = await prisma.agency.findUnique({
        where: { id: req.user.agencyId },
        select: { id: true, stripeCustomerId: true }
      });

      let customerId = agency?.stripeCustomerId || null;
      if (!customerId) {
        const active = await prisma.subscription.findFirst({
          where: {
            agencyId: req.user.agencyId,
            provider: 'stripe',
            status: { in: ['ACTIVE', 'PAST_DUE', 'TRIAL'] }
          },
          orderBy: { updatedAt: 'desc' }
        });
        customerId = active?.stripeCustomerId || null;
      }

      if (!customerId) {
        return res.status(404).json({
          code: 'stripe_customer_missing',
          message: 'No Stripe customer is linked to this agency yet.'
        });
      }

      const session = await this.stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: this.portalReturnUrl(req.body?.returnUrl)
      });

      res.json({ provider: 'stripe', url: session.url });
    } catch (error) {
      logger.error('[Billing] Portal Session Error:', error);
      res.status(500).json({ message: 'Failed to open billing portal' });
    }
  }

  async handleWebhook(req, res) {
    try {
      const allowUnsignedWebhook = process.env.NODE_ENV === 'test' ||
        (process.env.NODE_ENV !== 'production' && process.env.ALLOW_UNSIGNED_BILLING_WEBHOOK === 'true');
      let eventType = null;
      let payload = null;
      let manualPayload = null;

      if (Buffer.isBuffer(req.body)) {
        const signature = req.headers['stripe-signature'];
        if (signature && process.env.STRIPE_WEBHOOK_SECRET && this.stripe) {
          let event;
          try {
            event = this.stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
          } catch (error) {
            logger.warn('[Billing Webhook] Invalid Stripe signature:', error.message);
            return res.status(400).json({
              code: 'stripe_signature_invalid',
              message: 'Invalid Stripe webhook signature'
            });
          }
          eventType = event.type;
          payload = event.data?.object || {};
        } else if (process.env.NODE_ENV === 'test') {
          const parsed = JSON.parse(req.body.toString('utf8') || '{}');
          if (parsed?.object === 'event') {
            eventType = parsed.type;
            payload = parsed.data?.object || {};
          } else {
            manualPayload = parsed;
          }
        } else {
          return res.status(400).json({ message: 'Missing Stripe webhook signature configuration' });
        }
      } else if (allowUnsignedWebhook && req.body?.id && req.body?.object === 'event') {
        eventType = req.body.type;
        payload = req.body.data?.object || {};
      } else if (allowUnsignedWebhook) {
        manualPayload = req.body;
      } else {
        return res.status(400).json({ message: 'Unsigned billing webhook rejected' });
      }

      if (manualPayload) {
        if (!manualPayload.sessionId || manualPayload.status !== 'PAID') return res.status(200).json({ received: true });
        const result = await this._activateSubscription(manualPayload.sessionId, false, {
          provider: 'mock',
          providerStatus: 'active'
        });
        if (!result.success) return res.status(404).json({ message: result.message });
        return res.json({ ok: true, activated: result.targetValue });
      }

      const result = await this.processStripeEvent(eventType, payload);
      if (result?.notFound) return res.status(404).json({ message: result.message });
      return res.json({ received: true, ...result });
    } catch (error) {
      logger.error('[Billing Webhook] Error:', error);
      res.status(500).json({ message: 'Internal automation error' });
    }
  }

  async processStripeEvent(eventType, payload = {}) {
    switch (eventType) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        return this.handleCheckoutCompleted(payload);
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
        return this.handleInvoicePaid(payload);
      case 'invoice.payment_failed':
        return this.handleInvoicePaymentFailed(payload);
      case 'customer.subscription.updated':
        return this.handleSubscriptionUpdated(payload);
      case 'customer.subscription.deleted':
        return this.handleSubscriptionDeleted(payload);
      default:
        return { ignored: eventType };
    }
  }

  async retrieveStripeSubscription(stripeSubscriptionId) {
    if (!stripeSubscriptionId || !this.stripe?.subscriptions?.retrieve) return null;
    try {
      return await this.stripe.subscriptions.retrieve(stripeSubscriptionId);
    } catch (error) {
      logger.warn('[Billing] Could not retrieve Stripe subscription:', error.message);
      return null;
    }
  }

  subscriptionMetaFromStripeSubscription(subscription = {}) {
    const firstItem = subscription.items?.data?.[0] || {};
    return {
      stripeSubscriptionId: subscription.id || null,
      stripeCustomerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id || null,
      stripePriceId: firstItem.price?.id || null,
      providerStatus: subscription.status || null,
      currentPeriodStart: this.fromStripeTimestamp(subscription.current_period_start),
      currentPeriodEnd: this.fromStripeTimestamp(subscription.current_period_end)
    };
  }

  invoicePeriod(invoice = {}) {
    const line = invoice.lines?.data?.[0] || {};
    return {
      currentPeriodStart: this.fromStripeTimestamp(line.period?.start || invoice.period_start),
      currentPeriodEnd: this.fromStripeTimestamp(line.period?.end || invoice.period_end)
    };
  }

  async handleCheckoutCompleted(session = {}) {
    const localSubscriptionId = session.metadata?.localSubscriptionId || session.client_reference_id;
    const isPaid = session.payment_status === 'paid' || session.status === 'complete';
    if (!localSubscriptionId || !isPaid) return { ignored: 'checkout_not_paid' };

    const stripeSubscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || null;
    const stripeSubscription = await this.retrieveStripeSubscription(stripeSubscriptionId);
    const stripeMeta = this.subscriptionMetaFromStripeSubscription(stripeSubscription || {});

    const result = await this._activateSubscription(localSubscriptionId, false, {
      provider: 'stripe',
      providerStatus: stripeMeta.providerStatus || 'active',
      stripeCheckoutSessionId: session.id || null,
      stripeSubscriptionId,
      stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
      stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id || stripeMeta.stripeCustomerId,
      stripePriceId: stripeMeta.stripePriceId,
      currentPeriodStart: stripeMeta.currentPeriodStart,
      currentPeriodEnd: stripeMeta.currentPeriodEnd
    });

    if (!result.success) return { notFound: true, message: result.message };
    return { ok: true, activated: result.targetValue };
  }

  async findStripeSubscriptionRecord(stripeSubscriptionId, localSubscriptionId = null) {
    if (localSubscriptionId) {
      const byId = await prisma.subscription.findFirst({
        where: { id: localSubscriptionId },
        include: { agency: true }
      });
      if (byId) return byId;
    }

    return prisma.subscription.findFirst({
      where: {
        OR: [
          { stripeSubscriptionId },
          { paymentRef: stripeSubscriptionId }
        ]
      },
      include: { agency: true }
    });
  }

  async handleInvoicePaid(invoice = {}) {
    const stripeSubscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id || null;
    if (!stripeSubscriptionId) return { ignored: 'invoice_without_subscription' };

    const subscription = await this.findStripeSubscriptionRecord(stripeSubscriptionId);
    if (!subscription) return { ignored: 'local_subscription_missing' };

    const period = this.invoicePeriod(invoice);
    const amountPaid = this.fromMinorUnits(invoice.amount_paid);
    const currency = invoice.currency ? String(invoice.currency).toUpperCase() : subscription.currency;
    const note = this.safeJson(subscription.note);

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'ACTIVE',
        provider: 'stripe',
        providerStatus: 'active',
        paymentRef: stripeSubscriptionId,
        amountPaid: amountPaid ?? subscription.amountPaid,
        currency,
        currentPeriodStart: period.currentPeriodStart || subscription.currentPeriodStart,
        currentPeriodEnd: period.currentPeriodEnd || subscription.currentPeriodEnd,
        expiresAt: period.currentPeriodEnd || subscription.expiresAt
      }
    });

    if (note.type === 'plan' && note.targetValue) {
      await prisma.agency.update({
        where: { id: subscription.agencyId },
        data: { plan: note.targetValue, tier: note.targetValue }
      });
    }

    return { ok: true, renewed: subscription.id };
  }

  async handleInvoicePaymentFailed(invoice = {}) {
    const stripeSubscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id || null;
    if (!stripeSubscriptionId) return { ignored: 'invoice_without_subscription' };

    const subscription = await this.findStripeSubscriptionRecord(stripeSubscriptionId);
    if (!subscription) return { ignored: 'local_subscription_missing' };

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'PAST_DUE',
        provider: 'stripe',
        providerStatus: 'payment_failed'
      }
    });

    return { ok: true, pastDue: subscription.id };
  }

  async handleSubscriptionUpdated(stripeSubscription = {}) {
    const localSubscriptionId = stripeSubscription.metadata?.localSubscriptionId || null;
    const subscription = await this.findStripeSubscriptionRecord(stripeSubscription.id, localSubscriptionId);
    if (!subscription) return { ignored: 'local_subscription_missing' };

    const stripeMeta = this.subscriptionMetaFromStripeSubscription(stripeSubscription);
    const localStatus = this.normalizeStripeStatus(stripeSubscription.status);
    const note = this.safeJson(subscription.note);

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: localStatus,
        provider: 'stripe',
        providerStatus: stripeSubscription.status || null,
        stripeSubscriptionId: stripeSubscription.id || subscription.stripeSubscriptionId,
        stripeCustomerId: stripeMeta.stripeCustomerId || subscription.stripeCustomerId,
        stripePriceId: stripeMeta.stripePriceId || subscription.stripePriceId,
        paymentRef: stripeSubscription.id || subscription.paymentRef,
        currentPeriodStart: stripeMeta.currentPeriodStart || subscription.currentPeriodStart,
        currentPeriodEnd: stripeMeta.currentPeriodEnd || subscription.currentPeriodEnd,
        expiresAt: stripeMeta.currentPeriodEnd || subscription.expiresAt
      }
    });

    if (localStatus === 'ACTIVE' && note.type === 'plan' && note.targetValue) {
      await prisma.agency.update({
        where: { id: subscription.agencyId },
        data: { plan: note.targetValue, tier: note.targetValue }
      });
    }

    return { ok: true, subscriptionUpdated: subscription.id, status: localStatus };
  }

  async handleSubscriptionDeleted(stripeSubscription = {}) {
    const localSubscriptionId = stripeSubscription.metadata?.localSubscriptionId || null;
    const subscription = await this.findStripeSubscriptionRecord(stripeSubscription.id, localSubscriptionId);
    if (!subscription) return { ignored: 'local_subscription_missing' };

    const note = this.safeJson(subscription.note);
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'CANCELLED',
        provider: 'stripe',
        providerStatus: 'canceled',
        cancelledAt: new Date(),
        stripeSubscriptionId: stripeSubscription.id || subscription.stripeSubscriptionId,
        paymentRef: stripeSubscription.id || subscription.paymentRef
      }
    });

    if (note.type === 'plan') {
      await prisma.agency.update({
        where: { id: subscription.agencyId },
        data: { plan: 'Standard', tier: 'Standard' }
      });
    }

    return { ok: true, cancelled: subscription.id };
  }

  async _activateSubscription(sessionIdOrVS, isVS = false, paymentMeta = {}) {
    try {
      const subscription = await prisma.subscription.findFirst({
        where: isVS
          ? { paymentRef: String(sessionIdOrVS), status: 'PENDING' }
          : { id: sessionIdOrVS, status: 'PENDING' },
        include: { agency: true }
      });

      if (!subscription) return { success: false, message: 'Pending session not found' };

      // Bankovní převod (VS): ověř, že přišla očekávaná částka ve správné měně.
      // Bez této kontroly stačí poslat 1 Kč se správným variabilním symbolem a
      // aktivovat si plný plán (matchování jen podle VS = platební bypass).
      if (isVS) {
        const expected = subscription.amountPaid;
        const paid = Number(paymentMeta.amount);
        if (expected == null || !Number.isFinite(paid)) {
          logger.warn(`[Billing Activation] VS ${sessionIdOrVS} zamítnut — nelze ověřit částku (očekáváno=${expected}, zaplaceno=${paymentMeta.amount})`);
          return { success: false, message: 'Amount verification unavailable' };
        }
        if (paid + 0.01 < expected) { // přeplatek OK, nedoplatek ne (0.01 tolerance na zaokrouhlení)
          logger.warn(`[Billing Activation] VS ${sessionIdOrVS} zamítnut — nedoplatek: zaplaceno ${paid}, očekáváno ${expected}`);
          return { success: false, message: 'Insufficient amount' };
        }
        const paidCurrency = paymentMeta.currency && String(paymentMeta.currency).toUpperCase();
        const wantCurrency = subscription.currency && String(subscription.currency).toUpperCase();
        if (paidCurrency && wantCurrency && paidCurrency !== wantCurrency) {
          logger.warn(`[Billing Activation] VS ${sessionIdOrVS} zamítnut — nesouhlasí měna: přišlo ${paidCurrency}, očekáváno ${wantCurrency}`);
          return { success: false, message: 'Currency mismatch' };
        }
      }

      const { type, targetValue } = this.safeJson(subscription.note);

      logger.info(`[Billing Activation] Processing ${type} for Agency ${subscription.agencyId} via ${paymentMeta.provider || (isVS ? 'manual' : 'Stripe')}`);

      if (type === 'plan') {
        await prisma.subscription.updateMany({
          where: {
            agencyId: subscription.agencyId,
            id: { not: subscription.id },
            status: { in: ['ACTIVE', 'TRIAL', 'PAST_DUE'] }
          },
          data: { status: 'CANCELLED', cancelledAt: new Date() }
        });

        await prisma.agency.update({
          where: { id: subscription.agencyId },
          data: { plan: targetValue, tier: targetValue }
        });
      } else if (type === 'addon') {
        const currentFeatures = this.safeJson(subscription.agency.extraFeatures);
        currentFeatures[targetValue] = true;
        await prisma.agency.update({
          where: { id: subscription.agencyId },
          data: { extraFeatures: JSON.stringify(currentFeatures) }
        });
      }

      const periodStart = paymentMeta.currentPeriodStart || new Date();
      const periodEnd = paymentMeta.currentPeriodEnd || subscription.expiresAt;
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: 'ACTIVE',
          startedAt: periodStart,
          expiresAt: periodEnd,
          provider: paymentMeta.provider || subscription.provider || 'stripe',
          providerStatus: paymentMeta.providerStatus || 'active',
          paymentRef: paymentMeta.stripeSubscriptionId || paymentMeta.stripePaymentIntentId || subscription.paymentRef,
          stripeCheckoutSessionId: paymentMeta.stripeCheckoutSessionId || subscription.stripeCheckoutSessionId,
          stripeSubscriptionId: paymentMeta.stripeSubscriptionId || subscription.stripeSubscriptionId,
          stripeCustomerId: paymentMeta.stripeCustomerId || subscription.stripeCustomerId,
          stripePriceId: paymentMeta.stripePriceId || subscription.stripePriceId,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd
        }
      });

      return { success: true, targetValue };
    } catch (error) {
      logger.error('[_activateSubscription] Error:', error);
      return { success: false, message: error.message };
    }
  }

  async simulateSuccess(req, res) {
    const allowed = process.env.NODE_ENV === 'test' || process.env.ALLOW_BILLING_SIMULATION === 'true';
    if (!allowed) {
      return res.status(403).json({ message: 'Billing simulation is disabled' });
    }
    const { sessionId } = req.body;
    req.body = { sessionId, status: 'PAID' };
    return this.handleWebhook(req, res);
  }
}

module.exports = new BillingController();
