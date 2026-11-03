package com.nexushub.app;

import static org.junit.Assert.assertEquals;

import android.content.pm.ServiceInfo;
import android.os.Build;

import org.junit.Test;

/**
 * Volba typu popředové služby.
 *
 * Relay a plná aplikace sdílejí jeden kód, ale každá má v manifestu jiný typ:
 * relay specialUse (nepodléhá šestihodinovému rozpočtu), plná aplikace
 * dataSync (nemusí kvůli němu žádat Google Play o schválení). Kdyby se tahle
 * úvaha spletla, nepřijde varování — plná aplikace spadne na startForeground
 * s „foregroundServiceType not declared in manifest" a relay se vrátí k typu,
 * který mu Android po šesti hodinách sebere.
 *
 * Testuje se čistá funkce {@code vyberTyp}, protože konstanty jsou v Javě
 * inlinované a na telefon tedy není potřeba.
 */
public class NexusRelayForegroundServiceTest {

    /** Co má v manifestu relay (src/nexusRelay): specialUse|dataSync. */
    private static final int RELAY =
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            | ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;

    /** Co má v manifestu plná aplikace (src/main): jen dataSync. */
    private static final int PLNA = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;

    @Test
    public void relayNaAndroidu14AVysUtecePredRozpoctem() {
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            NexusRelayForegroundService.vyberTyp(RELAY, Build.VERSION_CODES.UPSIDE_DOWN_CAKE));
        assertEquals("Android 15 je důvod, proč tohle celé existuje",
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            NexusRelayForegroundService.vyberTyp(RELAY, Build.VERSION_CODES.VANILLA_ICE_CREAM));
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            NexusRelayForegroundService.vyberTyp(RELAY, 36));
    }

    @Test
    public void relayNaAndroidu13AStarsimBereDataSync() {
        // Konstanta SPECIAL_USE je až od Androidu 14. Na starším telefonu by
        // ji startForeground odmítl — tam limit stejně neplatí.
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            NexusRelayForegroundService.vyberTyp(RELAY, Build.VERSION_CODES.TIRAMISU));
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            NexusRelayForegroundService.vyberTyp(RELAY, Build.VERSION_CODES.Q));
    }

    @Test
    public void plnaAplikaceNesmiDostatTypKteryNemaVManifestu() {
        // Tohle je ten pád: specialUse plná aplikace nedeklaruje.
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            NexusRelayForegroundService.vyberTyp(PLNA, 36));
    }

    @Test
    public void kdyzSeManifestNepodariPrecistPlatiDataSync() {
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            NexusRelayForegroundService.vyberTyp(0, 36));
    }
}
