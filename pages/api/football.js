// pages/api/football.js

/**
 * Stub verzija dok ne dostaviš realne izvore.
 * Vraća top 3 fudbalske predikcije sa poljima:
 * - match: naziv meča
 * - prediction: tip (npr. 1X2, BTTS, HT/FT)
 * - odds: kvota koja ide uz taj tip
 * - confidence: očekivana tačnost u procentima
 * - note: dodatni kontekst / motivacija
 *
 * Kada budeš spreman da integrišeš realne source-ove,
 * zameni sekciju `getRealFootballPredictions` sa fetch logikom
 * iz tvoja tri API izvora i napuni strukturu istim poljima.
 */

const sampleFootballTop = [
  {
    match: 'FC Dynamo vs Red Stars',
    prediction: '1X2: 1',
    odds: '1.95',
    confidence: 85,
    note: 'Home team u formi, protivnik bez glavnog napadača',
  },
  {
    match: 'River City vs Blue United',
    prediction: 'BTTS: Yes',
    odds: '1.72',
    confidence: 78,
    note: 'Oba tima daju golove u poslednjih 5 mečeva',
  },
  {
    match: 'Valley Rangers vs Mountain FC',
    prediction: 'HT/FT: X/2',
    odds: '3.10',
    confidence: 66,
    note: 'Favoriti pritisnu posle pauze, loša forma domaćih u drugom poluvremenu',
  },
];

// Placeholder for future real-data integration
async function getRealFootballPredictions() {
  // TODO: ovde ubaci fetch sa tvoja tri izvora, kombinuješ po konsenzusu,
  // računaš confidence, validiraš kvote itd. Treba da vrati listu sa istom
  // strukturom kao sampleFootballTop.
  return [];
}

export default async function handler(req, res) {
  try {
    // Ako želiš da testiraš static verziju uvek, koristi sampleFootballTop.
    // Kasnije promeni na realne podatke tako što ćeš uraditi:
    // const real = await getRealFootballPredictions();
    // i onda: footballTop = real.length ? real.slice(0, 10) : sampleFootballTop;

    const real = await getRealFootballPredictions();

    const footballTop = real && real.length >= 3 ? real.slice(0, 3) : sampleFootballTop;

    const payload = {
      footballTop,
      generated_at: new Date().toISOString(),
    };

    return res.status(200).json(payload);
  } catch (err) {
    console.error('Football API error:', err);
    return res.status(500).json({
      error: 'Failed to get football predictions',
      detail: err.message,
    });
  }
}
