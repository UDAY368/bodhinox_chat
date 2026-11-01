// Inert module extracted from main.01f91df0.js; not independently executable.
((e, t, n) => {
        "use strict";

        n.d(t, {
          DW: () => f,
          EF: () => g,
          R7: () => y,
          ZP: () => v
        });
        var r = n(70089),
          o = n(1805),
          a = n(88045);
        const i = {
            isLoading: !1,
            campaignsList: {},
            error: null,
            dailyTemplateLimit: 0,
            consumedQuota: 0
          },
          s = "CampaignsList/START_FETCH",
          l = "CampaignsList/FETCH_SUCCESS",
          c = "CampaignsList/FETCH_FAILURE",
          d = "CampaignsList/RESET_ERROR",
          u = "CampaignsList/RESET_FETCH",
          p = "CampaignsList/NEW_CAMPAIGN",
          h = "CampaignsList/DAILY_TEMPLATE_QUOTA",
          f = e => t => {
            t({
              type: d
            }), t({
              type: s
            }), r.Z.post(o.URL + "/api/fetch-campaigns", {
              assistantId: e
            }).then(async n => {
              const r = (0, a.replaceDomainInData)(n.data),
                o = {};
              r.forEach(e => {
                o[e.name] = e;
              }), t({
                type: l,
                payload: o
              }), await t(m(e));
            }).catch(e => {
              console.error(e), t({
                type: c,
                payload: {
                  errmsg: "Unable to setup connection"
                }
              });
            });
          },
          m = e => t => {
            r.Z.post(o.URL + "/api/get-daily-template-quota", {
              assistantId: e
            }).then(e => {
              const {
                  data: n
                } = e,
                {
                  dailyTemplateLimit: r,
                  consumedTemplateLimitQuota: o
                } = n;
              t({
                type: h,
                payload: {
                  dailyTemplateLimit: r,
                  consumedQuota: o
                }
              });
            }).catch(e => {
              console.error(e);
            });
          },
          g = e => t => {
            t((e => ({
              type: p,
              payload: e
            }))(e));
          },
          y = () => e => {
            e({
              type: u
            });
          };
        function v() {
          let e = arguments.length > 0 && void 0 !== arguments[0] ? arguments[0] : i,
            {
              type: t,
              payload: n
            } = arguments.length > 1 ? arguments[1] : void 0;
          switch (t) {
            case s:
              return {
                ...e,
                isLoading: !0
              };
            case l:
              return {
                ...e,
                isLoading: !1,
                error: null,
                campaignsList: {
                  ...n
                }
              };
            case c:
              return {
                ...e,
                isLoading: !1,
                error: n
              };
            case d:
              return {
                ...e,
                error: null
              };
            case u:
              return {
                ...i
              };
            case p:
              return {
                ...e,
                campaignsList: {
                  ...e.campaignsList,
                  [n.name]: n
                }
              };
            case h:
              return {
                ...e,
                ...n
              };
            default:
              return e;
          }
        }
      });