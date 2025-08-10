// ... (ostatak fajla isti kao što si ubacio ranije)

// dopuni mapiranje na vrhu:
const NAME_TO_CC = {
  // zemlje
  usa: 'US', 'united states': 'US', america: 'US',
  iceland: 'IS', japan: 'JP', germany: 'DE', england: 'GB', scotland: 'GB',
  wales: 'GB', 'faroe-islands': 'FO', denmark: 'DK', sweden: 'SE',
  norway: 'NO', finland: 'FI', portugal: 'PT', spain: 'ES', italy: 'IT',
  france: 'FR', netherlands: 'NL', belgium: 'BE', austria: 'AT',
  switzerland: 'CH', turkey: 'TR', greece: 'GR', serbia: 'RS', croatia: 'HR',
  slovenia: 'SI', bosnia: 'BA', montenegro: 'ME', 'north macedonia': 'MK',
  albania: 'AL',
  // lige/heuristike
  bund: 'DE', laLiga: 'ES', seriea: 'IT', ligue: 'FR', eredivisie: 'NL',
  primeira: 'PT', j1: 'JP', urvalsdeild: 'IS', meistaradeildin: 'FO',
  usl: 'US', mls: 'US', championship: 'GB'
};

function guessFlag(league = {}) {
  const country = String(league.country || '').toLowerCase();
  const name = String(league.name || '').toLowerCase();

  for (const key of Object.keys(NAME_TO_CC)) {
    if (country.includes(key)) return ccToFlag(NAME_TO_CC[key]);
  }
  for (const key of Object.keys(NAME_TO_CC)) {
    if (name.includes(key)) return ccToFlag(NAME_TO_CC[key]);
  }
  return '';
}

// u FootballCard, pri dnu, gde renderujemo mikro red:
const micro = shortForm(pick?.meta) || '';

// ...
{micro ? (
  <div className="text-[11px] text-slate-400 mt-1">{micro}</div>
) : null}
