 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/components/CombinedBets.jsx b/components/CombinedBets.jsx
index b8f979c7018c772d503fa0153bfef723795a438a..557b341dc4a14ab9e368e35e7efb04a5bb6872c0 100644
--- a/components/CombinedBets.jsx
+++ b/components/CombinedBets.jsx
@@ -211,50 +211,51 @@ function WhyLine({ explain }) {
   const text = bullets.filter((b) => !/^forma:|^h2h/i.test((b || "").trim())).slice(0, 2).join(" · ");
   const forma = (() => {
     const x = bullets.find((b) => /^forma:/i.test((b || "").trim()));
     return x ? x.replace(/^forma:\s*/i, "").trim() : "";
   })();
   const h2h = (() => {
     const x = bullets.find((b) => /^h2h/i.test((b || "").trim()));
     return x ? x.replace(/^h2h:\s*/i, "").trim() : "";
   })();
   if (!text && !forma && !h2h) return null;
   return (
     <div className="text-xs text-slate-400">
       {text}
       {forma ? (text ? " · " : "") + `Forma: ${forma}` : ""}
       {h2h ? ((text || forma) ? " · " : "") + `H2H: ${h2h}` : ""}
     </div>
   );
 }
 function MarketBadge({ market }) {
   const m = String(market || "").toUpperCase();
   const map = {
     "1X2": "bg-cyan-500/15 text-cyan-200 border-cyan-500/30",
     "BTTS": "bg-amber-500/15 text-amber-200 border-amber-500/30",
     "HT-FT": "bg-fuchsia-500/15 text-fuchsia-200 border-fuchsia-500/30",
     "O/U 2.5": "bg-emerald-500/15 text-emerald-200 border-emerald-500/30",
+    "FH 1.5+": "bg-rose-500/15 text-rose-200 border-rose-500/30",
   };
   const cls = map[m] || "bg-slate-500/15 text-slate-200 border-slate-500/30";
   return <span className={`px-2 py-0.5 rounded-md text-[11px] border ${cls}`}>{m}</span>;
 }
 
 /* ---------- Football card ---------- */
 function FootballCard({ bet }) {
   const confPct = Math.round(Number(bet.conf || 0));
   const icon = confIcon(confPct);
 
   return (
     <div className="p-4 rounded-xl bg-[#1f2339]">
       <div className="flex items-center justify-between text-xs text-slate-400">
         <div>{bet.league} · {fmtLocal(bet.date)}</div>
         <div className="flex items-center gap-2"><MarketBadge market={bet.market} /></div>
       </div>
 
       <div className="font-semibold mt-1">
         {bet.home} <span className="text-slate-400">vs</span> {bet.away}
       </div>
 
       <div className="text-sm text-slate-200 mt-1">
         <span className="font-semibold">{bet.market}</span>
         {bet.market ? " → " : ""}{bet.sel || "—"}
         {bet.odds ? (
diff --git a/components/CombinedBets.jsx b/components/CombinedBets.jsx
index b8f979c7018c772d503fa0153bfef723795a438a..557b341dc4a14ab9e368e35e7efb04a5bb6872c0 100644
--- a/components/CombinedBets.jsx
+++ b/components/CombinedBets.jsx
@@ -322,181 +323,211 @@ function TicketGroupCard({ title, items, sortBy = "ko" }) {
               <span className="font-semibold">{b.sel}</span>
               {b.odds ? <span className="text-slate-300"> ({Number(b.odds).toFixed(2)})</span> : <span className="text-slate-500
 "> (—)</span>}
             </div>
             <div className="text-[11px] text-slate-400 mt-0.5">Conf: {Math.round(b.conf || 0)}%</div>
           </div>
         ))}
       </div>
 
       <div className="h-px bg-slate-600 my-3" />
 
       {typeof total === "number" ? (
         <div className="text-right text-slate-200 font-semibold">Ukupna kvota: {total.toFixed(2)}</div>
       ) : (
         <div className="text-right text-slate-500 text-sm">Ukupna kvota: —</div>
       )}
     </div>
   );
 }
 
 /* ===================== data hooks ===================== */
 function useValueBetsFeed() {
   const [state, setState] = useState({
     items: [],
     oneXtwo: [],
-    tickets: { btts: [], ou25: [], htft: [] },
+    tickets: { btts: [], ou25: [], fh_ou15: [], htft: [] },
     err: null,
     loading: true,
   });
 
   async function load() {
     try {
       setState((s) => ({ ...s, loading: true, err: null }));
       const slot = currentSlot(TZ);
       const n = desiredCountForSlot(slot, TZ);
       const j = await safeJson(`/api/value-bets-locked?slot=${slot}&n=${n}`);
       const srcItems = Array.isArray(j?.items) ? j.items : Array.isArray(j?.football) ? j.football : Array.isArray(j) ? j : [];
       const items = srcItems.map((it) => normalizeBet(it));
 
       const oneXtwoRaw = Array.isArray(j?.one_x_two)
         ? j.one_x_two
         : Array.isArray(j?.oneXtwo)
         ? j.oneXtwo
         : [];
       const oneXtwo = oneXtwoRaw.map((it) => normalizeBet(it, "1X2"));
 
       const tb = j?.tickets || {};
       const bttsRaw = Array.isArray(tb.btts) ? tb.btts : [];
       const ou25Raw = Array.isArray(tb.ou25) ? tb.ou25 : [];
+      const fhRaw = Array.isArray(tb.fh_ou15)
+        ? tb.fh_ou15
+        : Array.isArray(tb.FH_OU15)
+        ? tb.FH_OU15
+        : [];
       const htftRaw = Array.isArray(tb.htft) ? tb.htft : [];
 
       const btts = bttsRaw.map((it) => normalizeBet(it, "BTTS"));
       const ou25 = ou25Raw.map((it) => normalizeBet(it, "O/U 2.5"));
+      const fh_ou15 = fhRaw.map((it) => normalizeBet(it, "FH 1.5+"));
       const htft = htftRaw.map((it) => normalizeBet(it, "HT-FT"));
 
       setState({
         items,
         oneXtwo,
-        tickets: { btts, ou25, htft },
+        tickets: { btts, ou25, fh_ou15, htft },
         err: null,
         loading: false,
       });
     } catch (e) {
-      setState({ items: [], oneXtwo: [], tickets: { btts: [], ou25: [], htft: [] }, err: String(e?.message || e), loading: false
+      setState({ items: [], oneXtwo: [], tickets: { btts: [], ou25: [], fh_ou15: [], htft: [] }, err: String(e?.message || e), loading: false
  });
     }
   }
 
   useEffect(() => { load(); }, []);
   return { ...state, reload: load };
 }
 
 function useCryptoTop3() {
   const [items, setItems] = useState([]); const [err, setErr] = useState(null); const [loading, setLoading] = useState(true);
   async function load() {
     try {
       setLoading(true); setErr(null);
       const j = await safeJson(`/api/crypto`);
       const arr = Array.isArray(j?.items) ? j.items
         : Array.isArray(j?.predictions) ? j.predictions
         : Array.isArray(j?.data) ? j.data
         : Array.isArray(j?.list) ? j.list
         : Array.isArray(j?.results) ? j.results
         : Array.isArray(j?.signals) ? j.signals
         : Array.isArray(j?.crypto) ? j.crypto
         : Array.isArray(j) ? j : [];
       setItems(arr.slice(0, 3));
     } catch (e) { setErr(String(e?.message || e)); setItems([]); } finally { setLoading(false); }
   }
   useEffect(() => { load(); }, []);
   return { items, err, loading };
 }
 
 /* ===================== Football tab ===================== */
 function FootballBody({ matchOdds, tickets }) {
   const [tab, setTab] = useState("ko"); // ko | conf | hist
 
   const koLeft = useMemo(
     () => {
       const base = Array.isArray(matchOdds) ? matchOdds : [];
       const arr = [...base];
       arr.sort((a, b) => (a.date?.getTime?.() || 9e15) - (b.date?.getTime?.() || 9e15));
       return arr;
     },
     [matchOdds]
   );
 
   const ticketsBTTS = tickets?.btts || [];
   const ticketsOU25 = tickets?.ou25 || [];
-  The ticketsHTFT = tickets?.htft || [];
+  const ticketsFH = tickets?.fh_ou15 || [];
+  const ticketsHTFT = tickets?.htft || [];
 
   const confLeft = useMemo(() => {
     const base = Array.isArray(matchOdds) ? matchOdds : [];
     const arr = [...base];
     arr.sort((a, b) => (Number(b.conf) || 0) - (Number(a.conf) || 0));
     return arr;
   }, [matchOdds]);
 
   const rightSort = tab === "conf" ? "conf" : "ko";
 
   return (
     <div className="space-y-4">
       <div className="flex items-center gap-2">
-        <button className={`px-3 py-1.5 rounded-lg text-sm ${tab === "ko" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"}`} onClick={() => setTab("ko")} type="button">Kick-Off</button>
-        <button className={`px-3 py-1.5 rounded-lg text-sm ${tab === "conf" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-sla
-te-300"}`} onClick={() => setTab("conf")} type="button">Confidence</button>
-        <button className={`px-3 py-1.5 rounded-lg text-sm ${tab === "hist" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-sla
-te-300"}`} onClick={() => setTab("hist")} type="button">History</button>
+        <button
+          className={`px-3 py-1.5 rounded-lg text-sm ${
+            tab === "ko" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"
+          }`}
+          onClick={() => setTab("ko")}
+          type="button"
+        >
+          Kick-Off
+        </button>
+        <button
+          className={`px-3 py-1.5 rounded-lg text-sm ${
+            tab === "conf" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"
+          }`}
+          onClick={() => setTab("conf")}
+          type="button"
+        >
+          Confidence
+        </button>
+        <button
+          className={`px-3 py-1.5 rounded-lg text-sm ${
+            tab === "hist" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"
+          }`}
+          onClick={() => setTab("hist")}
+          type="button"
+        >
+          History
+        </button>
       </div>
 
       {tab === "hist" ? (
         <HistoryPanel days={14} top={3} />
       ) : (
         <div className="rounded-2xl bg-[#15182a] p-4">
           <div className="text-base font-semibold text-white mb-3">{tab === "ko" ? "Kick-Off" : "Confidence"}</div>
 
           <div className="flex flex-col md:flex-row md:gap-4 gap-4">
             <section className="md:basis-[55%] md:min-w-0">
               <div className="text-slate-200 font-semibold mb-2">Match Odds (1X2)</div>
               {! (tab === "ko" ? koLeft : confLeft).length ? (
                 <div className="text-slate-400 text-sm">Nema 1X2 ponuda.</div>
               ) : (
                 <div className="grid grid-cols-1 gap-3">
                   {(tab === "ko" ? koLeft : confLeft).map((b) => (<FootballCard key={b.id} bet={b} />))}
                 </div>
               )}
             </section>
 
             <section className="md:basis-[45%] md:min-w-0">
-              <div className="text-slate-200 font-semibold mb-2">Tickets — BTTS / O/U 2.5 / HT-FT</div>
-              {!ticketsBTTS.length && !ticketsOU25.length && !ticketsHTFT.length ? (
+              <div className="text-slate-200 font-semibold mb-2">Tickets — BTTS / O/U 2.5 / FH 1.5+ / HT-FT</div>
+              {!ticketsBTTS.length && !ticketsOU25.length && !ticketsFH.length && !ticketsHTFT.length ? (
                 <div className="text-slate-400 text-sm">Nema specijalnih tiketa.</div>
               ) : (
                 <div className="grid grid-cols-1 gap-3">
                   {ticketsBTTS.length ? <TicketGroupCard title="BTTS Ticket" items={ticketsBTTS} sortBy={rightSort} /> : null}
                   {ticketsOU25.length ? <TicketGroupCard title="O/U 2.5 Ticket" items={ticketsOU25} sortBy={rightSort} /> : null}
+                  {ticketsFH.length ? <TicketGroupCard title="FH 1.5+ Ticket" items={ticketsFH} sortBy={rightSort} /> : null}
                   {ticketsHTFT.length ? <TicketGroupCard title="HT-FT Ticket" items={ticketsHTFT} sortBy={rightSort} /> : null}
                 </div>
               )}
             </section>
           </div>
         </div>
       )}
     </div>
   );
 }
 
 /* ===================== Crypto sekcija (ostaje) ===================== */
 function CombinedBody({ footballTop3, cryptoTop3 }) {
   return (
     <div className="space-y-4">
       <div className="rounded-2xl bg-[#15182a] p-4">
         <div className="text-base font-semibold text-white mb-3">Football — Top 3</div>
         {!footballTop3.length ? (
           <div className="text-slate-400 text-sm">Trenutno nema predloga.</div>
         ) : (
           <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
             {footballTop3.map((b) => (<FootballCard key={b.id} bet={b} />))}
           </div>
         )}
       </div>
diff --git a/components/CombinedBets.jsx b/components/CombinedBets.jsx
index b8f979c7018c772d503fa0153bfef723795a438a..557b341dc4a14ab9e368e35e7efb04a5bb6872c0 100644
--- a/components/CombinedBets.jsx
+++ b/components/CombinedBets.jsx
@@ -529,38 +560,44 @@ function CryptoBody({ list }) {
   );
 }
 
 /* ===================== main ===================== */
 export default function CombinedBets() {
   const [tab, setTab] = useState("Combined");
   const fb = useValueBetsFeed();
   const matchOdds = useMemo(() => {
     if (Array.isArray(fb.oneXtwo) && fb.oneXtwo.length) return fb.oneXtwo;
     return fb.items.filter((x) => String(x.market).toUpperCase() === "1X2");
   }, [fb.items, fb.oneXtwo]);
   const crypto = useCryptoTop3();
   const top3Football = useMemo(
     () => {
       const arr = Array.isArray(matchOdds) ? [...matchOdds] : [];
       arr.sort((a, b) => (Number(b.conf) || 0) - (Number(a.conf) || 0));
       return arr.slice(0, 3);
     },
     [matchOdds]
   );
 
   return (
     <div className="mt-4 space-y-4">
       <div className="flex items-center gap-2">
         {["Combined", "Football", "Crypto"].map((name) => (
-          <button key={name} onClick={() => setTab(name)} className={`px-3 py-1.5 rounded-lg text-sm ${tab === name ? "bg-[#2025
-42] text-white" : "bg-[#171a2b] text-slate-300"}`} type="button">
+          <button
+            key={name}
+            onClick={() => setTab(name)}
+            className={`px-3 py-1.5 rounded-lg text-sm ${
+              tab === name ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"
+            }`}
+            type="button"
+          >
             {name}
           </button>
         ))}
       </div>
 
       {tab === "Combined" && (fb.loading ? <div className="text-slate-400 text-sm">Učitavam…</div> : fb.err ? <div className="text-red-400 text-sm">Greška: {fb.err}</div> : <CombinedBody footballTop3={top3Football} cryptoTop3={crypto.items} />)}
       {tab === "Football" && (fb.loading ? <div className="text-slate-400 text-sm">Učitavam…</div> : fb.err ? <div className="text-red-400 text-sm">Greška: {fb.err}</div> : <FootballBody matchOdds={matchOdds} tickets={fb.tickets} />)}
       {tab === "Crypto" && (crypto.loading ? <div className="text-slate-400 text-sm">Učitavam…</div> : crypto.err ? <div className="text-red-400 text-sm">Greška: {crypto.err}</div> : <CryptoBody list={crypto.items} />)}
     </div>
   );
 }
 
EOF
)
