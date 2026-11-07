/**
 * Pushová záloha a noční hlídka se taky týkají jen relay telefonu.
 *
 * Tyhle dvě cesty by se po zavedení `appVariant` pokazily obzvlášť tiše:
 *
 *  - `sendRelaySmsPush` je ZÁLOHA, když socket nedosáhne na telefon.
 *    Kdyby si vybrala vazbu plné aplikace, odchozí SMS by zůstala viset
 *    na `pending_relay` a nikdo by se nedozvěděl proč.
 *  - `checkRelay` hlásí „relay je offline". Plné aplikaci `lastSeenAt`
 *    obnovuje jen příchozí SMS, dotaz na outbox a SIP ping — tedy nic,
 *    co plná aplikace dělá, takže by poplach spouštěla pořád a tím ho
 *    znehodnotila.
 */

jest.mock('../src/services/db');
jest.mock('../src/services/logger');
jest.mock('../src/services/alertService');
jest.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  messaging: jest.fn(() => ({ sendEachForMulticast: jest.fn(async () => ({ responses: [] })) }))
}));

const prismaMock = require('../src/services/db');
const { JEN_RELAY } = require('../src/utils/deviceVariants');
const { sendRelaySmsPush } = require('../src/services/pushService');
const monitoringService = require('../src/services/monitoringService');

const NYNI = new Date('2026-11-07T12:00:00.000Z');

beforeEach(() => {
  jest.clearAllMocks();
  monitoringService._resetForTests();
  prismaMock.$queryRaw.mockResolvedValue([{ ok: 1 }]);
  prismaMock.subscription.findMany.mockResolvedValue([]);
  prismaMock.message.findMany.mockResolvedValue([]);
  prismaMock.deviceBinding.findMany.mockResolvedValue([]);
});

test('pushová záloha pro odchozí SMS hledá jen relay telefon', async () => {
  // Vazba se schválně nenajde: zajímá nás filtr dotazu, ne zbytek odeslání.
  prismaMock.deviceBinding.findFirst.mockResolvedValue(null);

  const vysledek = await sendRelaySmsPush({
    agencyId: 'agency-1', profileId: 'profile-1', to: '+420777111222', text: 'ahoj', messageId: 'm-1'
  });

  expect(vysledek.ok).toBe(false);
  const kde = prismaMock.deviceBinding.findFirst.mock.calls[0][0].where;
  expect(kde).toMatchObject({ ...JEN_RELAY, active: true, profileId: 'profile-1', agencyId: 'agency-1' });
});

test('noční hlídka offline relaye nekouká na plnou aplikaci', async () => {
  await monitoringService.summarizeOperationalHealth({ now: NYNI });

  const volani = prismaMock.deviceBinding.findMany.mock.calls[0][0];
  expect(volani.where).toMatchObject({ ...JEN_RELAY, active: true });
});
