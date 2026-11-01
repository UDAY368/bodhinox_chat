// Inert module extracted from main.01f91df0.js; not independently executable.
((e, t, n) => {
        "use strict";

        n.d(t, {
          $7: () => w,
          AO: () => m,
          Be: () => O,
          Bs: () => F,
          DG: () => D,
          Ge: () => b,
          JR: () => f,
          Jn: () => h,
          PS: () => k,
          Qq: () => c,
          RG: () => j,
          S$: () => S,
          T$: () => y,
          Tc: () => Z,
          W7: () => N,
          XX: () => _,
          Xn: () => T,
          a7: () => M,
          cU: () => P,
          dh: () => C,
          eO: () => A,
          ex: () => B,
          gK: () => L,
          iR: () => d,
          k8: () => p,
          kg: () => x,
          oJ: () => g,
          pD: () => E,
          rz: () => R,
          uy: () => I
        });
        var r = n(34882),
          o = n(73908),
          a = n(57009),
          i = n(96083),
          s = n(24764),
          l = (n(47313), n(46417));
        const c = ["CAMPAIGN_PAUSED", "ADSET_PAUSED", "PAUSED"],
          d = e => "ACTIVE" === String((null === e || void 0 === e ? void 0 : e.status) || "").toUpperCase(),
          u = function () {
            let e = arguments.length > 0 && void 0 !== arguments[0] ? arguments[0] : [];
            const t = new Map();
            return (e || []).forEach(e => {
              t.has(e.adAccountId) || t.set(e.adAccountId, {
                adAccountId: e.adAccountId,
                label: e.tierLabel || e.adAccountId,
                campaigns: [],
                blockingCount: 0
              });
              const n = t.get(e.adAccountId);
              n.campaigns.push(e), d(e) && (n.blockingCount += 1);
            }), Array.from(t.values());
          },
          p = function () {
            let {
              campaigns: e = []
            } = arguments.length > 0 && void 0 !== arguments[0] ? arguments[0] : {};
            const t = (e || []).filter(d);
            return {
              blocking: t,
              pausedCount: (e || []).length - t.length,
              totalCount: (e || []).length,
              groups: u(e)
            };
          };
        function h(e, t, n) {
          let i = arguments.length > 3 && void 0 !== arguments[3] && arguments[3];
          const {
              tag: c,
              pageId: d,
              tasks: u,
              accountId: p,
              pageName: h,
              accountName: f,
              freezed: m
            } = e || {},
            g = p ? "".concat(f, " - ").concat(p.split("_")[1]) : d ? "".concat(h, " - ").concat(d) : "NA",
            y = "".concat(d ? "Page" : "Ad Account"),
            v = {
              Limited: "".concat(y, " is not assigned"),
              Personal: "Cannnot Access Personal ".concat(y, "'s"),
              "No access": "You don't have access to this ".concat(y, " on Facebook. Reconnect Facebook with an admin or editor role on it.")
            };
          return (0, l.jsx)(r.ZP, {
            placement: "right",
            title: (0, l.jsxs)(o.Z, {
              p: 1.5,
              children: [(0, l.jsxs)(a.Z, {
                variant: "body2",
                gutterBottom: !0,
                children: [(0, l.jsx)("b", {
                  children: "".concat(d ? "Page : " : "Account : ")
                }), g]
              }), m && (0, l.jsxs)(a.Z, {
                variant: "body2",
                gutterBottom: !0,
                children: [(0, l.jsx)("b", {
                  children: "Freezed : "
                }), "Other Agents will only be able to access this ".concat(y)]
              }), "Personal" === c && i ? "" : "Assigned" !== c && (0, l.jsxs)(a.Z, {
                variant: "body2",
                gutterBottom: !0,
                children: [(0, l.jsx)("b", {
                  children: "Reason : "
                }), v[c] || ""]
              })]
            }),
            arrow: !0,
            classes: {
              arrow: n.arrow
            },
            children: (0, l.jsxs)(o.Z, {
              width: "100%",
              style: {
                display: "flex"
              },
              children: [(0, l.jsx)(o.Z, {
                width: m ? "95%" : "100%",
                children: (0, l.jsx)(a.Z, {
                  style: {
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis"
                  },
                  children: g
                })
              }), m && (0, l.jsx)(o.Z, {
                style: {
                  display: "flex",
                  justifyContent: "end"
                },
                children: (0, l.jsx)(s.Z, {
                  fontSize: "small",
                  color: "primary"
                })
              })]
            })
          });
        }
        const f = [{
            value: "feed",
            label: "Feed",
            description: "Show ads in users' main Facebook News Feed alongside organic posts",
            adFormat: "MOBILE_FEED_STANDARD"
          }, {
            value: "right_hand_column",
            label: "Right Column",
            description: "Display ads in the right sidebar on desktop Facebook",
            adFormat: "RIGHT_COLUMN_STANDARD"
          }, {
            value: "marketplace",
            label: "Marketplace",
            description: "Show ads in Facebook Marketplace where users shop and browse",
            adFormat: "MARKETPLACE_MOBILE"
          }, {
            value: "video_feeds",
            label: "Video Feeds",
            description: "Place ads in Facebook video feeds for video content discovery",
            adFormat: "WATCH_FEED_MOBILE"
          }, {
            value: "story",
            label: "Stories",
            description: "Display ads between Stories for full-screen, immersive viewing experience",
            adFormat: "FACEBOOK_STORY_MOBILE"
          }, {
            value: "search",
            label: "Search",
            description: "Show ads in Facebook search results when users search for content",
            adFormat: "INSTAGRAM_SEARCH_CHAIN"
          }, {
            value: "instream_video",
            label: "In-Stream Video",
            description: "Place ads within Facebook video content as mid-roll or pre-roll",
            adFormat: "INSTREAM_VIDEO_MOBILE"
          }, {
            value: "facebook_reels",
            label: "Reels",
            description: "Show ads in Facebook Reels feed for short-form video",
            adFormat: "FACEBOOK_REELS_MOBILE"
          }, {
            value: "facebook_reels_overlay",
            label: "Reels Overlay",
            description: "Display overlay ads on Facebook Reels videos",
            adFormat: "FACEBOOK_REELS_BANNER"
          }, {
            value: "profile_feed",
            label: "Profile Feed",
            description: "Display ads on user profile feeds for targeted visibility and reach",
            adFormat: "FACEBOOK_PROFILE_FEED_MOBILE"
          }, {
            value: "notification",
            label: "Notification",
            description: "Display ads in Facebook notifications for high visibility",
            adFormat: "MOBILE_FEED_STANDARD"
          }],
          m = [{
            value: "status",
            label: "Status",
            description: "Show your ad as a WhatsApp Status update in the Updates tab",
            adFormat: "WHATSAPP_STATUS_MEDIA"
          }],
          g = [{
            value: "stream",
            label: "Feed",
            description: "Show ads in users' main Instagram feed as they scroll through posts",
            adFormat: "INSTAGRAM_STANDARD"
          }, {
            value: "story",
            label: "Stories",
            description: "Display ads between Stories for full-screen, immersive viewing experience",
            adFormat: "INSTAGRAM_STORY"
          }, {
            value: "explore",
            label: "Explore",
            description: "Reach users browsing the Explore tab where they discover new content",
            adFormat: "INSTAGRAM_EXPLORE_CONTEXTUAL"
          }, {
            value: "explore_home",
            label: "Explore Home",
            description: "Show ads on the Explore home page to capture discovery intent",
            adFormat: "INSTAGRAM_EXPLORE_GRID_HOME"
          }, {
            value: "reels",
            label: "Reels",
            description: "Place ads in Instagram Reels feed for short-form video content",
            adFormat: "INSTAGRAM_REELS"
          }, {
            value: "profile_feed",
            label: "Profile Feed",
            description: "Display ads on user profile feeds for targeted visibility and reach",
            adFormat: "INSTAGRAM_PROFILE_FEED"
          }, {
            value: "ig_search",
            label: "Search",
            description: "Show ads in Instagram search results when users look for content",
            adFormat: "INSTAGRAM_SEARCH_GRID"
          }, {
            value: "profile_reels",
            label: "Profile Reels",
            description: "Place ads in Reels shown on user profiles",
            adFormat: "INSTAGRAM_PROFILE_REELS"
          }],
          y = [{
            value: "ctwa",
            label: "Click to WhatsApp Ad",
            type: "WHATSAPP",
            description: "Start a WhatsApp conversation from your ad",
            benefit: "Sales & qualified conversations",
            tag: "RECOMMENDED"
          }, {
            value: "whatsapp_status",
            label: "WhatsApp Status Ad",
            type: "WHATSAPP_STATUS",
            description: "Reach customers inside WhatsApp Status",
            benefit: "Reach & product discovery",
            tag: "BETA"
          }, {
            value: "website_to_whatsapp",
            label: "Website to WhatsApp Ad",
            type: "WEBSITE",
            description: "Website visits with a WhatsApp button",
            benefit: "Website visits & WhatsApp conversations",
            tag: "NEW"
          }, {
            value: "website_traffic",
            label: "Website Ad",
            type: "WEBSITE",
            description: "Send people to a product or landing page",
            benefit: "Purchases & website conversions"
          }, {
            value: "lead_form",
            label: "Lead Form Ads",
            type: "LEAD",
            description: "Capture lead details without leaving Meta",
            benefit: "Lead generation & enquiries"
          }],
          v = {
            WHATSAPP: {
              objective: "OUTCOME_ENGAGEMENT",
              goal: "CONVERSATIONS"
            },
            WHATSAPP_STATUS: {
              objective: "OUTCOME_ENGAGEMENT",
              goal: "CONVERSATIONS"
            },
            WEBSITE: {
              objective: "OUTCOME_SALES",
              goal: "OFFSITE_CONVERSIONS"
            },
            LEAD: {
              objective: "OUTCOME_LEADS",
              goal: "LEAD_GENERATION"
            }
          },
          b = e => {
            var t;
            const n = v[e];
            if (!n) return {
              objective: null,
              goal: null
            };
            const r = A.find(e => e.value === n.objective) || null;
            return {
              objective: r,
              goal: (null === r || void 0 === r || null === (t = r.optimizationGoals) || void 0 === t ? void 0 : t.find(e => e.value === n.goal)) || null
            };
          },
          A = [{
            value: "OUTCOME_TRAFFIC",
            label: "Traffic",
            description: "Drive people to a destination like a website, app, or conversation (includes LINK_CLICKS)",
            optimizationGoals: [{
              value: "LANDING_PAGE_VIEWS",
              label: "Maximise number of landing page views",
              description: "We'll try to show your ads to the people most likely to open the app or website linked in your ad.",
              conversionLocations: ["WEBSITE"],
              header: "Traffic goals"
            }, {
              value: "LINK_CLICKS",
              label: "Maximise number of link clicks",
              description: "We'll try to show your ads to the people most likely to click on them.",
              conversionLocations: ["WEBSITE", "WHATSAPP", "WHATSAPP_STATUS"],
              header: "Traffic goals"
            }, {
              value: "REACH",
              label: "Maximise daily unique reach",
              description: "We'll try to show your ads to people up to once per day.",
              conversionLocations: ["WEBSITE", "WHATSAPP", "WHATSAPP_STATUS"],
              header: "Other goals"
            }, {
              value: "CONVERSATIONS",
              label: "Maximise number of conversations",
              description: "We'll try to show your ads to most likely to have a conversation with you through messaging.",
              conversionLocations: ["WEBSITE", "WHATSAPP", "WHATSAPP_STATUS"],
              header: "Other goals"
            }, {
              value: "IMPRESSIONS",
              label: "Maximise number of impressions",
              description: "We'll try to show your ads to people as many times as possible.",
              conversionLocations: ["WEBSITE", "WHATSAPP", "WHATSAPP_STATUS"],
              header: "Other goals"
            }]
          }, {
            value: "OUTCOME_ENGAGEMENT",
            label: "Engagement",
            description: "Increase post engagement, page likes, event responses, or messages (includes POST_ENGAGEMENT, PAGE_LIKES, EVENT_RESPONSES, MESSAGES)",
            optimizationGoals: [{
              value: "OFFSITE_CONVERSIONS",
              label: "Maximise number of conversions",
              description: "We'll try to show your ads to the people most likely to take a specific action on your website.",
              conversionLocations: ["WEBSITE"],
              header: "Engagement goals"
            }, {
              value: "CONVERSATIONS",
              label: "Maximise number of conversations",
              description: "We'll try to show your ads to most likely to have a conversation with you through messaging.",
              conversionLocations: ["WHATSAPP", "WHATSAPP_STATUS"],
              header: "Engagement goals"
            }, {
              value: "LANDING_PAGE_VIEWS",
              label: "Maximise number of landing page views",
              description: "We'll try to show your ads to the people most likely to open the app or website linked in your ad.",
              conversionLocations: ["WEBSITE"],
              header: "Other goals"
            }, {
              value: "LINK_CLICKS",
              label: "Maximise number of link clicks",
              description: "We'll try to show your ads to the people most likely to click on them.",
              conversionLocations: ["WEBSITE", "WHATSAPP", "WHATSAPP_STATUS"],
              header: "Other goals"
            }, {
              value: "REACH",
              label: "Maximise daily unique reach",
              description: "We'll try to show your ads to people up to once per day.",
              conversionLocations: ["WEBSITE"],
              header: "Other goals"
            }, {
              value: "IMPRESSIONS",
              label: "Maximise number of impressions",
              description: "We'll try to show your ads to people as many times as possible.",
              conversionLocations: ["WEBSITE"],
              header: "Other goals"
            }]
          }, {
            value: "OUTCOME_SALES",
            label: "Sales",
            description: "Drive purchases, e-commerce, or other high-value conversions (includes CONVERSIONS, PRODUCT_CATALOG_SALES)",
            optimizationGoals: [{
              value: "OFFSITE_CONVERSIONS",
              label: "Maximise number of conversions",
              description: "We'll try to deliver your ads to the right people to help you get the most website conversions.",
              conversionLocations: ["WHATSAPP", "WEBSITE", "WHATSAPP_STATUS"],
              header: "Conversion goals"
            }, {
              value: "VALUE",
              label: "Maximise value of conversions",
              description: "We'll try to show your ads to the people most likely to generate higher value for your business.",
              conversionLocations: ["WEBSITE"],
              header: "Conversion goals"
            }, {
              value: "CONVERSATIONS",
              label: "Maximise number of conversations",
              description: "We'll try to show your ads to people most likely to have a conversation with you through messaging.",
              conversionLocations: ["WHATSAPP", "WHATSAPP_STATUS"],
              header: "Conversion goals"
            }, {
              value: "LANDING_PAGE_VIEWS",
              label: "Maximise number of landing page views",
              description: "We'll try to show your ads to the people most likely to open the app or website linked in your ad.",
              conversionLocations: ["WEBSITE"],
              header: "Other goals"
            }, {
              value: "LINK_CLICKS",
              label: "Maximise number of link clicks",
              description: "We'll try to show your ads to the people most likely to click on them.",
              conversionLocations: ["WEBSITE", "WHATSAPP", "WHATSAPP_STATUS"],
              header: "Other goals"
            }, {
              value: "REACH",
              label: "Maximise daily unique reach",
              description: "We'll try to show your ads to as many people as possible.",
              conversionLocations: ["WEBSITE", "WHATSAPP", "WHATSAPP_STATUS"],
              header: "Other goals"
            }, {
              value: "IMPRESSIONS",
              label: "Maximise number of impressions",
              description: "We'll try to show your ads to people as many times as possible.",
              conversionLocations: ["WEBSITE", "WHATSAPP", "WHATSAPP_STATUS"],
              header: "Other goals"
            }]
          }, {
            value: "OUTCOME_LEADS",
            label: "Leads",
            description: "Collect leads for your business using instant forms, calls, or messages",
            optimizationGoals: [{
              value: "LEAD_GENERATION",
              label: "Maximise number of leads",
              description: "We'll try to show your ads to the people most likely to share their contact information with your business.",
              conversionLocations: ["LEAD"],
              header: "Lead goals"
            }, {
              value: "QUALITY_LEAD",
              label: "Maximise number of conversion leads",
              description: "We'll try to show your ads to people most likely to become high-quality leads for your business. Requires your CRM to be connected to Meta via the Conversions API for CRM.",
              conversionLocations: ["LEAD"],
              header: "Lead goals"
            }]
          }],
          x = [{
            value: "CONTENT_VIEW",
            label: "Content View",
            supportedTypes: ["OUTCOME_ENGAGEMENT", "OUTCOME_SALES"]
          }, {
            value: "SEARCH",
            label: "Search",
            supportedTypes: ["OUTCOME_ENGAGEMENT", "OUTCOME_SALES"]
          }, {
            value: "ADD_TO_WISHLIST",
            label: "Add to Wishlist",
            supportedTypes: ["OUTCOME_ENGAGEMENT", "OUTCOME_SALES"]
          }, {
            value: "CONTACT",
            label: "Contact",
            supportedTypes: ["OUTCOME_ENGAGEMENT"]
          }, {
            value: "SCHEDULE",
            label: "Schedule",
            supportedTypes: ["OUTCOME_ENGAGEMENT"]
          }, {
            value: "CUSTOMIZE_PRODUCT",
            label: "Customize Product",
            supportedTypes: ["OUTCOME_ENGAGEMENT"]
          }, {
            value: "FIND_LOCATION",
            label: "Find Location",
            supportedTypes: ["OUTCOME_ENGAGEMENT"]
          }, {
            value: "DONATE",
            label: "Donate",
            supportedTypes: ["OUTCOME_ENGAGEMENT", "OUTCOME_SALES"]
          }, {
            value: "START_TRIAL",
            label: "Start Trial",
            supportedTypes: ["OUTCOME_ENGAGEMENT", "OUTCOME_SALES"]
          }, {
            value: "SUBMIT_APPLICATION",
            label: "Submit Application",
            supportedTypes: ["OUTCOME_ENGAGEMENT"]
          }, {
            value: "SUBSCRIBE",
            label: "Subscribe",
            supportedTypes: ["OUTCOME_ENGAGEMENT", "OUTCOME_SALES"]
          }, {
            value: "ADD_TO_CART",
            label: "Add to Cart",
            supportedTypes: ["OUTCOME_SALES"]
          }, {
            value: "INITIATED_CHECKOUT",
            label: "Initiated Checkout",
            supportedTypes: ["OUTCOME_SALES"]
          }, {
            value: "ADD_PAYMENT_INFO",
            label: "Add Payment Info",
            supportedTypes: ["OUTCOME_SALES"]
          }, {
            value: "PURCHASE",
            label: "Purchase",
            supportedTypes: ["OUTCOME_SALES"]
          }, {
            value: "COMPLETE_REGISTRATION",
            label: "Complete Registration",
            supportedTypes: ["OUTCOME_SALES"]
          }],
          C = [{
            value: "FULL_NAME",
            label: "Full Name",
            description: "User's full name",
            isPrefill: !0,
            locked: !0
          }, {
            value: "PHONE",
            label: "Phone Number",
            description: "User's phone number",
            isPrefill: !0,
            locked: !0
          }, {
            value: "FIRST_NAME",
            label: "First Name",
            description: "User's first name",
            isPrefill: !1
          }, {
            value: "LAST_NAME",
            label: "Last Name",
            description: "User's last name",
            isPrefill: !1
          }, {
            value: "EMAIL",
            label: "Email",
            description: "User's email address",
            isPrefill: !1
          }, {
            value: "STREET_ADDRESS",
            label: "Street Address",
            description: "User's street address",
            isPrefill: !1
          }, {
            value: "CITY",
            label: "City",
            description: "User's city",
            isPrefill: !1
          }, {
            value: "STATE",
            label: "State/Province",
            description: "User's state or province",
            isPrefill: !1
          }, {
            value: "ZIP",
            label: "Zip/Postal Code",
            description: "User's zip or postal code",
            isPrefill: !1
          }, {
            value: "COUNTRY",
            label: "Country",
            description: "User's country",
            isPrefill: !1
          }, {
            value: "COMPANY_NAME",
            label: "Company Name",
            description: "User's company name",
            isPrefill: !1
          }, {
            value: "JOB_TITLE",
            label: "Job Title",
            description: "User's job title",
            isPrefill: !1
          }, {
            value: "WORK_EMAIL",
            label: "Work Email",
            description: "User's work email address",
            isPrefill: !1
          }, {
            value: "WORK_PHONE_NUMBER",
            label: "Work Phone",
            description: "User's work phone number",
            isPrefill: !1
          }, {
            value: "DOB",
            label: "Date of Birth",
            description: "User's date of birth",
            isPrefill: !1
          }, {
            value: "GENDER",
            label: "Gender",
            description: "User's gender",
            isPrefill: !1
          }, {
            value: "MARITIAL_STATUS",
            label: "Marital Status",
            description: "User's marital status",
            isPrefill: !1
          }, {
            value: "RELATIONSHIP_STATUS",
            label: "Relationship Status",
            description: "User's relationship status",
            isPrefill: !1
          }, {
            value: "MILITARY_STATUS",
            label: "Military Status",
            description: "User's military status",
            isPrefill: !1
          }],
          E = [{
            id: "contact",
            label: "Contact fields",
            types: ["FULL_NAME", "PHONE", "EMAIL"]
          }, {
            id: "user",
            label: "User information",
            types: ["FIRST_NAME", "LAST_NAME"]
          }, {
            id: "demographic",
            label: "Demographic questions",
            types: ["DOB", "GENDER", "MARITIAL_STATUS", "RELATIONSHIP_STATUS", "MILITARY_STATUS"]
          }, {
            id: "work",
            label: "Work information",
            types: ["COMPANY_NAME", "JOB_TITLE", "WORK_EMAIL", "WORK_PHONE_NUMBER"]
          }, {
            id: "location",
            label: "Location",
            types: ["STREET_ADDRESS", "CITY", "STATE", "ZIP", "COUNTRY"]
          }],
          S = ([{
            value: "SHORT_ANSWER",
            label: "Short Answer",
            description: "Open text field for brief responses",
            needsLabel: !0,
            needsKey: !0,
            needsOptions: !1,
            canTriggerConditional: !1
          }, {
            value: "MULTIPLE_CHOICE",
            label: "Multiple Choice",
            description: "Dropdown or radio options for users to select",
            needsLabel: !0,
            needsKey: !0,
            needsOptions: !0,
            canTriggerConditional: !0
          }, {
            value: "CONDITIONAL",
            label: "Conditional Question",
            description: "Question that appears based on previous answer",
            needsLabel: !0,
            needsKey: !0,
            needsOptions: !1,
            requiresParent: !0
          }].map(e => ({
            ...e,
            value: "SHORT_ANSWER" === e.value || "MULTIPLE_CHOICE" === e.value || "CONDITIONAL" === e.value ? "CUSTOM" : e.value,
            isPrefill: !1
          })), [{
            value: "VIEW_WEBSITE",
            label: "View Website",
            description: "Redirect users to your website after form submission"
          }, {
            value: "CALL_BUSINESS",
            label: "Call Business",
            description: "Let users call your business directly"
          }]),
          w = [{
            value: "APPLY_NOW",
            label: "Apply Now"
          }, {
            value: "BOOK_NOW",
            label: "Book Now"
          }, {
            value: "DOWNLOAD",
            label: "Download"
          }, {
            value: "GET_QUOTE",
            label: "Get Quote"
          }, {
            value: "LEARN_MORE",
            label: "Learn More"
          }, {
            value: "SIGN_UP",
            label: "Sign Up"
          }, {
            value: "SUBSCRIBE",
            label: "Subscribe"
          }, {
            value: "GET_OFFER",
            label: "Get Offer"
          }],
          _ = [{
            label: "Impressions",
            value: 0
          }, {
            label: "Reach",
            value: 0
          }, {
            label: "Frequency",
            value: 0
          }, {
            label: "Clicks",
            value: 0
          }, {
            label: "Unique Clicks",
            value: 0
          }, {
            label: "Inline Link Clicks",
            value: 0
          }, {
            label: "CTR (%)",
            value: 0
          }, {
            label: "Spend",
            value: 0
          }],
          P = {
            INR: 250,
            USD: 5
          },
          I = {
            INR: 2500,
            USD: 25
          },
          T = e => P[e] || P.INR,
          k = e => I[e] || I.INR,
          R = (e, t, n) => {
            if (!Array.isArray(e) || 0 === e.length || !t) return;
            if (n) {
              if (Array.isArray(n)) {
                for (const r of n) {
                  const n = e.find(e => e[r] === t);
                  if (n) return n;
                }
                return;
              }
              {
                const r = e.find(e => e[n] === t);
                return "pixelId" === n ? {
                  label: null !== r && void 0 !== r && r.name ? "".concat((null === r || void 0 === r ? void 0 : r.name) || "", " (").concat((null === r || void 0 === r ? void 0 : r.pixelId) || "", ")") : t,
                  value: null !== r && void 0 !== r && r.pixelId ? null === r || void 0 === r ? void 0 : r.pixelId : t
                } : r;
              }
            }
            const r = ["id", "value", "label", "name", "_id"];
            for (const o of r) {
              const n = e.find(e => e[o] === t);
              if (n) return n;
            }
          },
          D = e => e ? "string" === typeof e ? e.split("_").map(e => e.charAt(0) + e.slice(1).toLowerCase()).join(" ") : e : "-",
          O = e => {
            const t = String(e || "").toUpperCase();
            return t.includes("ABOVE") || t.includes("HIGH") ? "#28c152" : t.includes("BELOW") || t.includes("LOW") ? "#ea0037" : "#1976d2";
          },
          M = (e, t) => {
            const n = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(e);
            if (!n) return e;
            const r = parseInt(n[1], 16),
              o = parseInt(n[2], 16),
              a = parseInt(n[3], 16);
            return "rgba(".concat(r, ", ").concat(o, ", ").concat(a, ", ").concat(t, ")");
          },
          N = e => {
            if (!e || "string" !== typeof e) return "";
            const t = e.trim();
            return t ? /^https?:\/\//i.test(t) ? t : "https://".concat(t) : "";
          },
          j = e => {
            if (!e || "string" !== typeof e) return !1;
            let t;
            try {
              t = new URL(e.trim());
            } catch (n) {
              return !1;
            }
            return "http:" === t.protocol || "https:" === t.protocol;
          },
          L = function () {
            let e = arguments.length > 0 && void 0 !== arguments[0] ? arguments[0] : {};
            const t = new Set();
            return ((null === e || void 0 === e ? void 0 : e.countries) || []).forEach(e => {
              "string" === typeof e && e && t.add(e);
            }), ["regions", "cities", "places", "zips"].forEach(n => {
              ((null === e || void 0 === e ? void 0 : e[n]) || []).forEach(e => {
                const n = (null === e || void 0 === e ? void 0 : e.country_code) || (null === e || void 0 === e ? void 0 : e.country);
                n && t.add(n);
              });
            }), Array.from(t);
          },
          Z = (e, t) => {
            if (!Array.isArray(e)) return [];
            return Array.isArray(t) && t.length > 0 && t.every(e => "US" === e) ? e : e.filter(e => "income" !== (null === e || void 0 === e ? void 0 : e.type));
          },
          F = e => {
            let {
              value: t,
              badgeColor: n
            } = e;
            if (!t) return (0, l.jsx)(a.Z, {
              variant: "h5",
              children: "-"
            });
            const r = D(t),
              o = n || O(t);
            return (0, l.jsx)(i.Z, {
              label: r,
              size: "small",
              style: {
                backgroundColor: M(o, .08),
                color: o,
                fontWeight: "bold",
                borderRadius: "12px",
                padding: "4px 8px"
              }
            });
          },
          B = e => !!e && (e.response ? [408, 502, 504].includes(e.response.status) : Boolean(e.isAxiosError || "ECONNABORTED" === e.code || /network error/i.test(e.message || "")));
      });