// Inert module extracted from main.01f91df0.js; not independently executable.
((e, t, n) => {
        "use strict";

        n.d(t, {
          HK: () => D,
          IR: () => N,
          L8: () => L,
          Ug: () => O,
          W9: () => F,
          ZP: () => z,
          bY: () => k,
          ju: () => j,
          lv: () => U,
          p3: () => Z,
          sJ: () => M,
          wk: () => R
        });
        var r = n(70089),
          o = n(1805),
          a = n(51633),
          i = n(56972),
          s = n(88045);
        const l = {
            isLoading: !1,
            isReloading: !1,
            data: {},
            error: null,
            billingAddressLoading: !1,
            paymentMethodLoading: !1,
            adSetupDetails: {},
            iceBreakers: {
              iceBreakerNodeId: "",
              iceBreakers: [{
                iceBreakerText: "",
                flowId: "",
                blockId: "",
                blockHandle: "",
                iceBreakerId: "".concat(Date.now())
              }]
            },
            aiAdParams: {
              aspectRatio: "16:9",
              character: !0,
              audience: "general",
              font: "default",
              cta: "",
              productUrl: ""
            },
            isFlowPopupOpen: !1,
            popupFlowId: ""
          },
          c = "AssistantDetails/START_FETCH",
          d = "AssistantDetails/START_REFETCH",
          u = "AssistantDetails/FETCH_SUCCESS",
          p = "AssistantDetails/FETCH_FAILURE",
          h = "AssistantDetails/RESET_ERROR",
          f = "AssistantDetails/RESET_FETCH",
          m = "AssistantDetails/UPDATE_ASSISTANT_STORE",
          g = "AssistantDetails/UPDATE_AD_SETUP_STORE",
          y = "AssistantDetails/UPDATE_AUTO_WCC",
          v = "AssistantDetails/UPDATE_AD_CREDIT",
          b = "AssistantDetails/SYNC_BILLING_ADDDRESS_START",
          A = "AssistantDetails/SYNC_BILLING_ADDDRESS_SUCCESS",
          x = "AssistantDetails/SYNC_BILLING_ADDDRESS_FAIL",
          C = "AssistantDetails/SYNC_PAYMENT_METHOD_START",
          E = "AssistantDetails/SYNC_PAYMENT_METHOD_SUCCESS",
          S = "AssistantDetails/SYNC_PAYMENT_METHOD_FAIL",
          w = "AssistantDetails/UPDATE_ICEBREAKERS",
          _ = "AssistantDetails/UPDATE_FLOW_POPUP_STATUS",
          P = "AssistantDetails/UPDATE_POPUP_FLOW_ID",
          I = "AssistantDetails/UPDATE_AI_AD_PARAMS",
          T = e => ({
            type: u,
            payload: e
          }),
          k = e => t => {
            t({
              type: y,
              payload: e
            });
          },
          R = e => t => {
            t({
              type: w,
              payload: e
            });
          },
          D = e => t => {
            t({
              type: _,
              payload: e
            });
          },
          O = e => t => {
            t({
              type: P,
              payload: e
            });
          },
          M = e => t => {
            t((e => ({
              type: m,
              payload: e
            }))(e));
          },
          N = e => t => {
            t((e => ({
              type: g,
              payload: e
            }))(e));
          },
          j = e => t => {
            t({
              type: v,
              payload: e
            });
          },
          L = e => t => {
            t({
              type: b
            }), r.Z.post(o.URL + "/payment/sync-billing-address", {
              assistantId: e
            }).then(e => {
              var n;
              t((n = e.data, {
                type: A,
                payload: n
              }));
            }).catch(e => {
              console.error(e), t({
                type: x
              });
            });
          },
          Z = e => t => {
            t({
              type: C
            }), r.Z.post(o.URL + "/payment/sync-payment-method", {
              assistantId: e
            }).then(e => {
              var n;
              t((n = e.data, {
                type: E,
                payload: n
              }));
            }).catch(e => {
              console.error(e), t({
                type: S
              });
            });
          },
          F = (e, t, n) => (l, u) => {
            l({
              type: h
            }), t ? n || l({
              type: d
            }) : l({
              type: c
            }), r.Z.post(o.URL + "/api/get-wba-details", {
              assistantId: e
            }).then(e => {
              const {
                  assistantId: t,
                  isWhatsappVerified: n,
                  website: r,
                  appName: c,
                  bvbpProcess: d,
                  kycRemark: p,
                  whatsappNumber: h,
                  providerType: f,
                  subscriptionId: m,
                  billingAddress: g,
                  type: y,
                  activePlan: v,
                  planActivatedOn: b,
                  macUsage: A,
                  currency: x,
                  templateCredit: C,
                  metaAdsCredit: E,
                  planDisplayName: S,
                  planType: w,
                  frequency: _,
                  totalContact: P,
                  cardAdded: I,
                  macQuota: k,
                  subscriptionStatus: R,
                  status: D,
                  appliedForWaba: O,
                  ongoingBillingProcess: M,
                  subscriptionScheduled: N,
                  promotionalCredits: j,
                  planRenewalOn: L,
                  subscriptionStartedWith: Z,
                  cbpType: F,
                  fbManagerVerified: U,
                  displayNameVerified: z,
                  whatsAppDisplayName: H,
                  whatsAppDisplayImage: W,
                  whatsAppAbout: G,
                  whatsAppBusinessProfile: V,
                  timezone: Y,
                  dailyTemplateLimit: K,
                  profileSetupDone: q,
                  appliedForGreenTick: Q,
                  qualityRating: $,
                  testNumber: X,
                  testName: J,
                  sessionPeriod: ee,
                  d360ChannelId: te,
                  allowPurchase: ne,
                  partnerId: re,
                  autoResolve: oe,
                  tagLimit: ae,
                  attributeLimit: ie,
                  assistantName: se,
                  trialNumber: le,
                  testCountryCode: ce,
                  chargebeePlan: de,
                  wabaAppId: ue,
                  wabaNumberId: pe,
                  displayNameRejectionReason: he,
                  campaignReportingAllowed: fe,
                  wabaProgressStep: me,
                  updatedAt: ge,
                  campaignAnalyticsEnabled: ye,
                  campaignSchedulingEnabled: ve,
                  clickTrackingEnabled: be,
                  fbUserId: Ae,
                  fbGrantedScopes: xe,
                  fbConnected: Ce,
                  selectedMetaPageId: Ee,
                  selectedMetaAdAccountId: Se,
                  freeTierCoversationCount: we,
                  wabaActivatedOn: _e,
                  planDuration: Pe,
                  optSetting: Ie,
                  webEngageWebhookUrl: Te,
                  webEngageKey: ke,
                  WEB_KEY: Re,
                  cleverTapOptField: De,
                  moEngageOptField: Oe,
                  webEngageOptField: Me,
                  CleverTapkey: Ne,
                  deliveryCallbackURL: je,
                  inboundMessageURL: Le,
                  moEngageWebhookUrl: Ze,
                  MO_KEY: Fe,
                  filterFreezeEnabled: Be,
                  autoWccRecharge: Ue,
                  metaAdvanceTargetingEnabled: ze,
                  partner: He,
                  ecomAppStore: We,
                  chatSearchEnabled: Ge,
                  disableEcomm: Ve,
                  selectedMetaBusinessId: Ye,
                  selectedMetaCatalogueId: Ke,
                  selectedMetaBusinessAccessToken: qe,
                  selectedMetaUserId: Qe,
                  customerId: $e,
                  planFamily: Xe,
                  dfProjectId: Je,
                  placeOfSupply: et,
                  clientId: tt,
                  ongoingPlanBillingProcess: nt,
                  freezedMetaAdAccountId: rt,
                  freezedMetaPageId: ot,
                  fbConnectedBy: at,
                  flowConfiguration: it,
                  referralShortLink: st,
                  subscriptionScheduledItems: lt,
                  planManagement: ct,
                  portalAddress: dt,
                  metaAdsDetails: ut,
                  orderCheckoutDetails: pt,
                  addons: ht,
                  razorpayLink: ft,
                  subsrazorpayLink: mt,
                  subspaymentLinkId: gt,
                  numberBuyStep: yt,
                  additionalSubscriptionItems: vt,
                  csvScheduleEnabled: bt,
                  isCatalogueVisibleOnBusiness: At,
                  temporarySubs: xt,
                  aggCreditRecharged: Ct,
                  aggCreditUsage: Et,
                  wccRewardExists: St,
                  wabaAppStatus: wt,
                  isOrderFlowEnabled: _t,
                  optReportingEnabled: Pt,
                  specialAccess: It,
                  partnerReferralId: Tt,
                  aisensyWrap: kt,
                  skipBalanceCheck: Rt,
                  createdAt: Dt,
                  shopifyAnalytics: Ot,
                  wabaDeleted: Mt,
                  templateTier: Nt,
                  gstInfo: jt,
                  adSetupDetails: Lt,
                  enableReadStatus: Zt,
                  swipeAccessCode: Ft,
                  flowsProFeatureEnabled: Bt,
                  prospectId: Ut,
                  virtualNumberConfig: zt,
                  subscriptionTrialClaimed: Ht,
                  subscriptionState: Wt,
                  previousProjectBilling: Gt,
                  isVirtualNumberKycIncomplete: Vt,
                  country: Yt,
                  iceBreakers: Kt,
                  aiTemplateCount: qt,
                  isContactAutoSyncEnabled: Qt,
                  attributes: $t,
                  aiAdCreativeCount: Xt,
                  showTypingIndicator: Jt,
                  mmLiteConfig: en,
                  embeddedSignupUrl: tn,
                  aiFlowGenerationCount: nn,
                  maxAgents: rn,
                  billableAgents: on,
                  affiliateId: an,
                  firstPaidPlanName: sn,
                  firstPaidPlanStartedOn: ln,
                  aiFlowGenerationCost: cn,
                  affiliateEmail: dn,
                  affiliatePhone: un,
                  affiliateName: pn,
                  renewalChanges: hn,
                  mediaContentSize: fn,
                  aiCredit: mn
                } = e.data,
                gn = {
                  featureGating: e.data.featureGating,
                  website: r,
                  assistantId: t,
                  bvbpProcess: d,
                  kycRemark: p,
                  isWhatsappVerified: n,
                  appName: c,
                  whatsappNumber: h,
                  providerType: f,
                  subscriptionId: m,
                  billingAddress: g,
                  type: y,
                  activePlan: v,
                  planActivatedOn: b,
                  macUsage: A,
                  currency: x,
                  templateCredit: C,
                  planDisplayName: S,
                  dfProjectId: Je,
                  planType: w,
                  frequency: _,
                  totalContact: P,
                  cardAdded: I,
                  macQuota: "v4" === y ? 1 / 0 : k,
                  subscriptionStatus: R,
                  status: D,
                  appliedForWaba: O,
                  ongoingBillingProcess: M,
                  subscriptionScheduled: N,
                  promotionalCredits: j,
                  planRenewalOn: L,
                  subscriptionStartedWith: Z,
                  cbpType: F,
                  fbManagerVerified: U,
                  displayNameVerified: z,
                  whatsAppDisplayName: H,
                  whatsAppDisplayImage: (0, s.replaceDomainInData)(W),
                  whatsAppAbout: G,
                  whatsAppBusinessProfile: V,
                  timezone: Y,
                  dailyTemplateLimit: K,
                  profileSetupDone: q,
                  appliedForGreenTick: Q,
                  qualityRating: $,
                  testNumber: X,
                  testName: J,
                  sessionPeriod: ee,
                  d360ChannelId: te,
                  allowPurchase: ne,
                  partnerId: re,
                  autoResolve: oe,
                  tagLimit: ae,
                  attributeLimit: ie,
                  assistantName: se,
                  trialNumber: le,
                  testCountryCode: ce,
                  chargebeePlan: de,
                  wabaAppId: ue,
                  wabaNumberId: pe,
                  displayNameRejectionReason: he,
                  campaignReportingAllowed: fe,
                  wabaProgressStep: me,
                  updatedAt: ge,
                  campaignAnalyticsEnabled: ye,
                  campaignSchedulingEnabled: ve,
                  clickTrackingEnabled: be,
                  fbUserId: Ae,
                  fbGrantedScopes: xe,
                  fbConnected: Ce,
                  selectedMetaPageId: Ee,
                  selectedMetaAdAccountId: Se,
                  freeTierCoversationCount: we,
                  wabaActivatedOn: _e,
                  planDuration: Pe,
                  optSetting: Ie,
                  webEngageWebhookUrl: Te,
                  webEngageKey: ke,
                  WEB_KEY: Re,
                  cleverTapOptField: De,
                  moEngageOptField: Oe,
                  webEngageOptField: Me,
                  CleverTapkey: Ne,
                  deliveryCallbackURL: je,
                  inboundMessageURL: Le,
                  MO_KEY: Fe,
                  moEngageWebhookUrl: Ze,
                  filterFreezeEnabled: Be,
                  autoWccRecharge: Ue,
                  metaAdvanceTargetingEnabled: ze,
                  partner: He,
                  ecomAppStore: We,
                  chatSearchEnabled: Ge,
                  disableEcomm: Ve,
                  selectedMetaBusinessId: Ye,
                  selectedMetaCatalogueId: Ke,
                  selectedMetaBusinessAccessToken: qe,
                  selectedMetaUserId: Qe,
                  customerId: $e,
                  planFamily: Xe,
                  placeOfSupply: et,
                  clientId: tt,
                  ongoingPlanBillingProcess: nt,
                  freezedMetaAdAccountId: rt,
                  freezedMetaPageId: ot,
                  fbConnectedBy: at,
                  flowConfiguration: it,
                  referralShortLink: st,
                  subscriptionScheduledItems: lt,
                  planManagement: ct,
                  portalAddress: dt,
                  metaAdsDetails: ut,
                  orderCheckoutDetails: pt,
                  addons: ht,
                  razorpayLink: ft,
                  subsrazorpayLink: mt,
                  subspaymentLinkId: gt,
                  numberBuyStep: yt,
                  additionalSubscriptionItems: vt,
                  csvScheduleEnabled: bt,
                  isCatalogueVisibleOnBusiness: At,
                  temporarySubs: xt,
                  aggCreditRecharged: Ct,
                  aggCreditUsage: Et,
                  wccRewardExists: St,
                  wabaAppStatus: wt,
                  isOrderFlowEnabled: _t,
                  optReportingEnabled: Pt,
                  specialAccess: It,
                  partnerReferralId: Tt,
                  aisensyWrap: kt,
                  skipBalanceCheck: Rt,
                  createdAt: Dt,
                  shopifyAnalytics: Ot,
                  wabaDeleted: Mt,
                  metaAdsCredit: E,
                  templateTier: Nt,
                  gstInfo: jt,
                  adSetupDetails: Lt,
                  enableReadStatus: Zt,
                  swipeAccessCode: Ft,
                  flowsProFeatureEnabled: Bt,
                  prospectId: Ut,
                  virtualNumberConfig: zt,
                  subscriptionTrialClaimed: Ht,
                  subscriptionState: Wt,
                  previousProjectBilling: Gt,
                  isVirtualNumberKycIncomplete: Vt,
                  country: Yt,
                  iceBreakers: Kt,
                  isContactAutoSyncEnabled: Qt,
                  attributes: $t,
                  aiTemplateCount: qt,
                  aiAdCreativeCount: Xt,
                  showTypingIndicator: Jt,
                  mmLiteConfig: en,
                  embeddedSignupUrl: tn,
                  aiFlowGenerationCount: nn,
                  maxAgents: rn,
                  billableAgents: on,
                  affiliateId: an,
                  firstPaidPlanName: sn,
                  firstPaidPlanStartedOn: ln,
                  aiFlowGenerationCost: cn,
                  affiliateEmail: dn,
                  affiliatePhone: un,
                  affiliateName: pn,
                  renewalChanges: hn,
                  mediaContentSize: fn,
                  aiCredit: mn
                };
              if (l(T(gn)), (0, i.N)(u().login.user, gn), l((0, a.$3)(t, !0)), !re) {
                const e = "paymentDetailsLastCall_".concat(t),
                  n = localStorage.getItem(e),
                  r = new Date().getTime(),
                  o = 36e5;
                (!n || r - parseInt(n) > o) && (localStorage.setItem(e, r.toString()), l(B(t, gn)));
              }
              if (localStorage.getItem("redirectionRoute")) {
                const e = localStorage.getItem("redirectionRoute");
                localStorage.removeItem("redirectionRoute"), window.location = o.baseURL + "/projects/".concat(t) + e;
              }
            }).catch(e => {
              var t;
              if (console.error(e), "JWT RESETTED!" === (null === (t = e.response) || void 0 === t ? void 0 : t.data)) {
                localStorage.removeItem("session"), localStorage.removeItem("vendor_data");
                const e = window.location.origin;
                window.location = e + "/login", r.Z.post(o.URL + "/auth/logout-partner").then(e => {
                  console.log(e.data);
                }).catch(e => {
                  console.log(e);
                });
              }
              l({
                type: p,
                payload: {
                  errmsg: "Unable to setup connection"
                }
              });
            });
          },
          B = (e, t) => n => {
            r.Z.post(o.URL + "/api/get-payment-details", {
              assistantId: e
            }).then(e => {
              const {
                pendingInvoices: r,
                subscription: o
              } = e.data;
              n(T({
                ...t,
                pendingInvoices: r,
                subscription: o
              }));
            }).catch(e => {
              console.error(e);
            });
          },
          U = () => e => {
            e({
              type: f
            });
          };
        function z() {
          var e, t;
          let n = arguments.length > 0 && void 0 !== arguments[0] ? arguments[0] : l,
            {
              type: r,
              payload: o
            } = arguments.length > 1 ? arguments[1] : void 0;
          switch (r) {
            case c:
              return {
                ...n,
                isLoading: !0
              };
            case d:
              return {
                ...n,
                isReloading: !0
              };
            case u:
              return {
                ...n,
                isLoading: !1,
                isReloading: !1,
                error: null,
                data: {
                  ...o,
                  pendingInvoices: (null === o || void 0 === o ? void 0 : o.pendingInvoices) || (null === n || void 0 === n || null === (e = n.data) || void 0 === e ? void 0 : e.pendingInvoices) || [],
                  subscription: (null === o || void 0 === o ? void 0 : o.subscription) || (null === n || void 0 === n || null === (t = n.data) || void 0 === t ? void 0 : t.subscription) || []
                }
              };
            case y:
            case m:
              return {
                ...n,
                data: {
                  ...n.data,
                  ...o
                }
              };
            case g:
              return {
                ...n,
                adSetupDetails: {
                  ...n.adSetupDetails,
                  ...o
                }
              };
            case p:
              return {
                ...n,
                isLoading: !1,
                isReloading: !1,
                error: o
              };
            case h:
              return {
                ...n,
                error: null
              };
            case f:
              return {
                ...l
              };
            case b:
              return {
                ...n,
                billingAddressLoading: !0
              };
            case A:
              return {
                ...n,
                billingAddressLoading: !1,
                data: {
                  ...n.data,
                  ...o
                }
              };
            case x:
              return {
                ...n,
                billingAddressLoading: !1
              };
            case C:
              return {
                ...n,
                paymentMethodLoading: !0
              };
            case E:
              return {
                ...n,
                paymentMethodLoading: !1,
                data: {
                  ...n.data,
                  ...o
                }
              };
            case S:
              return {
                ...n,
                paymentMethodLoading: !1
              };
            case w:
              return {
                ...n,
                iceBreakers: {
                  ...o
                }
              };
            case _:
              return {
                ...n,
                isFlowPopupOpen: o
              };
            case P:
              return {
                ...n,
                popupFlowId: o
              };
            case I:
              return {
                ...n,
                aiAdParams: {
                  ...n.aiAdParams,
                  ...o
                }
              };
            case v:
              return {
                ...n,
                data: {
                  ...n.data,
                  metaAdsCredit: o
                }
              };
            default:
              return n;
          }
        }
      });