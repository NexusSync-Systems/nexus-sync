const { getIO } = require('../services/socket');
const prisma = require('../services/db');
const pushService = require('../services/pushService');

exports.incomingSms = async (req, res) => {
  try {
    const { from, body, timestamp, installationId } = req.body;
    const agencyId = req.user.agencyId; // Z relay JWT

    if (!from || !body) {
      return res.status(400).json({ error: 'Missing from or body' });
    }

    const io = getIO();
    
    // Přepošli všem operátorům v agentuře do prohlížeče
    io.to(`agency_${agencyId}`).emit('sms:incoming', {
      from,
      body,
      timestamp: timestamp || Date.now(),
      installationId
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('Incoming SMS error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

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
