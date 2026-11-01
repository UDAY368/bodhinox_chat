// Inert module extracted from main.01f91df0.js; not independently executable.
((e, t, n) => {
        "use strict";

        n.d(t, {
          $i: () => Se,
          Ah: () => be,
          D4: () => me,
          Dy: () => he,
          H5: () => Ce,
          I$: () => ae,
          L$: () => pe,
          LW: () => oe,
          MO: () => xe,
          OH: () => le,
          S5: () => se,
          Ud: () => ce,
          V3: () => ge,
          Vm: () => ue,
          ZP: () => _e,
          el: () => ie,
          fw: () => ye,
          h_: () => fe,
          hf: () => de,
          sv: () => Ee,
          tb: () => Ae,
          yx: () => ve
        });
        var r = n(70089),
          o = n(1805);
        const a = "FETCH_AUDIENCES_REQUEST",
          i = "FETCH_AUDIENCES_SUCCESS",
          s = "FETCH_AUDIENCES_FAILURE",
          l = "IMPORT_AUDIENCE_USERS_REQUEST",
          c = "IMPORT_AUDIENCE_USERS_SUCCESS",
          d = "IMPORT_AUDIENCE_USERS_FAILURE",
          u = "CREATE_AUDIENCE_REQUEST",
          p = "CREATE_AUDIENCE_SUCCESS",
          h = "CREATE_AUDIENCE_FAILURE",
          f = "CREATE_CUSTOM_AUDIENCE_REQUEST",
          m = "CREATE_CUSTOM_AUDIENCE_SUCCESS",
          g = "CREATE_CUSTOM_AUDIENCE_FAILURE",
          y = "CREATE_LOOKALIKE_AUDIENCE_REQUEST",
          v = "CREATE_LOOKALIKE_AUDIENCE_SUCCESS",
          b = "CREATE_LOOKALIKE_AUDIENCE_FAILURE",
          A = "CREATE_CUSTOM_WITH_LOOKALIKE_REQUEST",
          x = "CREATE_CUSTOM_WITH_LOOKALIKE_SUCCESS",
          C = "CREATE_CUSTOM_WITH_LOOKALIKE_FAILURE",
          E = "UPLOAD_AUDIENCE_CSV_REQUEST",
          S = "UPLOAD_AUDIENCE_CSV_SUCCESS",
          w = "UPLOAD_AUDIENCE_CSV_FAILURE",
          _ = "DELETE_AUDIENCE_REQUEST",
          P = "DELETE_AUDIENCE_SUCCESS",
          I = "DELETE_AUDIENCE_FAILURE",
          T = "SYNC_AUDIENCES_REQUEST",
          k = "SYNC_AUDIENCES_SUCCESS",
          R = "SYNC_AUDIENCES_FAILURE",
          D = "FETCH_PIXELS_REQUEST",
          O = "FETCH_PIXELS_SUCCESS",
          M = "FETCH_PIXELS_FAILURE",
          N = "FETCH_PIXEL_DETAILS_REQUEST",
          j = "FETCH_PIXEL_DETAILS_SUCCESS",
          L = "FETCH_PIXEL_DETAILS_FAILURE",
          Z = "SET_PIXEL_EVENTS",
          F = "SET_PIXEL_EVENTS_CUSTOM_FIELDS",
          B = "FETCH_PIXEL_STATS_REQUEST",
          U = "FETCH_PIXEL_STATS_SUCCESS",
          z = "FETCH_PIXEL_STATS_FAILURE",
          H = "SYNC_PIXELS_REQUEST",
          W = "SYNC_PIXELS_SUCCESS",
          G = "SYNC_PIXELS_FAILURE",
          V = "CREATE_PIXEL_REQUEST",
          Y = "CREATE_PIXEL_SUCCESS",
          K = "CREATE_PIXEL_FAILURE",
          q = "SET_SEARCH_STRING",
          Q = "SET_CURRENT_TYPE",
          $ = "SET_CURRENT_PAGE",
          X = "SET_CURRENT_SOURCE",
          J = "CLEAR_ERROR",
          ee = "CLEAR_AUDIENCES",
          te = "GET_CONVERSATION_COUNT_REQUEST",
          ne = "GET_CONVERSATION_COUNT_SUCCESS",
          re = "GET_CONVERSATION_COUNT_FAILURE",
          oe = e => {
            let {
              assistantId: t,
              allFilters: n
            } = e;
            return async e => {
              e({
                type: te
              });
              try {
                const a = await r.Z.post("".concat(o.URL, "/meta-ads/audiences/convoCount"), {
                  assistantId: t,
                  allFilters: n
                });
                return e({
                  type: ne,
                  payload: a.data
                }), a.data;
              } catch (s) {
                var a, i;
                const t = (null === (a = s.response) || void 0 === a || null === (i = a.data) || void 0 === i ? void 0 : i.message) || s.message || "Failed to get conversation count";
                throw e({
                  type: re,
                  payload: t
                }), s;
              }
            };
          },
          ae = e => async t => {
            t({
              type: a
            });
            try {
              const {
                  assistantId: n,
                  page: a = 1,
                  searchTerm: s = "",
                  status: l = "",
                  type: c = "ALL",
                  limit: d = 10,
                  source: u = "aisensy",
                  adAccountId: p
                } = e,
                h = {
                  assistantId: n,
                  status: l,
                  limit: d,
                  page: a || 1,
                  type: c,
                  source: u,
                  ...(s && {
                    search: s
                  }),
                  ...(p && {
                    adAccountId: p
                  })
                },
                f = await r.Z.get("".concat(o.ADS_REST_API_URL, "/meta/audiences/custom"), {
                  params: h
                });
              t({
                type: i,
                payload: f.data
              });
            } catch (c) {
              var n, l;
              const e = (null === (n = c.response) || void 0 === n || null === (l = n.data) || void 0 === l ? void 0 : l.message) || c.message || "Failed to fetch audiences";
              t({
                type: s,
                payload: e
              });
            }
          },
          ie = e => async t => {
            t({
              type: f
            });
            try {
              const {
                assistantId: n,
                name: a,
                description: i,
                subtype: s,
                rule: l,
                fileUrl: c,
                headers: d,
                dbQuery: u,
                unSelected: p,
                skipUpload: h
              } = e;
              if (!n) throw new Error("assistantId is required");
              if (!a) throw new Error("name is required");
              if (!s) throw new Error("subtype is required");
              if ("WEBSITE" === s && !(Object.keys(l || {}).length > 0)) throw new Error("rule is required when subtype is WEBSITE");
              if ("CUSTOMER_LIST" === s && !h && !c && !u) throw new Error("fileUrl or dbQuery is required when subtype is CUSTOMER_LIST");
              const f = {
                  assistantId: n,
                  name: a,
                  ...(i ? {
                    description: i
                  } : {}),
                  subtype: s,
                  ...(l ? {
                    rule: l
                  } : {}),
                  ...(c ? {
                    fileUrl: c
                  } : {}),
                  ...(d ? {
                    headers: d
                  } : {}),
                  ...(u ? {
                    allFilters: u,
                    unSelected: p
                  } : {}),
                  ...(h ? {
                    skipUpload: !0
                  } : {})
                },
                g = await r.Z.post("".concat(o.ADS_REST_API_URL, "/meta/audiences/custom/create-async"), f);
              return t({
                type: m,
                payload: g.data
              }), e.assistantId && e.accountId && t(be({
                assistantId: e.assistantId,
                adAccountId: e.accountId
              })).catch(() => {}), g.data;
            } catch (n) {
              let e = "Failed to create custom audience";
              if (n.response) {
                const t = n.response.status,
                  r = n.response.data;
                e = 400 === t ? (null === r || void 0 === r ? void 0 : r.message) || (null === r || void 0 === r ? void 0 : r.error) || "Validation error: Please check your input" : 409 === t ? (null === r || void 0 === r ? void 0 : r.message) || (null === r || void 0 === r ? void 0 : r.error) || "An audience with this name already exists" : 500 === t ? (null === r || void 0 === r ? void 0 : r.message) || (null === r || void 0 === r ? void 0 : r.error) || "Server error: Please try again later" : (null === r || void 0 === r ? void 0 : r.message) || (null === r || void 0 === r ? void 0 : r.error) || n.message || "Failed to create custom audience";
              } else n.message && (e = n.message);
              throw t({
                type: g,
                payload: e
              }), new Error(e);
            }
          },
          se = e => async t => {
            t({
              type: y
            });
            try {
              const {
                  assistantId: n,
                  name: a,
                  description: i,
                  origin_audience_id: s,
                  lookalike_spec: l
                } = e,
                c = {
                  assistantId: n,
                  name: a,
                  description: i,
                  type: "LOOKALIKE",
                  origin_audience_id: s,
                  lookalike_spec: l
                },
                d = await r.Z.post("".concat(o.ADS_REST_API_URL, "/meta/audiences/lookalike"), c);
              return t({
                type: v,
                payload: d.data
              }), d.data;
            } catch (i) {
              var n, a;
              const e = (null === (n = i.response) || void 0 === n || null === (a = n.data) || void 0 === a ? void 0 : a.message) || i.message || "Failed to create lookalike audience";
              throw t({
                type: b,
                payload: e
              }), i;
            }
          },
          le = e => async t => {
            t({
              type: A
            });
            try {
              const {
                assistantId: n,
                accountId: a,
                name: i,
                description: s,
                subtype: l,
                rule: c,
                fileUrl: d,
                headers: u,
                dbQuery: p,
                unSelected: h,
                skipUpload: f,
                lookalike_spec: m
              } = e;
              if (!n) throw new Error("assistantId is required");
              if (!i) throw new Error("name is required");
              if (!l) throw new Error("subtype is required");
              if (null === m || void 0 === m || !m.ratio) throw new Error("lookalike_spec.ratio is required");
              if ("CUSTOMER_LIST" === l && !f && !d && !p) throw new Error("fileUrl or dbQuery is required when subtype is CUSTOMER_LIST");
              const g = {
                  assistantId: n,
                  name: i,
                  ...(s ? {
                    description: s
                  } : {}),
                  subtype: l,
                  ...(c ? {
                    rule: c
                  } : {}),
                  ...(d ? {
                    fileUrl: d
                  } : {}),
                  ...(u ? {
                    headers: u
                  } : {}),
                  ...(p ? {
                    allFilters: p,
                    unSelected: h
                  } : {}),
                  ...(f ? {
                    skipUpload: !0
                  } : {}),
                  lookalike_spec: m
                },
                y = await r.Z.post("".concat(o.ADS_REST_API_URL, "/meta/audiences/custom/create-with-lookalike"), g);
              return t({
                type: x,
                payload: y.data
              }), n && a && t(be({
                assistantId: n,
                adAccountId: a
              })).catch(() => {}), y.data;
            } catch (n) {
              let e = "Failed to create audience with lookalike";
              if (n.response) {
                const r = n.response.status,
                  o = n.response.data;
                if (207 === r) return t({
                  type: x,
                  payload: o
                }), o;
                e = 409 === r ? (null === o || void 0 === o ? void 0 : o.errorMessage) || (null === o || void 0 === o ? void 0 : o.message) || "An audience with this name already exists" : (null === o || void 0 === o ? void 0 : o.errorMessage) || (null === o || void 0 === o ? void 0 : o.message) || e;
              } else n.message && (e = n.message);
              throw t({
                type: C,
                payload: e
              }), new Error(e);
            }
          },
          ce = e => async t => {
            t({
              type: _
            });
            try {
              const {
                  audienceId: n,
                  assistantId: a
                } = e,
                i = await r.Z.put("".concat(o.URL, "/meta-ads/audiences/custom/").concat(n), {
                  assistantId: a
                });
              t({
                type: P,
                payload: {
                  audienceId: n,
                  response: i.data
                }
              });
            } catch (i) {
              var n, a;
              const e = (null === (n = i.response) || void 0 === n || null === (a = n.data) || void 0 === a ? void 0 : a.message) || i.message || "Failed to delete audience";
              t({
                type: I,
                payload: e
              });
            }
          },
          de = e => {
            let {
              assistantId: t,
              fileName: n,
              csvText: a
            } = e;
            return async e => {
              e({
                type: E
              });
              try {
                const i = await r.Z.post("".concat(o.URL, "/api/get-upload-url"), {
                    assistantId: t,
                    fileName: n,
                    contentType: "text/csv",
                    fileType: "CONTACT"
                  }),
                  {
                    url: s,
                    fields: l
                  } = i.data.uploadURL,
                  c = new FormData();
                Object.entries(l).forEach(e => {
                  let [t, n] = e;
                  return c.append(t, n);
                }), c.append("file", new Blob([a], {
                  type: "text/csv"
                }), n || "audience.csv"), await r.Z.post(s, c, {
                  withCredentials: !1,
                  transformRequest: (e, t) => (delete t.Authorization, delete t["x-tenant-id"], delete t["x-ais-fp-id"], e)
                });
                const d = "https://".concat(l.bucket, ".s3.ap-south-1.amazonaws.com/").concat(l.Key);
                return e({
                  type: S,
                  payload: {
                    uploadedCsvUrl: d
                  }
                }), d;
              } catch (l) {
                var i, s;
                const t = (null === (i = l.response) || void 0 === i || null === (s = i.data) || void 0 === s ? void 0 : s.message) || l.message || "CSV upload failed";
                throw e({
                  type: w,
                  payload: t
                }), l;
              }
            };
          },
          ue = e => async () => {
            try {
              const {
                assistantId: t,
                audienceId: n,
                metaAudienceId: a,
                campaignContext: i = {}
              } = e;
              return (await r.Z.post("".concat(o.CampaignURL, "/campaign/meta-audience-upload"), {
                assistantId: t,
                audienceId: n,
                metaAudienceId: a,
                ...i
              })).data;
            } catch (s) {
              var t, n, a, i;
              const e = (null === (t = s.response) || void 0 === t || null === (n = t.data) || void 0 === n ? void 0 : n.errorMessage) || (null === (a = s.response) || void 0 === a || null === (i = a.data) || void 0 === i ? void 0 : i.message) || s.message || "Failed to upload campaign audience to Meta";
              throw new Error(e);
            }
          },
          pe = e => async t => {
            try {
              const {
                assistantId: t,
                audienceId: n,
                headers: a,
                fileUrl: i,
                dbQuery: s,
                userNumbers: l,
                unSelected: c
              } = e;
              return (await r.Z.post("".concat(o.ADS_REST_API_URL, "/meta/audiences/custom/upload"), {
                assistantId: t,
                audienceId: n,
                headers: a,
                ...(i ? {
                  fileUrl: i
                } : {}),
                ...(s ? {
                  allFilters: s,
                  unSelected: c
                } : {}),
                ...(null !== l && void 0 !== l && l.length ? {
                  userNumbers: l
                } : {})
              })).data;
            } catch (i) {
              var n, a;
              const e = (null === (n = i.response) || void 0 === n || null === (a = n.data) || void 0 === a ? void 0 : a.message) || i.message || "Failed to upload contacts";
              throw new Error(e);
            }
          },
          he = e => ({
            type: q,
            payload: e
          }),
          fe = e => ({
            type: Q,
            payload: e
          }),
          me = e => ({
            type: $,
            payload: e
          }),
          ge = e => ({
            type: X,
            payload: e
          }),
          ye = () => ({
            type: J
          }),
          ve = () => ({
            type: ee
          }),
          be = e => {
            let {
              assistantId: t,
              adAccountId: n
            } = e;
            return async e => {
              e({
                type: T
              });
              try {
                const a = await r.Z.post("".concat(o.ADS_REST_API_URL, "/meta/audiences/custom/sync"), {
                  assistantId: t,
                  adAccountId: n
                });
                return e({
                  type: k,
                  payload: a.data
                }), a.data;
              } catch (s) {
                var a, i;
                const t = (null === (a = s.response) || void 0 === a || null === (i = a.data) || void 0 === i ? void 0 : i.message) || s.message || "Failed to sync audiences";
                throw e({
                  type: R,
                  payload: t
                }), s;
              }
            };
          },
          Ae = e => {
            let {
              assistantId: t,
              page: n = 1,
              limit: a = 20,
              search: i = ""
            } = e;
            return async e => {
              e({
                type: D
              });
              try {
                const s = {
                  page: n,
                  limit: a,
                  assistantId: t
                };
                i && i.trim() && (s.search = i.trim());
                const l = await r.Z.get("".concat(o.ADS_REST_API_URL, "/meta/pixels/get"), {
                  params: s
                });
                return e({
                  type: O,
                  payload: l.data
                }), l.data;
              } catch (c) {
                var s, l;
                const t = (null === (s = c.response) || void 0 === s || null === (l = s.data) || void 0 === l ? void 0 : l.message) || c.message || "Failed to fetch pixels";
                throw e({
                  type: M,
                  payload: t
                }), c;
              }
            };
          },
          xe = e => {
            let {
              assistantId: t,
              pixelId: n,
              event: a
            } = e;
            return async e => {
              e({
                type: N
              }), console.log("API calling");
              try {
                var i, s;
                const l = await r.Z.get("".concat(o.ADS_REST_API_URL, "/meta/pixels/details"), {
                  params: {
                    pixelId: n,
                    assistantId: t,
                    event: a
                  }
                });
                if (e({
                  type: j,
                  payload: l.data
                }), null !== (i = l.data) && void 0 !== i && i.aggregatedStats) {
                  const t = [];
                  l.data.aggregatedStats.forEach(e => {
                    e.data && Array.isArray(e.data) && e.data.forEach(e => {
                      e.value && (t.find(t => t.id === e.value) || t.push({
                        id: e.value,
                        label: "invitee_event_type_page" === e.value ? "CompleteRegistration" : e.value
                      }));
                    });
                  }), !a && t.length > 0 && e({
                    type: Z,
                    payload: {
                      pixelId: n,
                      events: t
                    }
                  });
                }
                if (null !== (s = l.data) && void 0 !== s && s.customDataFields) {
                  const t = {};
                  Object.keys(l.data.customDataFields).forEach(e => {
                    const n = l.data.customDataFields[e];
                    if (Array.isArray(n) && n.length > 0) {
                      const r = [];
                      n.forEach(e => {
                        e.value && (r.find(t => t.id === e.value) || r.push({
                          id: e.value,
                          label: e.value
                        }));
                      }), r.length > 0 && (t[e] = r);
                    }
                  }), Object.keys(t).length > 0 && e({
                    type: F,
                    payload: {
                      pixelId: n,
                      customFields: t
                    }
                  });
                }
                return l.data;
              } catch (d) {
                var l, c;
                const t = (null === (l = d.response) || void 0 === l || null === (c = l.data) || void 0 === c ? void 0 : c.message) || d.message || "Failed to fetch pixel details";
                throw e({
                  type: L,
                  payload: t
                }), d;
              }
            };
          },
          Ce = e => {
            let {
              assistantId: t,
              pixelId: n,
              start_time: a,
              end_time: i
            } = e;
            return async e => {
              e({
                type: B
              });
              try {
                const s = {
                    assistantId: t,
                    pixelId: n,
                    ...(a && {
                      start_time: a
                    }),
                    ...(i && {
                      end_time: i
                    })
                  },
                  l = await r.Z.get("".concat(o.ADS_REST_API_URL, "/meta/pixels/stats"), {
                    params: s
                  });
                return e({
                  type: U,
                  payload: l.data
                }), l.data;
              } catch (c) {
                var s, l;
                const t = (null === (s = c.response) || void 0 === s || null === (l = s.data) || void 0 === l ? void 0 : l.message) || c.message || "Failed to fetch pixel stats";
                throw e({
                  type: z,
                  payload: t
                }), c;
              }
            };
          },
          Ee = e => {
            let {
              assistantId: t
            } = e;
            return async e => {
              e({
                type: H
              });
              try {
                const n = await r.Z.post("".concat(o.ADS_REST_API_URL, "/meta/pixels/sync"), {
                  assistantId: t
                });
                return e({
                  type: W,
                  payload: n.data
                }), n.data;
              } catch (i) {
                var n, a;
                const t = (null === (n = i.response) || void 0 === n || null === (a = n.data) || void 0 === a ? void 0 : a.message) || i.message || "Failed to sync pixels";
                throw e({
                  type: G,
                  payload: t
                }), i;
              }
            };
          },
          Se = e => {
            let {
              assistantId: t,
              pixelName: n,
              pixelDescription: a
            } = e;
            return async e => {
              e({
                type: V
              });
              try {
                const i = await r.Z.post("".concat(o.ADS_REST_API_URL, "/meta/pixels/create"), {
                  assistantId: t,
                  pixelName: n.trim(),
                  pixelDescription: a.trim() || ""
                });
                return e({
                  type: Y,
                  payload: i.data
                }), i.data;
              } catch (l) {
                var i, s;
                const t = (null === (i = l.response) || void 0 === i || null === (s = i.data) || void 0 === s ? void 0 : s.message) || l.message || "Failed to create pixel";
                throw e({
                  type: K,
                  payload: t
                }), l;
              }
            };
          },
          we = {
            audiences: [],
            loading: !1,
            error: null,
            totalPages: 1,
            totalAudiences: 0,
            totalReach: 0,
            activeCampaigns: 0,
            currentPage: 0,
            searchString: "",
            currentType: "ALL",
            currentSource: "aisensy",
            createLoading: !1,
            createError: null,
            deleteLoading: !1,
            deleteError: null,
            syncLoading: !1,
            syncError: null,
            uploadLoading: !1,
            uploadError: null,
            importLoading: !1,
            importError: null,
            conversationCount: null,
            conversationCountLoading: !1,
            conversationCountError: null,
            pixels: [],
            pixelsLoading: !1,
            pixelsError: null,
            pixelsPagination: {
              currentPage: 1,
              totalPages: 1,
              totalItems: 0,
              itemsPerPage: 20,
              hasNextPage: !1,
              hasPreviousPage: !1
            },
            pixelDetails: null,
            pixelDetailsLoading: !1,
            pixelDetailsError: null,
            pixelEvents: {},
            pixelEventsCustomFields: {},
            pixelStats: [],
            pixelStatsSummary: null,
            pixelStatsLoading: !1,
            pixelStatsError: null,
            syncPixelsLoading: !1,
            syncPixelsError: null,
            createPixelLoading: !1,
            createPixelError: null,
            createCustomAudienceLoading: !1,
            createCustomAudienceError: null
          },
          _e = function () {
            var e, t, n, r;
            let o = arguments.length > 0 && void 0 !== arguments[0] ? arguments[0] : we,
              oe = arguments.length > 1 ? arguments[1] : void 0;
            switch (oe.type) {
              case l:
                return {
                  ...o,
                  importLoading: !0,
                  importError: null
                };
              case c:
                return {
                  ...o,
                  importLoading: !1
                };
              case d:
                return {
                  ...o,
                  importLoading: !1,
                  importError: oe.payload
                };
              case te:
                return {
                  ...o,
                  conversationCountLoading: !0,
                  conversationCountError: null
                };
              case ne:
                return {
                  ...o,
                  conversationCountLoading: !1,
                  conversationCount: oe.payload.data
                };
              case re:
                return {
                  ...o,
                  conversationCountLoading: !1,
                  conversationCountError: oe.payload
                };
              case a:
                return {
                  ...o,
                  loading: !0,
                  error: null
                };
              case i:
                const {
                    data: ae,
                    pagination: ie,
                    totalPages: se,
                    totalCount: le,
                    totalReach: ce,
                    activeCampaigns: de
                  } = oe.payload,
                  ue = ie || {},
                  pe = ue.totalPages || se || 1,
                  he = ue.totalItems || le || 0,
                  fe = ue.currentPage || o.currentPage + 1,
                  me = Math.max(0, fe - 1);
                return {
                  ...o,
                  loading: !1,
                  audiences: ae || [],
                  totalPages: pe,
                  totalAudiences: he,
                  totalReach: ce || 0,
                  activeCampaigns: de || 0,
                  currentPage: me
                };
              case s:
                return {
                  ...o,
                  loading: !1,
                  error: oe.payload,
                  audiences: []
                };
              case u:
                return {
                  ...o,
                  createLoading: !0,
                  createError: null
                };
              case p:
                return {
                  ...o,
                  createLoading: !1
                };
              case h:
                return {
                  ...o,
                  createLoading: !1,
                  createError: oe.payload
                };
              case f:
                return {
                  ...o,
                  createCustomAudienceLoading: !0,
                  createCustomAudienceError: null
                };
              case m:
                return {
                  ...o,
                  createCustomAudienceLoading: !1,
                  createCustomAudienceError: null
                };
              case g:
                return {
                  ...o,
                  createCustomAudienceLoading: !1,
                  createCustomAudienceError: oe.payload
                };
              case y:
                return {
                  ...o,
                  createLoading: !0,
                  createError: null
                };
              case v:
                return {
                  ...o,
                  createLoading: !1
                };
              case b:
                return {
                  ...o,
                  createLoading: !1,
                  createError: oe.payload
                };
              case A:
                return {
                  ...o,
                  createCustomAudienceLoading: !0,
                  createCustomAudienceError: null
                };
              case x:
                return {
                  ...o,
                  createCustomAudienceLoading: !1,
                  createCustomAudienceError: null
                };
              case C:
                return {
                  ...o,
                  createCustomAudienceLoading: !1,
                  createCustomAudienceError: oe.payload
                };
              case _:
                return {
                  ...o,
                  deleteLoading: !0,
                  deleteError: null
                };
              case P:
                return {
                  ...o,
                  deleteLoading: !1,
                  audiences: o.audiences.filter(e => e._id !== oe.payload.audienceId),
                  totalAudiences: Math.max(0, o.totalAudiences - 1)
                };
              case I:
                return {
                  ...o,
                  deleteLoading: !1,
                  deleteError: oe.payload
                };
              case T:
                return {
                  ...o,
                  syncLoading: !0,
                  syncError: null
                };
              case k:
                return {
                  ...o,
                  syncLoading: !1,
                  syncError: null
                };
              case R:
                return {
                  ...o,
                  syncLoading: !1,
                  syncError: oe.payload
                };
              case q:
                return {
                  ...o,
                  searchString: oe.payload
                };
              case Q:
                return {
                  ...o,
                  currentType: oe.payload
                };
              case $:
                return {
                  ...o,
                  currentPage: oe.payload
                };
              case X:
                return {
                  ...o,
                  currentSource: oe.payload
                };
              case J:
                return {
                  ...o,
                  error: null,
                  createError: null,
                  deleteError: null,
                  uploadError: null
                };
              case ee:
                return {
                  ...o,
                  audiences: [],
                  totalPages: 1,
                  totalAudiences: 0,
                  totalReach: 0,
                  activeCampaigns: 0,
                  currentPage: 0
                };
              case D:
                return {
                  ...o,
                  pixelsLoading: !0,
                  pixelsError: null
                };
              case O:
                return {
                  ...o,
                  pixelsLoading: !1,
                  pixelsError: null,
                  pixels: (null === (e = oe.payload) || void 0 === e ? void 0 : e.data) || [],
                  pixelsPagination: (null === (t = oe.payload) || void 0 === t ? void 0 : t.pagination) || o.pixelsPagination
                };
              case M:
                return {
                  ...o,
                  pixelsLoading: !1,
                  pixelsError: oe.payload
                };
              case N:
                return {
                  ...o,
                  pixelDetailsLoading: !0,
                  pixelDetailsError: null
                };
              case j:
                return {
                  ...o,
                  pixelDetailsLoading: !1,
                  pixelDetailsError: null,
                  pixelDetails: oe.payload
                };
              case L:
                return {
                  ...o,
                  pixelDetailsLoading: !1,
                  pixelDetailsError: oe.payload
                };
              case Z:
                return {
                  ...o,
                  pixelEvents: {
                    ...o.pixelEvents,
                    [oe.payload.pixelId]: oe.payload.events
                  }
                };
              case "CLEAR_PIXEL_EVENTS":
                return {
                  ...o,
                  pixelEvents: {}
                };
              case F:
                return {
                  ...o,
                  pixelEventsCustomFields: {
                    ...o.pixelEventsCustomFields,
                    ...oe.payload.customFields
                  }
                };
              case B:
                return {
                  ...o,
                  pixelStatsLoading: !0,
                  pixelStatsError: null
                };
              case U:
                return {
                  ...o,
                  pixelStatsLoading: !1,
                  pixelStatsError: null,
                  pixelStats: (null === (n = oe.payload) || void 0 === n ? void 0 : n.data) || [],
                  pixelStatsSummary: (null === (r = oe.payload) || void 0 === r ? void 0 : r.summary) || null
                };
              case z:
                return {
                  ...o,
                  pixelStatsLoading: !1,
                  pixelStatsError: oe.payload
                };
              case H:
                return {
                  ...o,
                  syncPixelsLoading: !0,
                  syncPixelsError: null
                };
              case W:
                return {
                  ...o,
                  syncPixelsLoading: !1,
                  syncPixelsError: null
                };
              case G:
                return {
                  ...o,
                  syncPixelsLoading: !1,
                  syncPixelsError: oe.payload
                };
              case V:
                return {
                  ...o,
                  createPixelLoading: !0,
                  createPixelError: null
                };
              case Y:
                return {
                  ...o,
                  createPixelLoading: !1,
                  createPixelError: null
                };
              case K:
                return {
                  ...o,
                  createPixelLoading: !1,
                  createPixelError: oe.payload
                };
              case E:
                return {
                  ...o,
                  uploadLoading: !0,
                  uploadError: null
                };
              case S:
                return {
                  ...o,
                  uploadLoading: !1
                };
              case w:
                return {
                  ...o,
                  uploadLoading: !1,
                  uploadError: oe.payload
                };
              default:
                return o;
            }
          };
      });