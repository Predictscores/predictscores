// pages/api/select-matches.js
// Fajl je ranije bio bez validnog handlera. Dodajemo noop handler da ne ruši rutu.

export default async function handler(req, res) {
  // Ako ti je ova ruta potrebna u budućnosti, ovde može ići realna logika selekcije iz KV.
  res.status(200).json({ ok: true, disabled: true });
}
