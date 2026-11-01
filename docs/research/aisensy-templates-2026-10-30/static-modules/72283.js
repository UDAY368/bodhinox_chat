// Inert analyst-extracted webpack module; dependencies unresolved; not executed.
((e, t, n) => {
        "use strict";

        n.d(t, {
          I0: () => m,
          ZP: () => g,
          eJ: () => f
        });
        var r = n(70089),
          o = n(1805),
          a = n(24393);
        const i = {
            templates: {},
            allTemplates: {},
            isLoading: !1,
            error: null
          },
          s = "TEMPLATE/LOAD_START",
          l = "TEMPLATE/LOAD_SUCCESS",
          c = "TEMPLATE/LOAD_FAILURE",
          d = "TEMPLATE/ADD_TEMPLATE",
          u = "TEMPLATE/UNLOAD_TEMPLATE",
          p = "TEMPLATE/UPDATE_TEMPLATE",
          h = e => ({
            type: c,
            payload: e
          }),
          f = function (e) {
            let t = arguments.length > 1 && void 0 !== arguments[1] ? arguments[1] : null,
              n = arguments.length > 2 && void 0 !== arguments[2] ? arguments[2] : 0;
            return (i, c) => {
              i({
                type: s
              });
              const d = t ? {
                  cancelToken: t.token
                } : {},
                u = () => {
                  n < 3 && setTimeout(() => {
                    i(f(e, null, n + 1));
                  }, 1500);
                };
              r.Z.post(o.URL + "/api/templates", {
                assistantId: e
              }, {
                responseType: "stream",
                ...d
              }).then(t => {
                try {
                  let n = JSON.parse("[".concat(t.data.substring(0, t.data.length - 1), "]")),
                    r = {},
                    o = {};
                  n.filter(e => "APPROVED" === e.status).forEach(e => {
                    r[e.name] = e;
                  }), n.forEach(e => {
                    o[e.name] = e;
                  });
                  const s = {
                    project_approved_templates_count: (null === n || void 0 === n ? void 0 : n.length) || 0
                  };
                  (0, a.Vq)(s), i((e => ({
                    type: l,
                    payload: e
                  }))({
                    templates: r,
                    assistantId: e,
                    allTemplates: o
                  }));
                } catch (n) {
                  console.log("Error while updating template | API - success", n), i(h(n)), u();
                }
              }).catch(e => {
                console.error(e), i(h(e)), u();
              });
            };
          },
          m = () => e => {
            e({
              type: u,
              payload: null
            });
          };
        function g() {
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
                templates: {
                  ...n.templates
                },
                allTemplates: {
                  ...n.allTemplates
                },
                assistantId: n.assistantId,
                isLoading: !1,
                error: null
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
                templates: {
                  ...e.templates,
                  [n.name]: n
                }
              };
            case u:
              return {
                ...i
              };
            case p:
              return {
                ...e,
                templates: {
                  ...e.templates,
                  [n.name]: n
                }
              };
            default:
              return e;
          }
        }
      });
