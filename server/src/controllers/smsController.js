const { getIO } = require('../services/socket');
const prisma = require('../services/db');

// `incomingSms` a route POST /api/sms/incoming jsou odstraněné.
//
// Nikdy je nepoužíval relay, pro který byly napsané. Relay posílá příchozí
// zprávy nativně na POST /api/device/relay (hlavičky X-Installation-Id
// a X-Device-Secret, viz relayAuthMiddleware) a `deviceController.handleRelay`
// je ULOŽÍ jako Message(direction: INBOUND) a teprve pak pošle do agentury
// událost `new_message`. To je živá cesta a ta se nemění.
//
// Mrtvá cesta byla zároveň děravá: visela na `authMiddleware`, který pouští
// každý platný session token, ne jen relay. Kterákoli přihlášená operátorka
// tak mohla POSTem vyrobit `sms:incoming` s libovolným `from`, textem
// i `installationId` a poslat ho na obrazovku všem v agentuře. Nic se
// neukládalo do databáze, takže po tom nezůstal žádný záznam — ve callcentru
// je to hotová pomůcka pro podvod. Komentář `// Z relay JWT` u `agencyId`
// tu nepravdu držel naživu.
//
// Důkaz, že je to pryč: tests/smsIncomingPodvrzeni.test.js.

/**
 * Odeslání SMS přes spárovaný relay telefon.
 *
 * Dřív se příkaz rozesílal do `agency_<id>`, což mělo tři následky:
 *
 *   1. Do té místnosti patří KAŽDÝ přihlášený socket agentury, tedy i všechny
 *      prohlížeče operátorek. Příjemce i celý text zprávy tak dostal každý,
 *      kdo je zrovna přihlášený, ačkoli je nepotřebuje.
 *   2. Při DVOU spárovaných telefonech zprávu odeslaly OBA. To není vidět
 *      v logu, ale u zákazníka, který ji dostane dvakrát.
 *   3. Vracelo se `ok: true` i tehdy, když neposlouchal žádný telefon —
 *      operátorka se dozvěděla „odesláno", ač se nestalo nic.
 *
 * Místnost pro konkrétní telefon `relay:<installationId>` už existovala,
 * používá ji WebRTC signaling. Relay se do ní hlásí při každém připojení
 * socketu (NexusInCall.js), nezávisle na tom, jestli zrovna probíhá hovor.
 *
 * Záměrně se tu NIC neukládá do historie. Odchozí zprávu zapíše až
 * `deviceController.handleRelay`, když telefon odeslání potvrdí zpětným
 * hlášením (SMS_SENT). Zápis předem by znamenal zprávy v historii, které
 * ve skutečnosti nikdy neodešly.
 */
exports.sendSms = async (req, res) => {
  try {
    const { to, text, installationId } = req.body;
    const agencyId = req.user.agencyId;

    if (!to || !text) {
      return res.status(400).json({ error: 'Missing to or text' });
    }

    // Volitelné `installationId` dovolí poslat z konkrétního telefonu.
    // Filtr na agencyId tu musí zůstat i tak, jinak by se dal cizí telefon
    // adresovat jeho identifikátorem.
    const kde = { agencyId: String(agencyId), active: true };
    if (installationId) kde.installationId = String(installationId);

    const zarizeni = await prisma.deviceBinding.findMany({
      where: kde,
      orderBy: { lastSeenAt: 'desc' },
      select: { installationId: true }
    });

    if (zarizeni.length === 0) {
      return res.status(409).json({
        error: installationId
          ? 'Takový relay telefon k této agentuře spárovaný není.'
          : 'K této agentuře není spárovaný žádný aktivní relay telefon.'
      });
    }

    // Spárovaný ještě neznamená připojený. Bere se první telefon, který
    // je opravdu v místnosti — od naposled viděného. Bez téhle kontroly
    // by se příkaz poslal do prázdna a odpověď by tvrdila, že je odesláno.
    const io = getIO();
    let vybrany = null;
    for (const z of zarizeni) {
      const pripojene = await io.in(`relay:${z.installationId}`).fetchSockets();
      if (pripojene.length > 0) {
        vybrany = z.installationId;
        break;
      }
    }

    if (!vybrany) {
      return res.status(503).json({
        error: 'Relay telefon je spárovaný, ale právě není připojený. Zpráva nebyla odeslána.'
      });
    }

    io.to(`relay:${vybrany}`).emit('relay_event', {
      type: 'send_sms',
      to,
      content: text,
      agencyId
    });

    res.json({ ok: true, installationId: vybrany });
  } catch (error) {
    console.error('Send SMS error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
