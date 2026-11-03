# Stripe test mode runbook

Tento postup slouzi k overeni Stripe napojeni v testovacim rezimu. Smoke test vytvari pouze Checkout Session a neprovadi platbu, aby sam od sebe nemenil aktivni tarif agentury.

## Povinne konfigurace

Backend musi mit nastavene tyto promenne:

- `STRIPE_SECRET_KEY`: testovaci secret key ze Stripe Dashboardu, musi zacinat `sk_test_`.
- `STRIPE_PUBLISHABLE_KEY`: testovaci publishable key, musi zacinat `pk_test_`.
- `STRIPE_WEBHOOK_SECRET`: podpisovy secret z `stripe listen`, musi zacinat `whsec_`.
- `FRONTEND_URL`: URL aplikace, kam se Stripe vraci po platbe.
- Volitelne pevne Stripe Price ID pro kanonicke tarify:
  - `STRIPE_PRICE_STARTER_MONTHLY_CZK`
  - `STRIPE_PRICE_PRO_MONTHLY_CZK`
  - `STRIPE_PRICE_AGENCY_MONTHLY_CZK`

Pokud Price ID nejsou nastavena, backend vytvori nebo znovu pouzije Stripe Price podle `lookup_key`.
Platba prevodem je defaultne vypnuta; testovaci platby provadejte kartou pres Stripe.

Frontend musi mit nastavene:

- `VITE_STRIPE_PUBLISHABLE_KEY`: stejny testovaci publishable key, `pk_test_...`.

Secret hodnoty nikdy neukladejte do repozitare. Pro GitHub Actions patri do `Settings -> Secrets and variables -> Actions`, pro server do prostredi deploye.

## Automaticky smoke test

Vychozi beh je preskoceny, aby CI bez Stripe secrets nepadalo.

```bash
npm run test:stripe
```

Pro skutecny test proti backendu s testovacimi Stripe klici:

```bash
RUN_STRIPE_TEST_MODE=true \
NEXUS_API_URL=http://localhost:3000/api \
FRONTEND_URL=http://localhost:5173/settings \
STRIPE_TEST_PLAN_ID=pro_monthly \
npm run test:stripe
```

Ocekavany vysledek:

- API vrati HTTP `200`.
- Odpoved ma `provider: "stripe"` a `paymentMethod: "card"`.
- Stripe session ID zacina `cs_`.
- Checkout URL vede na `checkout.stripe.com`.
- `localSubscriptionId` je vyplnene.
- Checkout vytvori nebo znovu pouzije Stripe Customer pro agenturu.
- Opakovany tarif pouziva stabilni Stripe Price ID nebo backendovy `lookup_key`.

## Manualni end-to-end platba

1. Spustte backend s testovacimi Stripe klici.
2. Spustte frontend a prihlaseni jako agency admin.
3. Spustte Stripe CLI:

```bash
stripe listen --forward-to http://localhost:3000/api/billing/webhook
```

4. Zkopirujte hodnotu `whsec_...` do `STRIPE_WEBHOOK_SECRET` a restartujte backend.
5. V aplikaci otevrite `Nastaveni -> Srovnani a zmena tarifu`.
6. Kliknete na `Aktivovat Professional`.
7. Zaplatte testovaci kartou `4242 4242 4242 4242`, libovolnym budoucim datem expirace a libovolnym CVC.
8. Ve Stripe CLI overte prijem udalosti `checkout.session.completed`.
9. V aplikaci overte, ze je tarif aktivni a ze se nezobrazuje chyba konfigurace Stripe.

## Automaticky end-to-end test platby

Tento test provede skutecnou Stripe test-mode platbu kartou, pocka na webhook aktivaci
lokalniho subscription zaznamu a overi otevreni Billing Portalu. Spoustejte ho jen proti
testovacim Stripe klicum a testovacimu uzivateli.

```bash
RUN_STRIPE_PAYMENT_E2E=true \
NEXUS_API_URL=https://api.nexusstack.eu/api \
FRONTEND_URL=https://nexus-sync-8d50b.web.app/settings \
STRIPE_TEST_PLAN_ID=pro_monthly \
npm run test:stripe:payment
```

Pro embedded Checkout primo z nastaveni aplikace:

```bash
RUN_STRIPE_EMBEDDED_E2E=true \
NEXUS_API_URL=https://api.nexusstack.eu/api \
FRONTEND_URL=https://nexus-sync-8d50b.web.app/settings \
STRIPE_TEST_PLAN_ID=pro_monthly \
npm run test:stripe:payment
```

## Negativni testy

- Bez `STRIPE_SECRET_KEY` ma backend vratit chybu `stripe_not_configured`.
- S chybnym `STRIPE_WEBHOOK_SECRET` ma webhook vratit `400 stripe_signature_invalid`
  a subscription se nesmi aktivovat.
- Unsigned webhook request se nesmi zpracovat.
- `invoice.paid` ma prodlouzit aktivni obdobi predplatneho.
- `invoice.payment_failed` ma prepnout subscription do `PAST_DUE`.
- `customer.subscription.deleted` ma zrusit lokalni pristup k tarifu.
- Pokud Stripe vrati chybu pri vytvareni session, UI ma zobrazit uzivatelsky srozumitelnou chybu a nesmi zmenit tarif.

## Produkcni opatrnost

- Testy spoustejte proti testovacim Stripe klicum, ne proti `sk_live_`.
- Produkcni webhook secret nepouzivejte v lokalnim Stripe CLI.
- Smoke test vytvari pending local subscription. Testovaci zaznamy lze nechat expirovat nebo je uklidit v testovaci databazi.
