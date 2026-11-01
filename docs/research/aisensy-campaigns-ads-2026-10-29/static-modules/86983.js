// Inert module extracted from main.01f91df0.js; not independently executable.
((e, t, n) => {
        "use strict";

        n.d(t, {
          LW: () => A,
          OD: () => E,
          R5: () => S,
          ZP: () => P,
          k0: () => x,
          l7: () => w,
          nV: () => v,
          wY: () => C,
          wv: () => _
        });
        var r = n(70089),
          o = n(1805),
          a = n(31685);
        const i = {
            campaigns: {},
            isLoading: !1,
            error: null,
            skip: 0,
            page: 0,
            rowsPerPage: 10,
            totalCampaigns: 0,
            nameQuery: ""
          },
          s = "CAMPAIGN/LOAD_START",
          l = "CAMPAIGN/LOAD_SUCCESS",
          c = "CAMPAIGN/LOAD_MORE_SUCCESS",
          d = "CAMPAIGN/LOAD_FAILURE",
          u = "CAMPAIGN/ADD_CAMPAIGN",
          p = "CAMPAIGN/CHANGE_PAGE",
          h = "CAMPAIGNS/CHANGE_ROWS_PER_PAGE",
          f = "CAMPAIGNS/CHANGE_QUERY",
          m = "CAMPAIGNS/CHANGE_STATUS",
          g = () => ({
            type: s
          }),
          y = e => ({
            type: d,
            payload: e
          }),
          v = e => e && "CAMPAIGN_AGENT" === e.type,
          b = e => t => e || !v(t),
          A = (e, t) => Object.values(e || {}).some(e => e && !v(e) && e.name === t),
          x = function (e, t) {
            let n = arguments.length > 2 && void 0 !== arguments[2] ? arguments[2] : null,
              i = arguments.length > 3 && void 0 !== arguments[3] && arguments[3];
            return (s, c) => {
              const {
                  rowsPerPage: d,
                  nameQuery: u
                } = c().campaigns,
                p = n ? {
                  cancelToken: n.token
                } : {};
              s(g()), r.Z.post(o.CampaignURL + "/campaign/list", {
                assistantId: e,
                skip: 0,
                rowsPerPage: d,
                nameQuery: u,
                tabType: t
              }, p).then(n => {
                const {
                    campaigns: r,
                    newSkip: o,
                    totalCampaigns: c
                  } = n.data,
                  d = {};
                a.Z.trackCustomEvent("project_campaign_total_count", {
                  assistantId: e,
                  totalCampaigns: c
                }), a.Z.trackCustomEvent("total_".concat(t, "_campaigns"), {
                  assistantId: e,
                  totalCampaigns: c,
                  campaignType: t
                }), r.filter(b(i)).forEach(e => {
                  d[e._id] = e;
                }), s((e => {
                  let {
                    campaigns: t,
                    skip: n,
                    totalCampaigns: r
                  } = e;
                  return {
                    type: l,
                    payload: {
                      campaigns: t,
                      skip: n,
                      totalCampaigns: r
                    }
                  };
                })({
                  campaigns: d,
                  skip: o,
                  totalCampaigns: c
                }));
              }).catch(e => {
                console.error(e), s(y(e));
              });
            };
          },
          C = function (e, t) {
            let n = arguments.length > 2 && void 0 !== arguments[2] && arguments[2];
            return (a, i) => {
              const {
                rowsPerPage: s,
                skip: l,
                campaigns: d,
                page: u,
                nameQuery: h
              } = i().campaigns;
              Object.values(d).length > (u + 1) * s ? a({
                type: p,
                payload: u + 1
              }) : (a(g()), a({
                type: p,
                payload: u + 1
              }), r.Z.post(o.CampaignURL + "/campaign/list", {
                assistantId: e,
                skip: l,
                rowsPerPage: s,
                nameQuery: h,
                tabType: t
              }).then(e => {
                const {
                    campaigns: t,
                    newSkip: r
                  } = e.data,
                  o = {};
                t.filter(b(n)).forEach(e => {
                  o[e._id] = e;
                }), a({
                  type: c,
                  payload: {
                    campaigns: o,
                    skip: r
                  }
                });
              }).catch(e => {
                console.error(e), a(y(e));
              }));
            };
          },
          E = () => (e, t) => {
            const {
              page: n
            } = t().campaigns;
            e({
              type: p,
              payload: n - 1
            });
          },
          S = e => t => {
            t({
              type: f,
              payload: e
            });
          },
          w = e => t => {
            t({
              type: h,
              payload: e
            });
          },
          _ = (e, t) => n => {
            n({
              type: m,
              payload: {
                campaignName: e,
                status: t
              }
            });
          };
        function P() {
          let e = arguments.length > 0 && void 0 !== arguments[0] ? arguments[0] : i,
            {
              type: t,
              payload: n
            } = arguments.length > 1 ? arguments[1] : void 0;
          switch (t) {
            case s:
              return {
                ...e,
                isLoading: !0,
                error: null
              };
            case l:
              return {
                ...e,
                campaigns: {
                  ...n.campaigns
                },
                skip: n.skip,
                totalCampaigns: n.totalCampaigns,
                page: 0,
                isLoading: !1,
                error: null
              };
            case c:
              return {
                ...e,
                campaigns: {
                  ...e.campaigns,
                  ...n.campaigns
                },
                skip: n.skip,
                isLoading: !1
              };
            case h:
              return {
                ...e,
                rowsPerPage: n,
                page: 0
              };
            case p:
              return {
                ...e,
                page: n
              };
            case d:
              return {
                ...e,
                isLoading: !1,
                error: n
              };
            case u:
              return {
                ...e,
                campaigns: {
                  [n._id || n.name]: n,
                  ...e.campaigns
                }
              };
            case f:
              return {
                ...e,
                nameQuery: n
              };
            case m:
              {
                const t = Object.keys(e.campaigns).find(t => {
                  const r = e.campaigns[t];
                  return r && !v(r) && r.name === n.campaignName;
                });
                return t ? {
                  ...e,
                  campaigns: {
                    ...e.campaigns,
                    [t]: {
                      ...e.campaigns[t],
                      status: n.status
                    }
                  }
                } : e;
              }
            default:
              return e;
          }
        }
      });