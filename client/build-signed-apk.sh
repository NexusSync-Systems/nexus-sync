#!/bin/bash

# 🚀 NEXUS HUB - SIGNED APK BUILD SCRIPT
# Zkopíruj a spusť v Terminálu

# ============================================================================
# KROK 1: VYTVOŘ KEYSTORE (Jen první krát!)
# ============================================================================
# Odkomentuj a spusť pokud ještě nemáš keystore:

# keytool -genkey -v -keystore ~/.android/nexus-release-key.jks \
#   -keyalg RSA \
#   -keysize 2048 \
#   -validity 10000 \
#   -alias nexus-key

# Po spuštění:
# - Keystore password: (vymysli si heslo - napiš si ho!)
# - Key password: (stejné heslo)
# - First name: (tvoje jméno)
# - Last name: (tvoje příjmení)
# - Organization: (tvá firma)
# - City: (tvoje město)
# - State: (tvůj stát)
# - Country: (CZ, US, atd)

# ============================================================================
# KROK 2: NASTAV HESLA (ZMĚŇ NA SVÉ!)
# ============================================================================

export NEXUS_KEYSTORE_PATH=~/.android/nexus-release-key.jks
export NEXUS_KEYSTORE_PASSWORD="ZMĚŇ_NA_SVÉ_HESLO"
export NEXUS_KEY_ALIAS="nexus-key"
export NEXUS_KEY_PASSWORD="ZMĚŇ_NA_SVÉ_HESLO"

# OVĚŘ ŽE JSOU NASTAVENY
echo "Keystore path: $NEXUS_KEYSTORE_PATH"
echo "Keystore password: $NEXUS_KEYSTORE_PASSWORD"
echo "Key alias: $NEXUS_KEY_ALIAS"
echo "Key password: $NEXUS_KEY_PASSWORD"

# ============================================================================
# KROK 3: JDI DO ANDROID SLOŽKY
# ============================================================================

cd /Users/zdenekdias/Projects/nexus-hub/client/android

echo "🏗️ Aktuální složka: $(pwd)"

# ============================================================================
# KROK 4: SMAZ STARÉ BUILDY
# ============================================================================

echo "🧹 Čištění starých buildů..."
./gradlew clean

# ============================================================================
# KROK 5: POSTAV RELEASE APK
# ============================================================================

echo "🚀 Postav signed APK..."
echo "⏳ Toto může trvat 5-15 minut..."
./gradlew assembleRelease

# ============================================================================
# KROK 6: ZKONTROLUJ APK
# ============================================================================

echo "✅ Build hotov! Hledám APK..."

APK_PATH="/Users/zdenekdias/Projects/nexus-hub/client/android/app/release/Nexus-Relay-v*.apk"

if ls $APK_PATH 1> /dev/null 2>&1; then
    echo "✅ APK NALEZEN!"
    echo ""
    ls -lh $APK_PATH
    echo ""
    echo "📦 Cesta k APK:"
    ls -1 $APK_PATH
    echo ""
    echo "🎉 HOTOVO! APK je připraven!"
else
    echo "❌ APK NENALEZEN! Build selhalo."
    exit 1
fi

# ============================================================================
# KROK 7: INSTALACE NA ZAŘÍZENÍ (Volitelně)
# ============================================================================

# Pokud máš Android telefon připojený USB s USB Debug zapnutým:
# Odkomentuj toto:

# echo "📱 Instaluji na zařízení..."
# adb devices
# adb install -r $APK_PATH
# echo "✅ Instalace hotova! Otevři app na telefonu."

# ============================================================================
# SHRNUTÍ
# ============================================================================

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "✅ NEXUS HUB SIGNED APK BUILD HOTOV!"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "APK umístění:"
echo "  $APK_PATH"
echo ""
echo "Co dělat dál:"
echo "  1. Kopíruj APK na Android zařízení"
echo "  2. Instaluj na telefonu"
echo "  3. Otevři app a testuj"
echo "  4. Když je vše OK, dej na Play Store"
echo ""
echo "Pro instalaci na telefon s USB:"
echo "  adb install -r $(ls -1 $APK_PATH)"
echo ""
echo "════════════════════════════════════════════════════════════════════"

