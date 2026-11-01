// Inert module extracted from main.01f91df0.js; not independently executable.
((e, t, n) => {
        "use strict";

        n.d(t, {
          $4: () => he,
          Eq: () => He,
          FO: () => ue,
          FY: () => c,
          Fy: () => et,
          HF: () => Ce,
          Hu: () => ye,
          LD: () => ke,
          NS: () => xe,
          Om: () => we,
          PE: () => pe,
          PH: () => De,
          QO: () => qe,
          Qg: () => Qe,
          S7: () => at,
          Vm: () => Ee,
          Vq: () => nt,
          XZ: () => $e,
          Xn: () => Xe,
          Y9: () => Je,
          YN: () => Ae,
          ZP: () => st,
          ZS: () => ot,
          cw: () => Ze,
          dL: () => ze,
          fb: () => rt,
          h4: () => tt,
          ho: () => Te,
          iA: () => de,
          lj: () => We,
          nB: () => ve,
          nb: () => Re,
          pL: () => me,
          q4: () => be,
          sc: () => it,
          t0: () => Se,
          u$: () => _e,
          vK: () => ge,
          wr: () => Pe,
          x5: () => fe
        });
        var r = n(70089),
          o = n(70816),
          a = n.n(o),
          i = n(1805),
          s = n(30681),
          l = n(47374);
        const c = 25,
          d = () => {
            try {
              return Intl.DateTimeFormat().resolvedOptions().timeZone || void 0;
            } catch {
              return;
            }
          },
          u = {
            selectedMedia: {},
            selectedFile: null,
            details: "",
            previewImageUrl: null,
            filename: "",
            adName: "",
            budget: null,
            gender: "ALL",
            time: 0,
            fileSection: "IMAGE",
            thumbnailUrl: null,
            thumbnailMedia: {},
            pageDetails: {},
            heading: "",
            adInsights: {
              isLoading: !1,
              iframePreview: null,
              insights: null,
              error: null
            },
            syncAd: {
              isLoading: !1,
              adData: null,
              adAccount: null,
              error: null
            },
            updateAdStatus: {
              isLoading: !1,
              error: null
            },
            adAccountInsights: {
              isLoading: !1,
              isLoadingAds: !1,
              isLoadingAggregated: !1,
              data: null,
              headerColumns: [],
              pagination: null,
              aggregated: null,
              error: null,
              lastFetchParams: null,
              streamController: null
            },
            exportAdInsights: {
              isLoading: !1,
              error: null
            },
            leads: {
              leads: [],
              ctwaLeads: [],
              forms: [],
              ads: [],
              leadsAds: [],
              ctwaAds: [],
              loading: !1,
              ctwaLoading: !1,
              statsLoading: !1,
              fetchingHistorical: !1,
              isExporting: !1,
              error: null,
              page: 0,
              rowsPerPage: 10,
              ctwaPage: 0,
              ctwaRowsPerPage: 10,
              total: 0,
              search: "",
              selectedFormId: "",
              selectedAdId: "",
              selectedAdIdCTWA: "",
              startDate: null,
              endDate: null,
              stats: {
                total: 0
              },
              selected: [],
              selectAll: !1,
              unSelected: [],
              selectedCount: 0,
              selectedOptNo: 0,
              unSelectedOptNo: 0,
              activeTab: "all",
              fetchHistoricalFormId: "",
              fetchHistoricalStartDate: null,
              fetchHistoricalEndDate: null,
              fetchHistoricalResult: null
            }
          },
          p = "ADS/CREATE_ADS",
          h = "ADS/DETAILS",
          f = "ADS/BUDGET",
          m = "ADS/GENDER",
          g = "ADS/NAME",
          y = "ADS/PAGE_DETAILS",
          v = "ADS/FETCH_AD_INSIGHTS_START",
          b = "ADS/FETCH_AD_INSIGHTS_SUCCESS",
          A = "ADS/FETCH_AD_INSIGHTS_FAILURE",
          x = "ADS/SYNC_AD_START",
          C = "ADS/SYNC_AD_SUCCESS",
          E = "ADS/SYNC_AD_FAILURE",
          S = "ADS/UPDATE_AD_STATUS_START",
          w = "ADS/UPDATE_AD_STATUS_SUCCESS",
          _ = "ADS/UPDATE_AD_STATUS_FAILURE",
          P = "ADS/PATCH_AD_STATUSES",
          I = "ADS/FETCH_AD_ACCOUNT_INSIGHTS_START",
          T = "ADS/FETCH_AD_ACCOUNT_INSIGHTS_SUCCESS",
          k = "ADS/FETCH_AD_ACCOUNT_INSIGHTS_FAILURE",
          R = "ADS/FETCH_AD_ACCOUNT_INSIGHTS_STREAM_START",
          D = "ADS/FETCH_AD_ACCOUNT_INSIGHTS_STREAM_ADS",
          O = "ADS/FETCH_AD_ACCOUNT_INSIGHTS_STREAM_AGGREGATED",
          M = "ADS/FETCH_AD_ACCOUNT_INSIGHTS_STREAM_ERROR",
          N = "ADS/FETCH_AD_ACCOUNT_INSIGHTS_STREAM_COMPLETE",
          j = "ADS/EXPORT_AD_INSIGHTS_START",
          L = "ADS/EXPORT_AD_INSIGHTS_SUCCESS",
          Z = "ADS/EXPORT_AD_INSIGHTS_FAILURE",
          F = "ADS/CLEAR_AD_ACCOUNT_INSIGHTS",
          B = "ADS/FETCH_LEADS_START",
          U = "ADS/FETCH_LEADS_SUCCESS",
          z = "ADS/FETCH_LEADS_FAILURE",
          H = "ADS/FETCH_CTWA_LEADS_START",
          W = "ADS/FETCH_CTWA_LEADS_SUCCESS",
          G = "ADS/FETCH_CTWA_LEADS_FAILURE",
          V = "ADS/FETCH_LEAD_FORMS_START",
          Y = "ADS/FETCH_LEAD_FORMS_SUCCESS",
          K = "ADS/FETCH_LEAD_FORMS_FAILURE",
          q = "ADS/FETCH_LEADS_STATS_START",
          Q = "ADS/FETCH_LEADS_STATS_SUCCESS",
          $ = "ADS/FETCH_LEADS_STATS_FAILURE",
          X = "ADS/FETCH_HISTORICAL_LEADS_START",
          J = "ADS/FETCH_HISTORICAL_LEADS_SUCCESS",
          ee = "ADS/FETCH_HISTORICAL_LEADS_FAILURE",
          te = "ADS/EXPORT_LEADS_START",
          ne = "ADS/EXPORT_LEADS_SUCCESS",
          re = "ADS/EXPORT_LEADS_FAILURE",
          oe = "ADS/UPDATE_LEADS_FILTERS",
          ae = "ADS/UPDATE_LEADS_PAGINATION",
          ie = "ADS/UPDATE_LEADS_SELECTION",
          se = "ADS/CLEAR_LEADS_SELECTION",
          le = "ADS/SET_LEADS_ACTIVE_TAB",
          ce = "ADS/UPDATE_LEADS_OPTED_COUNT",
          de = e => t => {
            t((e => {
              let {
                payload: t
              } = e;
              return {
                type: p,
                payload: t
              };
            })({
              payload: e
            }));
          },
          ue = e => t => {
            t((e => {
              let {
                payload: t
              } = e;
              return {
                type: f,
                payload: t
              };
            })({
              payload: e
            }));
          },
          pe = e => t => {
            t((e => {
              let {
                payload: t
              } = e;
              return {
                type: g,
                payload: t
              };
            })({
              payload: e
            }));
          },
          he = e => t => {
            t((e => {
              let {
                payload: t
              } = e;
              return {
                type: h,
                payload: t
              };
            })({
              payload: e
            }));
          },
          fe = e => t => {
            t((e => {
              let {
                payload: t
              } = e;
              return {
                type: y,
                payload: t
              };
            })({
              payload: e
            }));
          },
          me = function (e, t) {
            let n = arguments.length > 2 && void 0 !== arguments[2] ? arguments[2] : "",
              o = arguments.length > 3 ? arguments[3] : void 0,
              a = arguments.length > 4 ? arguments[4] : void 0;
            return async (s, l) => {
              s({
                type: v
              });
              try {
                var c, d, u;
                const l = await r.Z.post("".concat(i.ADS_REST_API_URL, "/meta/analytics/ad-insights"), {
                  assistantId: e,
                  adId: t,
                  previewFormat: n,
                  startDate: null === o || void 0 === o ? void 0 : o.format("YYYY-MM-DD"),
                  endDate: null === a || void 0 === a ? void 0 : a.format("YYYY-MM-DD")
                });
                s((f = {
                  iframePreview: (null === (c = l.data) || void 0 === c ? void 0 : c.iframePreview) || (null === (d = l.data) || void 0 === d ? void 0 : d.previewIframe) || null,
                  insights: (null === (u = l.data) || void 0 === u ? void 0 : u.insights) || l.data || null
                }, {
                  type: b,
                  payload: f
                }));
              } catch (m) {
                var p, h;
                s((e => ({
                  type: A,
                  payload: e
                }))((null === (p = m.response) || void 0 === p || null === (h = p.data) || void 0 === h ? void 0 : h.message) || m.message || "Failed to fetch ad insights"));
              }
              var f;
            };
          },
          ge = (e, t) => async n => {
            n({
              type: x
            });
            try {
              var o, a;
              const s = await r.Z.post("".concat(i.ADS_REST_API_URL, "/meta/ads/sync"), {
                assistantId: e,
                _id: t
              });
              return n((c = {
                adData: (null === (o = s.data) || void 0 === o ? void 0 : o.adData) || null,
                adAccount: (null === (a = s.data) || void 0 === a ? void 0 : a.adAccountData) || null
              }, {
                type: C,
                payload: c
              })), s.data;
            } catch (d) {
              var s, l;
              throw n((e => ({
                type: E,
                payload: e
              }))((null === (s = d.response) || void 0 === s || null === (l = s.data) || void 0 === l ? void 0 : l.message) || d.message || "Failed to sync ad")), d;
            }
            var c;
          },
          ye = async function (e, t, n) {
            let o = arguments.length > 3 && void 0 !== arguments[3] ? arguments[3] : {};
            return (await r.Z.post("".concat(i.ADS_REST_API_URL, "/meta/leads/sync"), {
              assistantId: e,
              pageId: t,
              formId: n,
              ...o
            })).data;
          },
          ve = async (e, t) => ye(e, t, void 0, {
            syncFormsOnly: !0
          }),
          be = async function (e) {
            let {
              syncBatchId: t,
              formId: n
            } = arguments.length > 1 && void 0 !== arguments[1] ? arguments[1] : {};
            const o = {
              assistantId: e
            };
            t && (o.syncBatchId = t), n && (o.formId = n);
            return (await r.Z.get("".concat(i.ADS_REST_API_URL, "/meta/leads/sync-status"), {
              params: o
            })).data;
          },
          Ae = async e => (await r.Z.post("".concat(i.URL, "/api/get-daily-template-quota"), {
            assistantId: e
          })).data,
          xe = async e => {
            let {
              assistantId: t,
              type: n = "all",
              search: o,
              formId: a,
              adId: s,
              startDate: l,
              endDate: c,
              page: u = 1,
              limit: p = 10,
              answers: h
            } = e;
            const f = {
              assistantId: t,
              type: n,
              page: u,
              limit: p
            };
            o && (f.search = o), a && (f.formId = a), s && (f.adId = s), l && (f.startDate = l), c && (f.endDate = c), Array.isArray(h) && h.length && (f.answers = JSON.stringify(h));
            const m = d();
            m && (f.timezone = m);
            return (await r.Z.get("".concat(i.ADS_REST_API_URL, "/meta/leads/contacts"), {
              params: f
            })).data;
          },
          Ce = async e => {
            const t = {
                assistantId: e
              },
              n = d();
            n && (t.timezone = n);
            return (await r.Z.get("".concat(i.ADS_REST_API_URL, "/meta/leads/stats"), {
              params: t
            })).data;
          },
          Ee = async function (e, t) {
            let {
              page: n = 1,
              limit: o = 50
            } = arguments.length > 2 && void 0 !== arguments[2] ? arguments[2] : {};
            return (await r.Z.get("".concat(i.ADS_REST_API_URL, "/meta/leads/contacts/").concat(e, "/submissions"), {
              params: {
                assistantId: t,
                page: n,
                limit: o
              }
            })).data;
          },
          Se = async function (e, t, n, o) {
            let a = arguments.length > 4 && void 0 !== arguments[4] ? arguments[4] : 1,
              s = arguments.length > 5 && void 0 !== arguments[5] ? arguments[5] : 10,
              {
                automationEnabled: l,
                sortBy: c,
                sortOrder: d
              } = arguments.length > 6 && void 0 !== arguments[6] ? arguments[6] : {};
            const u = {
              assistantId: e,
              pageId: t,
              page: a,
              limit: s
            };
            n && (u.status = n), o && (u.search = o), void 0 !== l && null !== l && (u.automationEnabled = String(l)), c && (u.sortBy = c), d && (u.sortOrder = d);
            return (await r.Z.get("".concat(i.ADS_REST_API_URL, "/meta/lead-forms"), {
              params: u
            })).data;
          },
          we = async (e, t) => (await r.Z.get("".concat(i.ADS_REST_API_URL, "/meta/lead-forms/").concat(e), {
            params: {
              assistantId: t
            }
          })).data,
          _e = async function (e, t) {
            let {
              startDate: n,
              endDate: o
            } = arguments.length > 2 && void 0 !== arguments[2] ? arguments[2] : {};
            const a = {
              assistantId: t
            };
            n && (a.startDate = n), o && (a.endDate = o);
            const s = d();
            s && (a.timezone = s);
            return (await r.Z.get("".concat(i.ADS_REST_API_URL, "/meta/lead-forms/").concat(e, "/overview"), {
              params: a
            })).data;
          },
          Pe = async function () {
            let {
              assistantId: e,
              startDate: t,
              endDate: n,
              formId: o,
              adId: a
            } = arguments.length > 0 && void 0 !== arguments[0] ? arguments[0] : {};
            const s = {
              assistantId: e
            };
            t && (s.startDate = t), n && (s.endDate = n), o && (s.formId = o), a && (s.adId = a);
            return (await r.Z.get("".concat(i.URL, "/meta-ads/lead-analytics"), {
              params: s
            })).data;
          },
          Ie = (e, t) => {
            let n = t;
            const r = e.headers["content-disposition"];
            if (r) {
              const e = r.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
              e && e[1] && (n = e[1].replace(/['"]/g, ""));
            }
            const o = new Blob([e.data], {
                type: "text/csv;charset=utf-8;"
              }),
              a = window.URL.createObjectURL(o),
              i = document.createElement("a");
            i.href = a, i.download = n, document.body.appendChild(i), i.click(), window.URL.revokeObjectURL(a), document.body.removeChild(i);
          },
          Te = async function (e) {
            let {
              type: t = "all",
              formId: n = "",
              adId: o = "",
              startDate: s = null,
              endDate: l = null,
              search: c = "",
              hasSelection: u = !1,
              selectAll: p = !1,
              selectedNums: h = [],
              unselectedNums: f = []
            } = arguments.length > 1 && void 0 !== arguments[1] ? arguments[1] : {};
            if (!e) throw new Error("Assistant ID is required for export");
            const m = {
              assistantId: e,
              exportType: "form" === t ? "form-submissions" : "ctwa" === t ? "ctwa-leads" : "all",
              sortBy: "createdTime",
              sortOrder: "desc"
            };
            n && "" !== String(n).trim() && (m.formId = String(n)), o && "" !== String(o).trim() && (m.adId = String(o)), s && (m.startDate = a()(s).format("YYYY-MM-DD")), l && (m.endDate = a()(l).format("YYYY-MM-DD")), m.type = t, c && "" !== String(c).trim() && (m.search = String(c).trim()), u && (m.selectAll = p ? "true" : "false", p ? m.unselectedNums = f.join(",") : m.selectedNums = h.join(","));
            const g = d();
            g && (m.timezone = g);
            const y = await r.Z.get("".concat(i.ADS_REST_API_URL, "/meta/leads/contacts/export"), {
              params: m,
              responseType: "blob"
            });
            Ie(y, "lead-submissions-".concat(e, "-").concat(a()().format("YYYY-MM-DD"), ".csv"));
          },
          ke = async function (e) {
            let {
              formId: t,
              startDate: n = null,
              endDate: o = null,
              search: s = "",
              answers: l = null,
              hasSelection: c = !1,
              selectAll: u = !1,
              selectedNums: p = [],
              unselectedNums: h = []
            } = arguments.length > 1 && void 0 !== arguments[1] ? arguments[1] : {};
            if (!e) throw new Error("Assistant ID is required for export");
            if (!t) throw new Error("Form ID is required for export");
            const f = {
              assistantId: e,
              formId: t,
              sortBy: "createdTime",
              sortOrder: "desc"
            };
            s && "" !== String(s).trim() && (f.search = String(s).trim()), n && (f.startDate = a()(n).format("YYYY-MM-DD")), o && (f.endDate = a()(o).format("YYYY-MM-DD")), Array.isArray(l) && l.length && (f.answers = JSON.stringify(l)), c && (f.selectAll = u ? "true" : "false", u ? f.unselectedNums = h.join(",") : f.selectedNums = p.join(","));
            const m = d();
            m && (f.timezone = m);
            const g = await r.Z.get("".concat(i.ADS_REST_API_URL, "/meta/leads/form-responses/export"), {
              params: f,
              responseType: "blob"
            });
            Ie(g, "form-responses-".concat(t, "-").concat(a()().format("YYYY-MM-DD"), ".csv"));
          },
          Re = (e, t, n, o, a) => async s => {
            s({
              type: S
            });
            try {
              const l = await r.Z.post("".concat(i.ADS_REST_API_URL, "/meta/ads/update-status"), {
                assistantId: e,
                status: a,
                adId: n,
                _id: t,
                adAccountId: o
              });
              return s({
                type: w
              }), l.data;
            } catch (d) {
              var l, c;
              throw s((e => ({
                type: _,
                payload: e
              }))((null === (l = d.response) || void 0 === l || null === (c = l.data) || void 0 === c ? void 0 : c.message) || d.message || "Failed to update ad status")), d;
            }
          },
          De = e => ({
            type: P,
            payload: Array.isArray(e) ? e : [e]
          }),
          Oe = e => ({
            type: T,
            payload: e
          }),
          Me = e => ({
            type: k,
            payload: e
          }),
          Ne = e => ({
            type: D,
            payload: e
          }),
          je = e => ({
            type: O,
            payload: e
          }),
          Le = e => ({
            type: M,
            payload: e
          }),
          Ze = () => e => {
            e({
              type: F
            });
          };
        let Fe = null,
          Be = null;
        const Ue = e => {
            const t = [],
              n = e.split("\n\n");
            for (let o = 0; o < n.length - 1; o++) {
              const e = n[o].trim();
              if (!e) continue;
              const a = {},
                i = e.split("\n");
              for (const t of i) {
                const e = t.indexOf(":");
                if (-1 === e) continue;
                const n = t.substring(0, e).trim(),
                  o = t.substring(e + 1).trim();
                if ("data" === n) try {
                  a.data = JSON.parse(o);
                } catch (r) {
                  a.data = o;
                } else a[n] = o;
              }
              Object.keys(a).length > 0 && t.push(a);
            }
            return {
              events: t,
              remainingBuffer: n.length > 0 ? n[n.length - 1] : ""
            };
          },
          ze = () => {
            Fe && (Fe.cancel("Request cancelled due to tab switch"), Fe = null), Be && (Be.abort(), Be = null);
          },
          He = e => {
            let {
              assistantId: t,
              adAccountId: n,
              page: o = 1,
              limit: a = c,
              nameQuery: d = "",
              startDate: u = null,
              endDate: p = null,
              selectedOption: h = null,
              bypassCache: f = !1,
              useStream: m = !0
            } = e;
            return async (e, c) => {
              if (ze(), !n) return void e(Me("Ad Account ID is required"));
              const g = c(),
                y = g.ads.adAccountInsights.lastFetchParams,
                v = g.ads.adAccountInsights.data;
              if (!f && y && v) {
                var b, A;
                y.accountId === n && (null === (b = y.startDate) || void 0 === b ? void 0 : b.format("YYYY-MM-DD")) === (null === u || void 0 === u ? void 0 : u.format("YYYY-MM-DD")) && (null === (A = y.endDate) || void 0 === A ? void 0 : A.format("YYYY-MM-DD")) === (null === p || void 0 === p ? void 0 : p.format("YYYY-MM-DD")) && y.selectedOption === h && y.nameQuery === d && y.page === o && y.limit;
              }
              let x = null,
                C = !1;
              if (!f) try {
                const r = (0, s.By)({
                  assistantId: t,
                  adAccountId: n,
                  page: o,
                  limit: a,
                  nameQuery: d,
                  startDate: u,
                  endDate: p,
                  selectedOption: h
                });
                x = await (0, s.VM)(r), x && (e(Oe({
                  ads: x.ads || [],
                  headerColumns: x.headerColumns || [],
                  pagination: x.pagination || null,
                  aggregated: x.aggregated || null,
                  lastFetchParams: x.lastFetchParams || {
                    accountId: n,
                    startDate: u,
                    endDate: p,
                    selectedOption: h,
                    nameQuery: d,
                    page: o,
                    limit: a
                  }
                })), C = !0);
              } catch (O) {
                console.error("Error loading cached data from IndexedDB:", O);
              }
              const E = {
                assistantId: t,
                adAccountId: n,
                page: o,
                limit: a,
                adName: d
              };
              if (u && p && (E.startDate = u.format("YYYY-MM-DD"), E.endDate = p.format("YYYY-MM-DD")), h && (E.adEffectiveStatus = h), m) {
                Be = new AbortController();
                const r = Be.signal;
                C || e({
                  type: R,
                  payload: {
                    abortController: Be
                  }
                });
                try {
                  const f = "".concat(i.ADS_REST_API_URL, "/meta/analytics/account-insights"),
                    m = f.includes("?") ? "".concat(f, "&stream=true") : "".concat(f, "?stream=true"),
                    g = {
                      "Content-Type": "application/json",
                      Accept: "text/event-stream",
                      "x-wa-dev-internal-request": "true"
                    };
                  0;
                  const y = await (0, l.zk)(m, {
                    method: "POST",
                    headers: g,
                    body: JSON.stringify(E),
                    signal: r,
                    credentials: "include"
                  });
                  if (!y.ok) throw new Error("HTTP error! status: ".concat(y.status));
                  const v = y.body.getReader(),
                    b = new TextDecoder();
                  let A = "",
                    C = !1;
                  for (;;) {
                    const {
                      done: r,
                      value: i
                    } = await v.read();
                    if (r) break;
                    A += b.decode(i, {
                      stream: !0
                    });
                    const {
                      events: l,
                      remainingBuffer: f
                    } = Ue(A);
                    A = f;
                    for (const m of l) {
                      if (!m.data) continue;
                      if ("heartbeat" === m.data.type) continue;
                      if ("complete" === m.data.type) {
                        e({
                          type: N
                        }), Be = null;
                        const r = c().ads.adAccountInsights;
                        try {
                          const e = (0, s.By)({
                            assistantId: t,
                            adAccountId: n,
                            page: o,
                            limit: a,
                            nameQuery: d,
                            startDate: u,
                            endDate: p,
                            selectedOption: h
                          });
                          await (0, s.jp)(e, {
                            ads: r.data || [],
                            headerColumns: r.headerColumns || [],
                            pagination: r.pagination || null,
                            aggregated: r.aggregated || null,
                            lastFetchParams: r.lastFetchParams
                          });
                        } catch (M) {
                          console.error("Error saving data to IndexedDB:", M);
                        }
                        return;
                      }
                      if ("error" === m.data.type) {
                        const t = m.data.message || "Stream error occurred";
                        throw e(Le(t)), Be = null, new Error(t);
                      }
                      const r = m.data,
                        i = r.aggregated && Object.keys(r.aggregated).length > 0;
                      var S;
                      if (C) i && e(je({
                        ads: r.ads || [],
                        headerColumns: r.headerColumns || [],
                        pagination: r.pagination || null,
                        aggregated: r.aggregated || null,
                        lastFetchParams: {
                          accountId: n,
                          startDate: u,
                          endDate: p,
                          selectedOption: h,
                          nameQuery: d,
                          page: o,
                          limit: a
                        }
                      }));else C = !0, e(Ne({
                        ads: r.ads || [],
                        headerColumns: r.headerColumns || [],
                        pagination: r.pagination || null,
                        aggregated: (null === (S = x) || void 0 === S ? void 0 : S.aggregated) || null,
                        lastFetchParams: {
                          accountId: n,
                          startDate: u,
                          endDate: p,
                          selectedOption: h,
                          nameQuery: d,
                          page: o,
                          limit: a
                        }
                      }));
                    }
                  }
                } catch (O) {
                  if ("AbortError" === O.name) return void console.log("Stream cancelled:", O.message);
                  if (C && x) return console.warn("Stream request failed, but cached data is available"), x;
                  const t = O.message || "Failed to fetch ad account insights";
                  throw e(Le(t)), Be = null, O;
                }
              } else {
                Fe = r.Z.CancelToken.source(), C || e({
                  type: I
                });
                try {
                  var w, _, P, T;
                  const l = await r.Z.post("".concat(i.ADS_REST_API_URL, "/meta/analytics/account-insights"), E, {
                      cancelToken: Fe.token
                    }),
                    c = {
                      ads: (null === (w = l.data) || void 0 === w ? void 0 : w.ads) || [],
                      headerColumns: (null === (_ = l.data) || void 0 === _ ? void 0 : _.headerColumns) || [],
                      pagination: (null === (P = l.data) || void 0 === P ? void 0 : P.pagination) || null,
                      aggregated: (null === (T = l.data) || void 0 === T ? void 0 : T.aggregated) || null,
                      lastFetchParams: {
                        accountId: n,
                        startDate: u,
                        endDate: p,
                        selectedOption: h,
                        nameQuery: d,
                        page: o,
                        limit: a
                      }
                    };
                  e(Oe(c));
                  try {
                    const e = (0, s.By)({
                      assistantId: t,
                      adAccountId: n,
                      page: o,
                      limit: a,
                      nameQuery: d,
                      startDate: u,
                      endDate: p,
                      selectedOption: h
                    });
                    await (0, s.jp)(e, c);
                  } catch (M) {
                    console.error("Error saving data to IndexedDB:", M);
                  }
                  return Fe = null, l.data;
                } catch (O) {
                  var k, D;
                  if (r.Z.isCancel(O)) return void console.log("Request cancelled:", O.message);
                  if (C && x) return console.warn("API request failed, but cached data is available"), x;
                  const t = (null === (k = O.response) || void 0 === k || null === (D = k.data) || void 0 === D ? void 0 : D.message) || O.message || "Failed to fetch ad account insights";
                  throw e(Me(t)), O;
                }
              }
            };
          },
          We = e => {
            let {
              adAccountId: t,
              assistantId: n,
              startDate: o,
              endDate: a,
              adName: s = "",
              columns: l = [],
              selectedOption: c = null,
              reportType: d = "aggregated"
            } = e;
            return async e => {
              e({
                type: j
              });
              try {
                const u = {
                  adAccountId: t,
                  assistantId: n,
                  startDate: o ? o.format("YYYY-MM-DD") : null,
                  endDate: a ? a.format("YYYY-MM-DD") : null,
                  adName: s,
                  columns: l,
                  exportType: d
                };
                c && (u.adEffectiveStatus = c);
                const p = await r.Z.post("".concat(i.ADS_REST_API_URL, "/meta/analytics/account-insights/export"), u, {
                    responseType: "blob"
                  }),
                  h = new Blob([p.data], {
                    type: "text/csv"
                  }),
                  f = window.URL.createObjectURL(h),
                  m = document.createElement("a");
                return m.href = f, m.setAttribute("download", "Ad Analytics Report".concat(o && a ? " ".concat(o ? o.format("MM/DD/YYYY") : "", " TO ").concat(a ? a.format("MM/DD/YYYY") : "") : "", ".csv")), document.body.appendChild(m), m.click(), m.parentNode.removeChild(m), window.URL.revokeObjectURL(f), e({
                  type: L
                }), p.data;
              } catch (m) {
                var u;
                let t = "Failed to export ad account insights";
                var p, h;
                if ((null === (u = m.response) || void 0 === u ? void 0 : u.data) instanceof Blob) try {
                  const e = await m.response.data.text();
                  t = JSON.parse(e).message || t;
                } catch (g) {
                  var f;
                  t = (null === (f = m.response) || void 0 === f ? void 0 : f.statusText) || t;
                } else t = (null === (p = m.response) || void 0 === p || null === (h = p.data) || void 0 === h ? void 0 : h.message) || m.message || t;
                throw e((e => ({
                  type: Z,
                  payload: e
                }))(t)), m;
              }
            };
          },
          Ge = e => ({
            type: U,
            payload: e
          }),
          Ve = e => ({
            type: z,
            payload: e
          }),
          Ye = e => ({
            type: K,
            payload: e
          }),
          Ke = e => ({
            type: ee,
            payload: e
          }),
          qe = function (e, t) {
            let {
              page: n = 0,
              rowsPerPage: o = 10,
              search: s = "",
              selectedFormId: l = "",
              selectedAdId: c = "",
              startDate: d = null,
              endDate: u = null,
              activeTab: p = "all"
            } = arguments.length > 2 && void 0 !== arguments[2] ? arguments[2] : {};
            return async (h, f) => {
              if (console.log(e, t, {
                activeTab: p,
                rowsPerPage: o,
                page: n,
                search: s,
                selectedFormId: l,
                selectedAdId: c,
                startDate: d,
                endDate: u
              }), e && t) {
                h({
                  type: B
                });
                try {
                  var m;
                  const t = {
                    assistantId: e,
                    page: n + 1,
                    limit: o,
                    type: p
                  };
                  if (s && (t.search = s), l && "" !== String(l).trim() && (t.formId = String(l)), c && "" !== String(c).trim() && (t.adId = String(c)), d) {
                    const e = a()(d).startOf("day");
                    t.startDate = e.format("YYYY-MM-DDTHH:mm:ss.SSS");
                  }
                  if (u) {
                    const e = a()(u).endOf("day");
                    t.endDate = e.format("YYYY-MM-DDTHH:mm:ss.SSS");
                  }
                  const f = await r.Z.get("".concat(i.ADS_REST_API_URL, "/meta/leads/contacts"), {
                    params: t
                  });
                  if (null !== (m = f.data) && void 0 !== m && m.status) {
                    var g;
                    const e = f.data.data || [],
                      t = new Map();
                    e.forEach(e => {
                      e.adId && !t.has(e.adId) && t.set(e.adId, {
                        adId: e.adId,
                        adName: e.adName || e.adId
                      });
                    });
                    const n = Array.from(t.values());
                    h(Ge({
                      leads: e,
                      leadsAds: n,
                      total: (null === (g = f.data.pagination) || void 0 === g ? void 0 : g.total) || 0
                    }));
                  } else {
                    var y;
                    h(Ve((null === (y = f.data) || void 0 === y ? void 0 : y.message) || "Failed to fetch leads"));
                  }
                } catch (A) {
                  var v, b;
                  h(Ve((null === (v = A.response) || void 0 === v || null === (b = v.data) || void 0 === b ? void 0 : b.message) || "Failed to fetch leads"));
                }
              } else h(Ge({
                leads: [],
                leadsAds: [],
                total: 0
              }));
            };
          },
          Qe = (e, t) => async n => {
            if (e && t) {
              n({
                type: V
              });
              try {
                var o;
                const s = await r.Z.get("".concat(i.ADS_REST_API_URL, "/meta/lead-forms"), {
                  params: {
                    assistantId: e,
                    pageId: t,
                    status: "ACTIVE",
                    limit: 50
                  }
                });
                var a;
                if (null !== (o = s.data) && void 0 !== o && o.status) n((c = {
                  forms: s.data.data || []
                }, {
                  type: Y,
                  payload: c
                }));else n(Ye((null === (a = s.data) || void 0 === a ? void 0 : a.message) || "Failed to fetch forms"));
              } catch (d) {
                var s, l;
                n(Ye((null === (s = d.response) || void 0 === s || null === (l = s.data) || void 0 === l ? void 0 : l.message) || "Failed to fetch forms"));
              }
              var c;
            }
          },
          $e = e => async (t, n) => {
            if (e) try {
              var o;
              const n = await r.Z.get("".concat(i.ADS_REST_API_URL, "/meta/leads/ads-list"), {
                params: {
                  assistantId: e
                }
              });
              if (null !== (o = n.data) && void 0 !== o && o.status) {
                const e = n.data.data || [];
                t({
                  type: Y,
                  payload: {
                    ads: e
                  }
                });
              }
            } catch (a) {
              console.error("Error fetching ads:", a);
            }
          },
          Xe = function (e, t, n) {
            let o = arguments.length > 3 && void 0 !== arguments[3] ? arguments[3] : null,
              s = arguments.length > 4 && void 0 !== arguments[4] ? arguments[4] : null;
            return async l => {
              if (e && t) {
                if (n) {
                  l({
                    type: X
                  });
                  try {
                    var c;
                    const u = {
                      assistantId: e,
                      pageId: t,
                      formId: n
                    };
                    o && (u.startDate = a()(o).format("YYYY-MM-DD")), s && (u.endDate = a()(s).format("YYYY-MM-DD"));
                    const p = await r.Z.post("".concat(i.URL, "/meta-ads/fetch-historical-leads"), u);
                    var d;
                    if (null !== (c = p.data) && void 0 !== c && c.status) l((e => ({
                      type: J,
                      payload: e
                    }))({
                      success: !0,
                      message: p.data.message,
                      data: p.data.data
                    }));else l(Ke((null === (d = p.data) || void 0 === d ? void 0 : d.message) || "Failed to fetch historical leads"));
                  } catch (h) {
                    var u, p;
                    l(Ke((null === (u = h.response) || void 0 === u || null === (p = u.data) || void 0 === p ? void 0 : p.message) || h.message || "Failed to fetch historical leads"));
                  }
                } else l(Ke("Please select a form to fetch leads from"));
              } else l(Ke("Assistant ID and Page ID are required"));
            };
          },
          Je = function (e, t) {
            let {
              selectedFormId: n = "",
              selectedAdId: o = "",
              selectedAdIdCTWA: s = "",
              startDate: l = null,
              endDate: c = null,
              activeTab: d = "all"
            } = arguments.length > 2 && void 0 !== arguments[2] ? arguments[2] : {};
            return async u => {
              if (!e) throw new Error("Assistant ID is required for export");
              if ("form" === d && !t) throw new Error("Page ID is required for exporting lead form submissions");
              u({
                type: te
              });
              try {
                let t;
                "all" === d ? t = "all" : "form" === d ? t = "form-submissions" : "ctwa" === d && (t = "ctwa-leads");
                const p = {
                  assistantId: e,
                  exportType: t
                };
                let h;
                n && "" !== String(n).trim() && (p.formId = String(n)), "all" === d ? h = o || s : "form" === d ? h = o : "ctwa" === d && (h = s), h && "" !== String(h).trim() && (p.adId = String(h)), l && (p.startDate = a()(l).format("YYYY-MM-DD")), c && (p.endDate = a()(c).format("YYYY-MM-DD")), p.sortBy = "createdTime", p.sortOrder = "desc";
                const f = await r.Z.get("".concat(i.ADS_REST_API_URL, "/meta/leads/contacts/export"), {
                  params: p
                }, {
                  responseType: "blob"
                });
                let m = "lead-submissions-".concat(e, "-").concat(a()().format("YYYY-MM-DD"), ".csv");
                const g = f.headers["content-disposition"];
                if (g) {
                  const e = g.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
                  e && e[1] && (m = e[1].replace(/['"]/g, ""));
                }
                const y = new Blob([f.data], {
                    type: "text/csv;charset=utf-8;"
                  }),
                  v = window.URL.createObjectURL(y),
                  b = document.createElement("a");
                b.href = v, b.download = m, document.body.appendChild(b), b.click(), window.URL.revokeObjectURL(v), document.body.removeChild(b), u({
                  type: ne
                });
              } catch (p) {
                let e = "Failed to export CSV. Please try again.";
                if (p.response && p.response.data) try {
                  if (p.response.data instanceof Blob) {
                    const t = await p.response.data.text();
                    e = JSON.parse(t).message || e;
                  } else p.response.data.message && (e = p.response.data.message);
                } catch (h) {
                  console.error("Error parsing error response:", h);
                }
                throw u((e => ({
                  type: re,
                  payload: e
                }))(e)), new Error(e);
              }
            };
          },
          et = function (e, t) {
            let n = arguments.length > 2 && void 0 !== arguments[2] && arguments[2];
            return async o => {
              try {
                const a = (await r.Z.post("".concat(i.URL, "/api/get-contact-segregated-opted"), {
                  userNumberArray: t,
                  assistantId: e
                })).data.optedoutLenght || 0;
                return o({
                  type: ce,
                  payload: n ? {
                    unSelectedOptNo: a
                  } : {
                    selectedOptNo: a
                  }
                }), a;
              } catch (a) {
                return console.error("Error fetching opted-out count:", a), o({
                  type: ce,
                  payload: n ? {
                    unSelectedOptNo: 0
                  } : {
                    selectedOptNo: 0
                  }
                }), 0;
              }
            };
          },
          tt = (e, t) => async () => {
            if (!t || !e) return null;
            try {
              var n, o;
              const a = await r.Z.get("".concat(i.ADS_REST_API_URL, "/meta/lead-forms/").concat(t), {
                params: {
                  assistantId: e
                }
              });
              if (null !== (n = a.data) && void 0 !== n && n.status && null !== (o = a.data) && void 0 !== o && o.data) return a.data.data;
            } catch (a) {
              console.error("Error fetching form for lead:", a);
            }
            return null;
          },
          nt = e => ({
            type: oe,
            payload: e
          }),
          rt = e => ({
            type: ae,
            payload: e
          }),
          ot = e => ({
            type: ie,
            payload: e
          }),
          at = () => ({
            type: se
          }),
          it = e => ({
            type: le,
            payload: e
          });
        function st() {
          let e = arguments.length > 0 && void 0 !== arguments[0] ? arguments[0] : u,
            {
              type: t,
              payload: n
            } = arguments.length > 1 ? arguments[1] : void 0;
          switch (t) {
            case p:
              return {
                ...e,
                ...n
              };
            case h:
              return {
                ...e,
                details: n.details
              };
            case g:
              return {
                ...e,
                adName: n.adName
              };
            case f:
              return {
                ...e,
                budget: n.budget
              };
            case m:
              return {
                ...e,
                gender: n.gender
              };
            case y:
              return {
                ...e,
                pageDetails: n
              };
            case v:
              return {
                ...e,
                adInsights: {
                  ...e.adInsights,
                  isLoading: !0,
                  error: null
                }
              };
            case b:
              return {
                ...e,
                adInsights: {
                  ...e.adInsights,
                  isLoading: !1,
                  iframePreview: n.iframePreview,
                  insights: n.insights,
                  error: null
                }
              };
            case A:
              return {
                ...e,
                adInsights: {
                  ...e.adInsights,
                  isLoading: !1,
                  error: n
                }
              };
            case x:
              return {
                ...e,
                syncAd: {
                  ...e.syncAd,
                  isLoading: !0,
                  error: null
                }
              };
            case C:
              return {
                ...e,
                syncAd: {
                  ...e.syncAd,
                  isLoading: !1,
                  adData: n.adData,
                  adAccount: n.adAccount,
                  error: null
                }
              };
            case E:
              return {
                ...e,
                syncAd: {
                  ...e.syncAd,
                  isLoading: !1,
                  error: n
                }
              };
            case S:
              return {
                ...e,
                updateAdStatus: {
                  ...e.updateAdStatus,
                  isLoading: !0,
                  error: null
                }
              };
            case w:
              return {
                ...e,
                updateAdStatus: {
                  ...e.updateAdStatus,
                  isLoading: !1,
                  error: null
                }
              };
            case _:
              return {
                ...e,
                updateAdStatus: {
                  ...e.updateAdStatus,
                  isLoading: !1,
                  error: n
                }
              };
            case P:
              {
                if (!e.adAccountInsights.data) return e;
                const t = {};
                return n.forEach(e => {
                  let {
                    adId: n,
                    newStatus: r
                  } = e;
                  t[n] = r;
                }), {
                  ...e,
                  adAccountInsights: {
                    ...e.adAccountInsights,
                    data: e.adAccountInsights.data.map(e => {
                      const n = t[e.adId];
                      return n ? {
                        ...e,
                        adStatus: n,
                        adEffectiveStatus: "IN_PROCESS"
                      } : e;
                    })
                  }
                };
              }
            case I:
              return {
                ...e,
                adAccountInsights: {
                  ...e.adAccountInsights,
                  isLoading: !0,
                  isLoadingAds: !0,
                  isLoadingAggregated: !0,
                  data: e.adAccountInsights.data || [],
                  headerColumns: e.adAccountInsights.headerColumns || [],
                  pagination: e.adAccountInsights.pagination || null,
                  aggregated: e.adAccountInsights.aggregated || null,
                  error: null
                }
              };
            case T:
              return {
                ...e,
                adAccountInsights: {
                  ...e.adAccountInsights,
                  isLoading: !1,
                  isLoadingAds: !1,
                  isLoadingAggregated: !1,
                  data: n.ads,
                  headerColumns: n.headerColumns,
                  pagination: n.pagination,
                  aggregated: n.aggregated,
                  error: null,
                  lastFetchParams: n.lastFetchParams
                }
              };
            case k:
              return {
                ...e,
                adAccountInsights: {
                  ...e.adAccountInsights,
                  isLoading: !1,
                  isLoadingAds: !1,
                  isLoadingAggregated: !1,
                  error: n
                }
              };
            case R:
              return {
                ...e,
                adAccountInsights: {
                  ...e.adAccountInsights,
                  isLoading: !0,
                  isLoadingAds: !0,
                  isLoadingAggregated: !0,
                  streamController: n.abortController,
                  data: e.adAccountInsights.data || [],
                  headerColumns: e.adAccountInsights.headerColumns || [],
                  pagination: e.adAccountInsights.pagination || null,
                  aggregated: e.adAccountInsights.aggregated || null,
                  error: null
                }
              };
            case D:
              return {
                ...e,
                adAccountInsights: {
                  ...e.adAccountInsights,
                  isLoadingAds: !1,
                  data: n.ads,
                  headerColumns: n.headerColumns,
                  pagination: n.pagination,
                  aggregated: null,
                  error: null,
                  lastFetchParams: n.lastFetchParams
                }
              };
            case O:
              return {
                ...e,
                adAccountInsights: {
                  ...e.adAccountInsights,
                  isLoading: !1,
                  isLoadingAggregated: !1,
                  data: n.ads,
                  headerColumns: n.headerColumns,
                  pagination: n.pagination,
                  aggregated: n.aggregated,
                  error: null,
                  lastFetchParams: n.lastFetchParams
                }
              };
            case M:
              return {
                ...e,
                adAccountInsights: {
                  ...e.adAccountInsights,
                  isLoading: !1,
                  isLoadingAds: !1,
                  isLoadingAggregated: !1,
                  error: n,
                  streamController: null
                }
              };
            case N:
              return {
                ...e,
                adAccountInsights: {
                  ...e.adAccountInsights,
                  streamController: null
                }
              };
            case F:
              return {
                ...e,
                adAccountInsights: {
                  isLoading: !1,
                  isLoadingAds: !1,
                  isLoadingAggregated: !1,
                  data: null,
                  headerColumns: [],
                  pagination: null,
                  aggregated: null,
                  error: null,
                  lastFetchParams: null,
                  streamController: null
                }
              };
            case j:
              return {
                ...e,
                exportAdInsights: {
                  ...e.exportAdInsights,
                  isLoading: !0,
                  error: null
                }
              };
            case L:
              return {
                ...e,
                exportAdInsights: {
                  ...e.exportAdInsights,
                  isLoading: !1,
                  error: null
                }
              };
            case Z:
              return {
                ...e,
                exportAdInsights: {
                  ...e.exportAdInsights,
                  isLoading: !1,
                  error: n
                }
              };
            case B:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  loading: !0,
                  error: null
                }
              };
            case U:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  loading: !1,
                  leads: n.leads || [],
                  leadsAds: n.leadsAds || e.leads.leadsAds,
                  total: n.total || 0,
                  error: null
                }
              };
            case z:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  loading: !1,
                  leads: [],
                  total: 0,
                  error: n
                }
              };
            case H:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  ctwaLoading: !0,
                  error: null
                }
              };
            case W:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  ctwaLoading: !1,
                  ctwaLeads: n.ctwaLeads || [],
                  ctwaAds: n.ctwaAds || e.leads.ctwaAds,
                  ctwaTotal: n.ctwaTotal || 0,
                  error: null
                }
              };
            case G:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  ctwaLoading: !1,
                  ctwaLeads: [],
                  ctwaTotal: 0,
                  error: n
                }
              };
            case V:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  error: null
                }
              };
            case Y:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  forms: n.forms || e.leads.forms,
                  ads: n.ads || e.leads.ads || {},
                  error: null
                }
              };
            case K:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  error: n
                }
              };
            case q:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  statsLoading: !0
                }
              };
            case Q:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  statsLoading: !1,
                  stats: n.stats || {
                    total: 0
                  }
                }
              };
            case $:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  statsLoading: !1,
                  stats: {
                    total: 0
                  },
                  ctwaTotal: 0
                }
              };
            case X:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  fetchingHistorical: !0,
                  fetchHistoricalResult: null
                }
              };
            case J:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  fetchingHistorical: !1,
                  fetchHistoricalResult: n
                }
              };
            case ee:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  fetchingHistorical: !1,
                  fetchHistoricalResult: {
                    success: !1,
                    message: n
                  }
                }
              };
            case te:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  isExporting: !0
                }
              };
            case ne:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  isExporting: !1
                }
              };
            case re:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  isExporting: !1,
                  error: n
                }
              };
            case oe:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  ...n,
                  page: 0,
                  ctwaPage: 0
                }
              };
            case ae:
            case ie:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  ...n
                }
              };
            case se:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  selected: [],
                  selectAll: !1,
                  unSelected: [],
                  selectedCount: 0
                }
              };
            case le:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  activeTab: n,
                  page: 0,
                  ctwaPage: 0,
                  selectedAdId: "",
                  selectedAdIdCTWA: ""
                }
              };
            case ce:
              return {
                ...e,
                leads: {
                  ...e.leads,
                  ...n
                }
              };
            default:
              return e;
          }
        }
      });