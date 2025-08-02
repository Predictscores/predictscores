// pages/api/football.js

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

async function getRealFootballPredictions() {
  // TODO: ubaci fetch sa tvoja tri izvora i kombinuješ po konsenzusu.
  return [];
}

export default async function handler(req, res) {
  try {
    const real = await getRealFootballPredictions();
    const footballTop = real && real.length >= 3 ? real.slice(0, 3) : sampleFootballTop;
    return res.status(200).json({
      footballTop,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Football API error:', err);
    return res.status(500).json({
      error: 'Failed to get football predictions',
      detail: err.message,
    });
  }
}
