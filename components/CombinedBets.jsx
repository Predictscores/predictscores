 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/components/CombinedBets.jsx b/components/CombinedBets.jsx
index 95a8bb04a2c8f6cbcf8540ec73f4ebabae515cee..b302e1f307f42c1acdb49c8f30459402503d1cbb 100644
--- a/components/CombinedBets.jsx
+++ b/components/CombinedBets.jsx
@@ -319,124 +319,142 @@ function TicketGroupCard({ title, items, sortBy = "ko" }) {
             <div className="text-sm text-slate-200 mt-0.5">
               <MarketBadge market={b.market} />{" "}
               <span className="font-semibold">{b.sel}</span>
               {b.odds ? <span className="text-slate-300"> ({Number(b.odds).toFixed(2)})</span> : <span className="text-slate-500"> (—)</span>}
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
+    oneXtwo: [],
     tickets: { btts: [], ou25: [], htft: [] },
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
 
+      const oneXtwoRaw = Array.isArray(j?.one_x_two)
+        ? j.one_x_two
+        : Array.isArray(j?.oneXtwo)
+        ? j.oneXtwo
+        : [];
+      const oneXtwo = oneXtwoRaw.map((it) => normalizeBet(it, "1X2"));
+
       const tb = j?.tickets || {};
       const bttsRaw = Array.isArray(tb.btts) ? tb.btts : [];
       const ou25Raw = Array.isArray(tb.ou25) ? tb.ou25 : [];
       const htftRaw = Array.isArray(tb.htft) ? tb.htft : [];
 
       const btts = bttsRaw.map((it) => normalizeBet(it, "BTTS"));
       const ou25 = ou25Raw.map((it) => normalizeBet(it, "O/U 2.5"));
       const htft = htftRaw.map((it) => normalizeBet(it, "HT-FT"));
 
       setState({
         items,
+        oneXtwo,
         tickets: { btts, ou25, htft },
         err: null,
         loading: false,
       });
     } catch (e) {
-      setState({ items: [], tickets: { btts: [], ou25: [], htft: [] }, err: String(e?.message || e), loading: false });
+      setState({ items: [], oneXtwo: [], tickets: { btts: [], ou25: [], htft: [] }, err: String(e?.message || e), loading: false });
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
-function FootballBody({ list, tickets }) {
+function FootballBody({ matchOdds, tickets }) {
   const [tab, setTab] = useState("ko"); // ko | conf | hist
 
-  const oneX2All = useMemo(() => list.filter(x => String(x.market).toUpperCase() === "1X2"), [list]);
+  const koLeft = useMemo(
+    () => {
+      const base = Array.isArray(matchOdds) ? matchOdds : [];
+      const arr = [...base];
+      arr.sort((a, b) => (a.date?.getTime?.() || 9e15) - (b.date?.getTime?.() || 9e15));
+      return arr;
+    },
+    [matchOdds]
+  );
 
   const ticketsBTTS = tickets?.btts || [];
   const ticketsOU25 = tickets?.ou25 || [];
   const ticketsHTFT = tickets?.htft || [];
 
-  const koLeft = useMemo(
-    () => [...oneX2All].sort((a, b) => (a.date?.getTime?.() || 9e15) - (b.date?.getTime?.() || 9e15)),
-    [oneX2All]
-  );
-  const confLeft = useMemo(() => [...oneX2All].sort((a, b) => b.conf - a.conf), [oneX2All]);
+  const confLeft = useMemo(() => {
+    const base = Array.isArray(matchOdds) ? matchOdds : [];
+    const arr = [...base];
+    arr.sort((a, b) => (Number(b.conf) || 0) - (Number(a.conf) || 0));
+    return arr;
+  }, [matchOdds]);
 
   const rightSort = tab === "conf" ? "conf" : "ko";
 
   return (
     <div className="space-y-4">
       <div className="flex items-center gap-2">
         <button className={`px-3 py-1.5 rounded-lg text-sm ${tab === "ko" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"}`} onClick={() => setTab("ko")} type="button">Kick-Off</button>
         <button className={`px-3 py-1.5 rounded-lg text-sm ${tab === "conf" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"}`} onClick={() => setTab("conf")} type="button">Confidence</button>
         <button className={`px-3 py-1.5 rounded-lg text-sm ${tab === "hist" ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"}`} onClick={() => setTab("hist")} type="button">History</button>
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
diff --git a/components/CombinedBets.jsx b/components/CombinedBets.jsx
index 95a8bb04a2c8f6cbcf8540ec73f4ebabae515cee..b302e1f307f42c1acdb49c8f30459402503d1cbb 100644
--- a/components/CombinedBets.jsx
+++ b/components/CombinedBets.jsx
@@ -488,47 +506,55 @@ function CombinedBody({ footballTop3, cryptoTop3 }) {
           </div>
         )}
       </div>
     </div>
   );
 }
 function CryptoBody({ list }) {
   return (
     <div className="rounded-2xl bg-[#15182a] p-4">
       <div className="text-base font-semibold text-white mb-3">Crypto — Top 3</div>
       {!list.length ? (
         <div className="text-slate-400 text-sm">Trenutno nema kripto signala.</div>
       ) : (
         <div className="space-y-3">
           {list.map((c, i) => (<SignalCard key={c?.symbol || i} data={c} type="crypto" />))}
         </div>
       )}
     </div>
   );
 }
 
 /* ===================== main ===================== */
 export default function CombinedBets() {
   const [tab, setTab] = useState("Combined");
   const fb = useValueBetsFeed();
+  const matchOdds = useMemo(() => {
+    if (Array.isArray(fb.oneXtwo) && fb.oneXtwo.length) return fb.oneXtwo;
+    return fb.items.filter((x) => String(x.market).toUpperCase() === "1X2");
+  }, [fb.items, fb.oneXtwo]);
   const crypto = useCryptoTop3();
   const top3Football = useMemo(
-    () => [...fb.items.filter(x => x.market === "1X2")].sort((a, b) => b.conf - a.conf).slice(0, 3),
-    [fb.items]
+    () => {
+      const arr = Array.isArray(matchOdds) ? [...matchOdds] : [];
+      arr.sort((a, b) => (Number(b.conf) || 0) - (Number(a.conf) || 0));
+      return arr.slice(0, 3);
+    },
+    [matchOdds]
   );
 
   return (
     <div className="mt-4 space-y-4">
       <div className="flex items-center gap-2">
         {["Combined", "Football", "Crypto"].map((name) => (
           <button key={name} onClick={() => setTab(name)} className={`px-3 py-1.5 rounded-lg text-sm ${tab === name ? "bg-[#202542] text-white" : "bg-[#171a2b] text-slate-300"}`} type="button">
             {name}
           </button>
         ))}
       </div>
 
       {tab === "Combined" && (fb.loading ? <div className="text-slate-400 text-sm">Učitavam…</div> : fb.err ? <div className="text-red-400 text-sm">Greška: {fb.err}</div> : <CombinedBody footballTop3={top3Football} cryptoTop3={crypto.items} />)}
-      {tab === "Football" && (fb.loading ? <div className="text-slate-400 text-sm">Učitavam…</div> : fb.err ? <div className="text-red-400 text-sm">Greška: {fb.err}</div> : <FootballBody list={fb.items} tickets={fb.tickets} />)}
+      {tab === "Football" && (fb.loading ? <div className="text-slate-400 text-sm">Učitavam…</div> : fb.err ? <div className="text-red-400 text-sm">Greška: {fb.err}</div> : <FootballBody matchOdds={matchOdds} tickets={fb.tickets} />)}
       {tab === "Crypto" && (crypto.loading ? <div className="text-slate-400 text-sm">Učitavam…</div> : crypto.err ? <div className="text-red-400 text-sm">Greška: {crypto.err}</div> : <CryptoBody list={crypto.items} />)}
     </div>
   );
 }
 
