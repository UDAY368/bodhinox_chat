// Inert module extracted from main.01f91df0.js; not independently executable.
((e, t, n) => {
        "use strict";

        n.d(t, {
          AE: () => c,
          G8: () => h,
          LP: () => d,
          Mn: () => i,
          YX: () => s,
          hP: () => u,
          mQ: () => p,
          t4: () => l,
          tx: () => a,
          zS: () => f
        });
        var r = n(70089),
          o = n(1805);
        const a = function (e) {
            let {
              page: t = 1,
              status: n
            } = arguments.length > 1 && void 0 !== arguments[1] ? arguments[1] : {};
            return r.Z.get("".concat(o.URL, "/ad-templates"), {
              params: {
                assistantId: e,
                page: t,
                limit: 10,
                ...(n ? {
                  status: n
                } : {})
              }
            }).then(e => e.data);
          },
          i = function (e) {
            let {
              prompt: t,
              templateCount: n,
              aspectRatio: a,
              creativeFormat: i,
              durationSeconds: s,
              adType: l,
              productImages: c,
              adLayout: d,
              products: u
            } = arguments.length > 1 && void 0 !== arguments[1] ? arguments[1] : {};
            return r.Z.post("".concat(o.URL, "/ad-templates"), {
              assistantId: e,
              ...(t ? {
                prompt: t
              } : {}),
              ...("video" === i ? {
                durationSeconds: s
              } : {
                templateCount: n
              }),
              ...(a ? {
                aspectRatio: a
              } : {}),
              ...(i ? {
                creativeFormat: i
              } : {}),
              ...(l && "auto" !== l ? {
                adType: l
              } : {}),
              ...(c && c.length ? {
                productImages: c
              } : {}),
              ...(d ? {
                adLayout: d
              } : {}),
              ...(u && u.length ? {
                products: u
              } : {}),
              skipExtraTargeting: !0
            }).then(e => {
              var t;
              return null === (t = e.data) || void 0 === t ? void 0 : t.data;
            });
          },
          s = e => r.Z.get("".concat(o.URL, "/ad-templates/shopify-products"), {
            params: {
              assistantId: e,
              includeOutOfStock: !0
            }
          }).then(e => {
            var t;
            return (null === (t = e.data) || void 0 === t ? void 0 : t.data) || {};
          }),
          l = e => r.Z.get("".concat(o.URL, "/ad-templates/").concat(encodeURIComponent(e))).then(e => {
            var t;
            return null === (t = e.data) || void 0 === t ? void 0 : t.data;
          }),
          c = (e, t) => r.Z.get("".concat(o.URL, "/meta-ads/product/").concat(encodeURIComponent(t)), {
            params: {
              assistantId: e
            }
          }).then(e => {
            var t;
            return (null === (t = e.data) || void 0 === t ? void 0 : t.data) || {};
          }),
          d = (e, t, n) => r.Z.patch("".concat(o.URL, "/ad-templates/").concat(e), {
            assistantId: t,
            variants: [n]
          }).then(e => {
            var t;
            return null === (t = e.data) || void 0 === t ? void 0 : t.data;
          }),
          u = (e, t) => r.Z.post("".concat(o.URL, "/ad-templates/").concat(e, "/retry"), t && t.length ? {
            variantIndexes: t
          } : {}).then(e => {
            var t;
            return null === (t = e.data) || void 0 === t ? void 0 : t.data;
          }),
          p = e => r.Z.post("".concat(o.ADS_REST_API_URL, "/meta/ads/create"), e).then(e => e.data),
          h = e => r.Z.post("".concat(o.ADS_REST_API_URL, "/meta/accounts/fetch-ad-setup"), {
            assistantId: e
          }).then(e => e.data || {}).catch(() => ({})),
          f = (e, t) => r.Z.get("".concat(o.ADS_REST_API_URL, "/meta/lead-forms/permissions/check"), {
            params: {
              assistantId: e,
              pageId: t
            }
          }).then(e => e.data || {}).catch(() => ({}));
      });