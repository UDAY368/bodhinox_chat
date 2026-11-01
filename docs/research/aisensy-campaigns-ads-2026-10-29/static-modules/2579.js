// Inert module extracted from main.01f91df0.js; not independently executable.
((e, t, n) => {
        "use strict";

        n.d(t, {
          MM: () => s,
          N2: () => o,
          Ps: () => d,
          gy: () => c,
          kg: () => l
        });
        var r = n(22494);
        const o = "auto",
          a = {
            ctwa: "Click to WhatsApp",
            website_to_whatsapp: "Website to WhatsApp",
            website_traffic: "Website",
            whatsapp_status: "Status"
          },
          i = e => r.T$.find(t => t.value === e) || {},
          s = [{
            value: o,
            label: "Let AI decide",
            description: "Pick the best ad type for each ad"
          }, ...["ctwa", "website_to_whatsapp", "website_traffic", "whatsapp_status"].map(e => ({
            value: e,
            label: a[e] || i(e).label || e,
            description: i(e).description || ""
          }))],
          l = e => (s.find(t => t.value === e) || s[0]).label,
          c = e => "whatsapp_status" === e,
          d = "9:16";
      });