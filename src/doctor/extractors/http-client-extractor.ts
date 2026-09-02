import type { HttpClientFact, HttpClientMethod, HttpClientLib, ConfidenceLabel } from '../types.js';

interface PatternDef {
  regex: RegExp;
  method: HttpClientMethod;
  lib: HttpClientLib;
  confidence: ConfidenceLabel;
  urlGroup: number;
}

// Node/JS patterns
const NODE_PATTERNS: PatternDef[] = [
  // axios.get(url), axios.post(url, data)
  { regex: /\baxios\.(get|post|put|patch|delete)\(\s*([`'"](.*?)[`'"]|\w[\w.]*)/g, method: 'unknown', lib: 'axios', confidence: 'high', urlGroup: 2 },
  // axios({ method: 'post', url: '...' })
  { regex: /\baxios\(\s*\{[^}]*\burl:\s*['"`]([^'"`]+)['"`]/g, method: 'unknown', lib: 'axios', confidence: 'medium', urlGroup: 1 },
  // fetch(url)
  { regex: /\bfetch\(\s*['"`]([^'"`]+)['"`]/g, method: 'GET', lib: 'fetch', confidence: 'high', urlGroup: 1 },
  // got.get(url), got.post(url)
  { regex: /\bgot\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g, method: 'unknown', lib: 'got', confidence: 'high', urlGroup: 2 },
  // NestJS HttpService: this.httpService.get/post(url)
  { regex: /\bhttpService\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g, method: 'unknown', lib: 'axios', confidence: 'high', urlGroup: 2 },
];

// PHP curl patterns — multi-line aware via two-pass approach per line
const PHP_CURL_INLINE = /\bcurl_init\(\s*['"]([^'"]+)['"]\s*\)/g;
const PHP_CURL_SETOPT_URL = /\bcurl_setopt\s*\(\s*\$\w+\s*,\s*CURLOPT_URL\s*,\s*['"]([^'"]+)['"]/g;

// PHP NodeAPI bridge pattern — NodeAPI::methodName() calls map to ims-tf2 endpoints
const PHP_NODE_API = /\bNodeAPI::(\w+)\s*\(/g;
const NODE_API_ENDPOINT_MAP: Record<string, { method: HttpClientMethod; path: string }> = {
  getJwtServer:      { method: 'POST', path: '/traders/api/v2/jwt-server/' },
  getToken:          { method: 'POST', path: '/traders/api/v1/login/' },
  validateIdToken:   { method: 'POST', path: '/traders/api/v1/login/social/' },
  loginWithMT4:      { method: 'POST', path: '/traders/api/v1/login-with-mt4/' },
};

// PHP config class constants — MMBConfig::CONST, MrgConfig::CONST, TradersConfig::CONST used in curl
const PHP_CONFIG_CONST = /\b(MMBConfig|MrgConfig|TradersConfig|ChannelsConfig|FAConfig)::([A-Z_]+)/g;

// Known endpoint constants from askapconfig.php, mrgconfig.php, tradersconfig.php, channelsconfig.php
const CONFIG_CONST_MAP: Record<string, string> = {
  // MMBConfig (askapconfig.php)
  'MMBConfig::GET_AFF_LIST':               '/askap/api/v2/affiliate/list/',
  'MMBConfig::GET_AFF_UNDER_LOT':          '/askap/api/v2/affiliate/under/lot/',
  'MMBConfig::GET_AFF_NMI_UNDER':          '/askap/api/v2/user/affliate/nmi/under/',
  'MMBConfig::API_MMB_ACCOUNT':            '/askap/api/v2/account/',
  'MMBConfig::API_MMB_ACCOUNT_ISIGNAL':    '/askap/api/v1/isignal/account/',
  'MMBConfig::API_MMB_TYPE_ACCOUNT_ISIGNAL': '/askap/api/v1/account/types/isignal/',
  // MrgConfig (mrgconfig.php)
  'MrgConfig::GET_ACCOUNT_TYPE':           '/mrg/api/v2/account/types/',
  'MrgConfig::GET_ACCOUNT_TYPE_DEMO':      '/mrg/api/v2/account/types/demo/',
  'MrgConfig::GET_ACCOUNT':                '/mrg/api/v2/account/',
  'MrgConfig::GET_ACCOUNT_DEMO':           '/mrg/api/v2/account/demo/',
  'MrgConfig::ACCOUNT_REQUEST':            '/mrg/api/v2/account/request/',
  'MrgConfig::ACCOUNT_REQUEST_DEMO':       '/mrg/api/v2/account/demo/request/',
  'MrgConfig::ACCOUNT_REQUEST_DEMO_1':     '/mrg/api/v1/account/demo/request/',
  'MrgConfig::WITHDRAWAL_V2':              '/mrg/api/v2/withdraw/',
  'MrgConfig::DEPOSIT_V3':                 '/mrg/api/v3/deposit/',
  'MrgConfig::ACCOUNT_INFO':               '/mrg/api/v2/account/info/',
  'MrgConfig::OPEN_TRADE':                 '/mrg/api/v2/acccount/opentrades/',
  'MrgConfig::CLOSE_TRADE':               '/mrg/api/v2/account/closedtrades/',
  'MrgConfig::MARGIN_IN_OUT':              '/mrg/api/v2/account/info/margininout/',
  'MrgConfig::TRANSACTION_HISTORY':        '/mrg/api/v2/user/transactions/lates/',
  'MrgConfig::GET_AFF_LIST':              '/mrg/api/v2/affiliate/list/',
  'MrgConfig::USER_LOT':                  '/mrg/api/v2/account/userlot/',
  'MrgConfig::GET_AFF_UNDER_LOT':         '/mrg/api/v2/affiliate/under/lot/',
  'MrgConfig::GET_AFF_NMI_UNDER':         '/mrg/api/v2/user/affliate/nmi/under/',
  'MrgConfig::DELETE_DEMO_ACC':           '/mrg/api/v1/account/demo/delete/',
  // TradersConfig (tradersconfig.php)
  'TradersConfig::API_VERIFY':            '/traders/api/v1/verify/',
  'TradersConfig::API_VERIFY_RESEND':     '/traders/api/v1/verify/resend/',
  'TradersConfig::API_USER_1':            '/traders/api/v1/user/',
  'TradersConfig::API_USER':              '/traders/api/v2/user/',
  'TradersConfig::API_USER_3':            '/traders/api/v3/user/',
  'TradersConfig::API_USERS':             '/traders/api/v2/users/',
  'TradersConfig::API_REGISTER':          '/traders/api/v2/user/register/',
  'TradersConfig::API_REGISTER_3':        '/traders/api/v3/user/register/',
  'TradersConfig::API_FORGOT_PASSWORD':   '/traders/api/v1/user/forgot/',
  'TradersConfig::API_CHECK_USERNAME':    '/traders/api/v2/users/checkusername/',
  'TradersConfig::API_CHECK_USERNAME_V2': '/traders/api/v2/users/checkusername/availability/',
  'TradersConfig::API_RECOMMEND_USERNAME':'/traders/api/v2/users/recommendusername/',
  'TradersConfig::API_USER_ROLE_SELECT':  '/traders/api/v1/user/role/select/',
  'TradersConfig::API_USER_EDIT_DOMICILE':'/traders/api/v1/user/edit/domicile/',
  'TradersConfig::API_USER_IDENTITY':     '/traders/api/v1/user/identity/',
  'TradersConfig::API_CEK_PASSWORD':      '/traders/api/v2/users/check/password/',
  // ChannelsConfig (channelsconfig.php)
  'ChannelsConfig::API_ADD_CART':                              '/ois/api/v1/cart/',
  'ChannelsConfig::API_ADD_LIST_ADDITION_AUTOCOSIG':           '/ois/api/v1/copy/auto/setting/additional/',
  'ChannelsConfig::API_ASKAP':                                 '/askap/api/v1/',
  'ChannelsConfig::API_ASKAP_CHECK_SYMBOL':                    '/askap/api/v2/account/symbol/',
  'ChannelsConfig::API_ASKAP_V2':                              '/askap/api/v2/',
  'ChannelsConfig::API_AUTOCOPY_CREATE_LIST':                  '/ois/api/v2/copy/auto/setting/create/',
  'ChannelsConfig::API_AUTOCOPY_EDIT_LIST':                    '/ois/api/v2/copy/auto/edit/',
  'ChannelsConfig::API_AUTOCOPY_LIST':                         '/ois/api/v2/copy/auto/list/',
  'ChannelsConfig::API_AUTOCOSIG_GET_PRICE':                   '/ois/api/v1/subscribe/payment/price/',
  'ChannelsConfig::API_BANK_LIST':                             '/ois/api/v1/banks/',
  'ChannelsConfig::API_CANCEL_COPY_SIGNAL':                    '/ois/api/v1/signal/copy/cancel/',
  'ChannelsConfig::API_CHANNEL':                               '/ois/api/v1/channel/',
  'ChannelsConfig::API_CHANNEL_2':                             '/ois/api/v2/channel/',
  'ChannelsConfig::API_CHANNEL_3':                             '/ois/api/v3/channel/',
  'ChannelsConfig::API_CHANNEL_4':                             '/ois/api/v4/channel/',
  'ChannelsConfig::API_CHANNEL_5':                             '/ois/api/v5/channel/',
  'ChannelsConfig::API_CHANNEL_ACTIVE_POINT':                  '/ois/api/v1/my/active-point/',
  'ChannelsConfig::API_CHANNEL_ACTIVE_POINT_DETAILS':          '/ois/api/v1/my/active-point-details/',
  'ChannelsConfig::API_CHANNEL_ACTIVE_POINT_DETAILS_NEW':      '/ois/api/v3/my/active-point-details/',
  'ChannelsConfig::API_CHANNEL_CHART':                         '/ois/api/v1/channel/chart/',
  'ChannelsConfig::API_CHANNEL_CHART_2':                       '/ois/api/v2/channel/chart/',
  'ChannelsConfig::API_CHANNEL_COPY_AUTO_STATUS_LIST':         '/ois/api/v1/copy/auto/status/list/',
  'ChannelsConfig::API_CHANNEL_CREATE':                        '/ois/api/v2/channel/create/',
  'ChannelsConfig::API_CHANNEL_DETAIL':                        '/ois/api/v1/channel/detail/',
  'ChannelsConfig::API_CHANNEL_DETAIL_2':                      '/ois/api/v2/channel/detail/',
  'ChannelsConfig::API_CHANNEL_FEATURED':                      '/ois/api/v1/channel/featured/',
  'ChannelsConfig::API_CHANNEL_GET_SYMBOL_2':                  '/ois/api/v2/symbols/',
  'ChannelsConfig::API_CHANNEL_HISTORY_POINT':                 '/ois/api/v2/my/point-history/',
  'ChannelsConfig::API_CHANNEL_HISTORY_POINT_NEW':             '/ois/api/v3/my/point-history/',
  'ChannelsConfig::API_CHANNEL_HISTORY_POINT_NEW_V4':          '/ois/api/v4/my/point-history/',
  'ChannelsConfig::API_CHANNEL_HISTORY_POINT_NEW_V5':          '/ois/api/v5/my/point-history/',
  'ChannelsConfig::API_CHANNEL_MANUAL':                        '/ois/api/v1/channel/recommend/manual/',
  'ChannelsConfig::API_CHANNEL_MOST_CONSISTENT':               '/ois/api/v1/channel/consistent/',
  'ChannelsConfig::API_CHANNEL_MOST_CONSISTENT_V2':            '/ois/api/v2/channel/consistent/',
  'ChannelsConfig::API_CHANNEL_MOST_POPULAR':                  '/ois/api/v1/channel/popular/',
  'ChannelsConfig::API_CHANNEL_MOST_PROFIT':                   '/ois/api/v1/channel/profit/',
  'ChannelsConfig::API_CHANNEL_MOST_PROFIT_LAST_MONTH':        '/ois/api/v1/channel/profit/lastmonth/',
  'ChannelsConfig::API_CHANNEL_MUTE':                          '/ois/api/v1/channel/mute/',
  'ChannelsConfig::API_CHANNEL_MY_CUSTOM_SYMBOLS':             '/ois/api/v2/channel/detail/',
  'ChannelsConfig::API_CHANNEL_MY_SUBSCRIPTIONS_ID':           '/ois/api/v1/my/subscriptions/[id]/details/',
  'ChannelsConfig::API_CHANNEL_MY_SUBSCRIPTIONS_NEW':          '/ois/api/v3/my/subscriptions/',
  'ChannelsConfig::API_CHANNEL_MY_SUBSCRIPTIONS_OWN':          '/ois/api/v1/copy/auto/list/own/',
  'ChannelsConfig::API_CHANNEL_PAYMENT_SUMMARY_SIMULATOR_ALL': '/ois/api/v1/subscribe/payment/confirm/bulk/',
  'ChannelsConfig::API_CHANNEL_POINT_CONFIG':                  '/ois/api/v1/channel/point/config/',
  'ChannelsConfig::API_CHANNEL_POINT_REDEEM':                  '/ois/api/v1/channel/exchange/point/',
  'ChannelsConfig::API_CHANNEL_POINT_REDEEM_HISTORY':          '/ois/api/v1/channel/history/point/redeem/',
  'ChannelsConfig::API_CHANNEL_REQUEST_WD':                    '/ois/api/v1/channel/withdraw/',
  'ChannelsConfig::API_CHANNEL_SEARCH':                        '/ois/api/v1/channel/search/',
  'ChannelsConfig::API_CHANNEL_SEARCH_3':                      '/ois/api/v3/channel/search/',
  'ChannelsConfig::API_CHANNEL_SIGNAL_FEED':                   '/ois/api/v2/channel/signal/feed/',
  'ChannelsConfig::API_CHANNEL_STATISTIC':                     '/ois/api/v1/channel/stat/',
  'ChannelsConfig::API_CHANNEL_SUBSCRIBER':                    '/ois/api/v2/my/subscribers/bychannel/',
  'ChannelsConfig::API_CHANNEL_SUMMARY':                       '/ois/api/v1/channel/summary/',
  'ChannelsConfig::API_CHANNEL_SUMMARY_2':                     '/ois/api/v2/channel/summary/',
  'ChannelsConfig::API_CHANNEL_SUMMARY_3':                     '/ois/api/v3/channel/summary/',
  'ChannelsConfig::API_CHANNEL_SUMMARY_4':                     '/ois/api/v4/channel/summary/',
  'ChannelsConfig::API_CHANNEL_SUMMARY_SIMULATOR':             '/ois/api/v1/signal/summarySimmulator/',
  'ChannelsConfig::API_CHANNEL_UPDATE':                        '/ois/api/v1/channel/update/',
  'ChannelsConfig::API_CHANNEL_UPDATE_NEW':                    '/ois/api/v2/channel/update/',
  'ChannelsConfig::API_CHANNEL_UPLOAD_AVATAR':                 '/ois/api/v1/channel/upload/avatar/',
  'ChannelsConfig::API_CHANNEL_VP_ESTIMATION':                 '/ois/api/signal/vp/estimation/',
  'ChannelsConfig::API_CHECK_LOT':                             '/ois/api/v1/auto/check/spec/',
  'ChannelsConfig::API_CHECK_SIGNAL_COPIED_CHECK':             '/ois/api/v1/signal/copied/check/',
  'ChannelsConfig::API_CHECK_SUBSCRIBE':                       '/ois/api/v1/subscribe/check/',
  'ChannelsConfig::API_COPIED_SIGNAL':                         '/ois/api/v2/signal/copied/',
  'ChannelsConfig::API_COPIED_SIGNAL_CHECK':                   '/ois/api/v1/signal/copied/',
  'ChannelsConfig::API_COPY_LIST':                             '/ois/api/v2/copy/auto/',
  'ChannelsConfig::API_COPY_LIST_ALL':                         '/ois/api/v1/copy/auto/',
  'ChannelsConfig::API_COPY_SIGNAL':                           '/ois/api/v2/signal/copy/',
  'ChannelsConfig::API_CREATE_CHANNEL':                        '/ois/api/v1/channel/create/',
  'ChannelsConfig::API_CREATE_PROTECTION':                     '/ois/api/v1/signal/create/protection/',
  'ChannelsConfig::API_DELETE_CART':                           '/ois/api/v1/cart/',
  'ChannelsConfig::API_EXPOSURE':                              '/ois/api/v2/signal/exposure/',
  'ChannelsConfig::API_GET_CART':                              '/ois/api/v1/cart/',
  'ChannelsConfig::API_GET_LOT':                               '/ois/api/v1/auto/get/spec/',
  'ChannelsConfig::API_GET_SIGNAL':                            '/ois/api/v1/signal/detail/',
  'ChannelsConfig::API_LIST_BYSIGNAL':                         '/ois/api/v1/copy/list/bysignal/',
  'ChannelsConfig::API_LOGIN':                                 '/login/',
  'ChannelsConfig::API_MMB':                                   '/askap/api/v1/',
  'ChannelsConfig::API_MMB_ACCOUNT':                           '/askap/api/v2/account/',
  'ChannelsConfig::API_MMB_ACCOUNT_V3':                        '/askap/api/v3/account/',
  'ChannelsConfig::API_MMB_ACC_TYPE':                          '/askap/api/v1/account/types/',
  'ChannelsConfig::API_MMB_CHECK_LIST':                        '/askap/api/v1/account/',
  'ChannelsConfig::API_MMB_CHECK_PASSWORD':                    '/askap/api/v2/account/password/check/',
  'ChannelsConfig::API_MMB_INFO':                              '/askap/api/v2/account/info/',
  'ChannelsConfig::API_MMB_V2':                                '/askap/api/v2/',
  'ChannelsConfig::API_MMB_V3':                                '/askap/api/v3/',
  'ChannelsConfig::API_MRG':                                   '/mrg/api/v1/',
  'ChannelsConfig::API_MRG_ACCOUNT':                           '/mrg/api/v3/account/',
  'ChannelsConfig::API_MRG_ACCOUNT_ISIGNAL':                   '/mrg/api/v1/isignal/account/',
  'ChannelsConfig::API_MRG_ACC_TYPE':                          '/mrg/api/v2/account/types/',
  'ChannelsConfig::API_MRG_CHECK_LIST':                        '/mrg/api/v1/account/',
  'ChannelsConfig::API_MRG_CHECK_PASSWORD':                    '/mrg/api/v2/account/password/check/',
  'ChannelsConfig::API_MRG_CHECK_SYMBOL':                      '/mrg/api/v2/account/symbol/',
  'ChannelsConfig::API_MRG_INFO':                              '/mrg/api/v2/account/info/',
  'ChannelsConfig::API_MRG_TYPE_ACCOUNT_ISIGNAL':              '/mrg/api/v1/account/types/isignal/',
  'ChannelsConfig::API_MRG_V2':                                '/mrg/api/v2/',
  'ChannelsConfig::API_MRG_V3':                                '/mrg/api/v3/',
  'ChannelsConfig::API_MT4ID_LIST':                            '/ois/api/v1//copy/auto/list/',
  'ChannelsConfig::API_MY_CHANNEL':                            '/ois/api/v1/my-channel/',
  'ChannelsConfig::API_MY_CHANNEL_COUNTING_SIDEBAR':           '/ois/api/v2/dashboard/mobile/',
  'ChannelsConfig::API_MY_CHANNEL_NEW':                        '/ois/api/v1/my-channel/',
  'ChannelsConfig::API_MY_TRANSACTION_HISTORY':                '/ois/api/v2/transaction/history/',
  'ChannelsConfig::API_OIS':                                   '/ois/api/v1/',
  'ChannelsConfig::API_OIS_2':                                 '/ois/api/v2/',
  'ChannelsConfig::API_OIS_3':                                 '/ois/api/v3/',
  'ChannelsConfig::API_OIS_4':                                 '/ois/api/v4/',
  'ChannelsConfig::API_OIS_5':                                 '/ois/api/v5/',
  'ChannelsConfig::API_OIS_NOT_V':                             '/ois/api/',
  'ChannelsConfig::API_PARTNERSHIP_ACCEPT':                    '/ois/api/v1/partnership/accept/',
  'ChannelsConfig::API_PARTNERSHIP_OFFERING':                  '/ois/api/v1/partnership/offering/',
  'ChannelsConfig::API_PAYMENT_CANCEL':                        '/ois/api/v1/subscribe/payment/cancel/',
  'ChannelsConfig::API_PAYMENT_CANCEL_2':                      '/ois/api/v2/subscribe/payment/cancel/',
  'ChannelsConfig::API_PAYMENT_CHANNEL_DETAIL':                '/ois/api/v1/subscribe/payment/detail/',
  'ChannelsConfig::API_PAYMENT_CONFIRM':                       '/ois/api/v1/subscribe/payment/confirm/',
  'ChannelsConfig::API_PAYMENT_CONFIRM_BULK':                  '/ois/api/v1/subscribe/payment/bulk/extend/',
  'ChannelsConfig::API_PAYMENT_CONFIRM_BULK_2':                '/ois/api/v2/subscribe/payment/bulk/extend/',
  'ChannelsConfig::API_PAYMENT_CONFIRM_NEW':                   '/ois/api/v2/subscribe/payment/confirm/',
  'ChannelsConfig::API_PAYMENT_CONFIRM_OIS_3':                 '/ois/api/v3/subscribe/payment/confirm/',
  'ChannelsConfig::API_PAYMENT_DETAIL_NEW':                    '/ois/api/v2/subscribe/payment/detail/',
  'ChannelsConfig::API_PAYMENT_FEE_AUTOCOSIG':                 '/ois/api/v1/subscribe//payment/fee/',
  'ChannelsConfig::API_PAYMENT_FEE_AUTOCOSIG_2':               '/ois/api/v2/subscribe//payment/fee/',
  'ChannelsConfig::API_PAYMENT_METHOD_EXTEND':                 '/ois/api/v1/subscribe/payment/channels/',
  'ChannelsConfig::API_PAYMENT_NOTIF':                         '/ois/api/v1/subscribe/payment/notification/',
  'ChannelsConfig::API_PAYMENT_PENDING':                       '/ois/api/v1/subscribe/payment/pending/',
  'ChannelsConfig::API_PAYMENT_PENDING_NEW':                   '/ois/api/v2/subscribe/payment/pending/',
  'ChannelsConfig::API_PAYMENT_PRICE':                         '/ois/api/v1/subscribe/payment/price/',
  'ChannelsConfig::API_PAYMENT_PRICE_2':                       '/ois/api/v2/subscribe/payment/price/',
  'ChannelsConfig::API_PAYMENT_RETAIL_CONFIG':                 '/ois/api/v2/subscribe/payment/retail/config/',
  'ChannelsConfig::API_QUALIFICATION_HISTORY':                 '/ois/api/v1/channel/medal/qualification/history/',
  'ChannelsConfig::API_QUALIFICATION_HISTORY_2':               '/ois/api/v2/channel/medal/qualification/',
  'ChannelsConfig::API_QUALIFICATION_HISTORY_3':               '/ois/api/v3/channel/medal/qualification/',
  'ChannelsConfig::API_RECENT_SIGNAL_3':                       '/ois/api/v3/signal/recent/',
  'ChannelsConfig::API_RECOMMENDED_CHANNEL_2':                 '/ois/api/v2/channel/recommend/',
  'ChannelsConfig::API_REPAYMENT_AUTOCOSIG':                   '/ois/api/v1/copy/auto/setting/additional/renew/',
  'ChannelsConfig::API_SCORE_CHANNEL_DETAIL':                  '/ois/api/v1/channel/scoring/history/',
  'ChannelsConfig::API_SCORE_OVERVIEW':                        '/ois/api/v1/channel/scoring/overview/',
  'ChannelsConfig::API_SETTING_UPDATE_CONNECTION':             '/ois/api/v1/copy/auto/setting/update-all-connection/',
  'ChannelsConfig::API_SIGNAL':                                '/ois/api/v1/signal/',
  'ChannelsConfig::API_SIGNAL_2':                              '/ois/api/v3/channel/signal/',
  'ChannelsConfig::API_SIGNAL_3':                              '/ois/api/v3/signal/',
  'ChannelsConfig::API_SIGNAL_4':                              '/ois/api/v4/channel/signal/',
  'ChannelsConfig::API_SIGNAL_ADD':                            '/ois/api/v1/signal/create/',
  'ChannelsConfig::API_SIGNAL_CANCEL':                         '/ois/api/v1/signal/cancel/',
  'ChannelsConfig::API_SIGNAL_COPIED':                         '/ois/api/v1/copy/signal/copied/list/',
  'ChannelsConfig::API_SIGNAL_COPIED_2':                       '/ois/api/v2/signal/',
  'ChannelsConfig::API_SIGNAL_COPIED_CHECK':                   '/ois/api/v1/signal/',
  'ChannelsConfig::API_SIGNAL_GET_TRADE':                      '/ois/api/v1/signal/trade/byme/',
  'ChannelsConfig::API_SIGNAL_RECENT':                         '/ois/api/v1/signal/recent/',
  'ChannelsConfig::API_SIGNAL_RETAIL_BULK':                    '/ois/api/v1/channel/signal/retail/bulk/',
  'ChannelsConfig::API_SUBSCRIBE':                             '/ois/api/v1/subscribe/',
  'ChannelsConfig::API_SUBSCRIBE_NEW':                         '/ois/api/v2/subscribe/',
  'ChannelsConfig::API_SUBSCRIBE_OIS_3':                       '/ois/api/v3/subscribe/',
  'ChannelsConfig::API_SUBSCRIBE_PAYMENT_NOTIF':               '/ois/api/v1/subscribe/payment/notification/',
  'ChannelsConfig::API_SUBS_CURRENT':                          '/ois/api/v1/my/subscription/current/',
  'ChannelsConfig::API_SYMBOL':                                '/ois/api/v2/symbol/',
  'ChannelsConfig::API_SYMBOL_MANUAL':                         '/ois/api/v2/symbol/recommend/manual/',
  'ChannelsConfig::API_SYMBOL_MANUAL_V2':                      '/ois/api/v3/symbol/recommend/manual/',
  'ChannelsConfig::API_SYMBOL_V2':                             '/ois/api/v3/symbol/',
  'ChannelsConfig::API_TRENDING_CHANNEL':                      '/ois/api/v1/channel/trending/',
  'ChannelsConfig::API_UNSUBSCRIBE':                           '/ois/api/v1/unsubscribe/',
  'ChannelsConfig::API_UNSUBSCRIBE_2':                         '/ois/api/v2/unsubscribe/',
  'ChannelsConfig::API_UPDATE_SIGNAL':                         '/ois/api/v1/signal/update/',
  'ChannelsConfig::API_V1_CONFIG_CREATE_NEW_CHANNEL':          '/ois/api/v1/channel/config/',
  'ChannelsConfig::API_V2_PRICE_RANGE_CREATE_CHANNEL':         '/ois/api/v2/subscribe/payment/retail/config/',
  'ChannelsConfig::API_V3_CREATE_CHANNEL':                     '/ois/api/v3/channel/create/',
  'ChannelsConfig::API_V3_UPDATE_CHANNEL':                     '/ois/api/v3/channel/update/',
  'ChannelsConfig::SIGNAL_COPY_2':                             '/ois/api/v2/signal/',
  // FaConfig (faconfig.php)
  'FaConfig::API_ADD_CART_FA':                                '/ois/api/v1/porto/cart/create/',
  'FaConfig::API_ADD_WISHLIST':                               '/ois/api/v1/porto/wishlist/add/',
  'FaConfig::API_ALL_REMOVE_WISHLIST':                        '/ois/api/v1/porto/wishlist/clear/',
  'FaConfig::API_BANK_LIST':                                  '/ois/api/v1//banks/',
  'FaConfig::API_CART_PRESET_DETAIL':                         '/ois/api/v1/porto/cart/preset/{id}/',
  'FaConfig::API_CART_PRESET_LIST':                           '/ois/api/v1/porto/cart/preset/',
  'FaConfig::API_CHANNEL':                                    '/ois/api/v1/channel/',
  'FaConfig::API_CHANNEL_2':                                  '/ois/api/v2/channel/',
  'FaConfig::API_CHANNEL_3':                                  '/ois/api/v3/channel/',
  'FaConfig::API_CHANNEL_CHART':                              '/ois/api/v2/channel/chart/',
  'FaConfig::API_CHANNEL_CHART_2':                            '/ois/api/v2/channel/chart/',
  'FaConfig::API_CHANNEL_DETAIL_2':                           '/ois/api/v2/channel/detail/',
  'FaConfig::API_CHANNEL_MY_SUBSCRIPTIONS_NEW':               '/ois/api/v3/my/subscriptions/',
  'FaConfig::API_CHANNEL_SEARCH_3':                           '/ois/api/v3/channel/search/',
  'FaConfig::API_CRATE_FA_PORTO':                             '/ois/api/v1/porto/create/',
  'FaConfig::API_CREATE_CART_PRESET':                         '/ois/api/v1/porto/cart/preset/create/',
  'FaConfig::API_CREATE_INCUBATION':                          '/ois/api/v1/porto/incubate/create/',
  'FaConfig::API_CREATE_MERCHANT':                            '/ois/api/v1/porto/merchant/create/',
  'FaConfig::API_DELETE_CART_PRESET':                         '/ois/api/v1/porto/cart/delete/',
  'FaConfig::API_DETAIL_PORTO_CHART':                         '/ois/api/v1/porto/chart/symbol/',
  'FaConfig::API_DETAIL_PORTO_DETAIL':                        '/ois/api/v1/porto/summary/',
  'FaConfig::API_DETAIL_PORTO_LIST':                          '/ois/api/v1/porto/list/',
  'FaConfig::API_FA_MOST_CONSISTENT':                         '/ois/api/v1/channel/consistent/',
  'FaConfig::API_FA_MOST_CONSISTENT_V2':                      '/ois/api/v2/channel/consistent/',
  'FaConfig::API_FA_POINT_CONFIG':                            '/ois/api/v1/channel/point/config/',
  'FaConfig::API_FA_SIGNAL_FEED':                             '/ois/api/v2/channel/signal/feed/',
  'FaConfig::API_INCUBATION_CHART_DATA':                      '/ois/api/v1/porto/incubate/chart/symbol/',
  'FaConfig::API_INCUBATION_LIST':                            '/ois/api/v1/porto/incubate/list/',
  'FaConfig::API_MERCHANT_DETAIL':                            '/ois/api/v1/porto/merchant/detail/',
  'FaConfig::API_OIS':                                        '/ois/api/v1/',
  'FaConfig::API_OIS_2':                                      '/ois/api/v2/',
  'FaConfig::API_OIS_3':                                      '/ois/api/v3/',
  'FaConfig::API_OIS_AVATAR_UPDATE':                          '/ois/api/v1/merchant/avatar/update/',
  'FaConfig::API_OIS_V1_EDIT_INCUBATION':                     '/ois/api/v1/porto/incubate/edit/',
  'FaConfig::API_OIS_V1_PORTO_CART_PRESET_DELETE':            '/ois/api/v1/porto/cart/preset/delete/',
  'FaConfig::API_OIS_V1_PORTO_COPY_SIGNAL':                   '/ois/api/v1/porto/signals/copy/',
  'FaConfig::API_OIS_V1_PORTO_GET_CHECK_COPIED_SIGNAL':       '/ois/api/v1/porto/signals/copy/detail/',
  'FaConfig::API_OIS_V1_PORTO_INCUBATE_CANCEL':               '/ois/api/v1/porto/incubate/cancel/',
  'FaConfig::API_OIS_V1_PORTO_MERCHANT_PERFORMANCE':          '/ois/api/v1/porto/merchant/performance/',
  'FaConfig::API_OIS_V1_PORTO_MERCHANT_SUBSCRIBER':           '/ois/api/v1/porto/merchant/subscribers/',
  'FaConfig::API_OIS_V1_PORTO_SEARCH':                        '/ois/api/v1/porto/search/',
  'FaConfig::API_OIS_V1_PORTO_SIGNAL_DETAIL':                 '/ois/api/v1/porto/signals/detail/',
  'FaConfig::API_OIS_V1_SUBSCRIBE':                           '/ois/api/v1/porto/subscribe/',
  'FaConfig::API_OIS_V1_SUBSCRIBE_PAYMENT_CHANNELS':          '/ois/api/v1/subscribe/payment/channels/',
  'FaConfig::API_OIS_V1_SUBSCRIBE_PAYMENT_PENDING':           '/ois/api/v1/subscribe/payment/pending/',
  'FaConfig::API_OIS_V1_SUBSCRIBE_PAYMENT_PORTO':             '/ois/api/v1/porto/subscribe/payment/',
  'FaConfig::API_OIS_V1_UNSUBSCRIBE':                         '/ois/api/v1/porto/unsubscribe/',
  'FaConfig::API_OIS_V2_SUBSCRIBE_PAYMENT_CANCEL':            '/ois/api/v2/subscribe/payment/cancel/',
  'FaConfig::API_OIS_V2_SUBSCRIBE_PAYMENT_DETAIL':            '/ois/api/v2/subscribe/payment/detail/',
  'FaConfig::API_OIS_V3_CHANNEL_CHART':                       '/ois/api/v3/channel/chart/',
  'FaConfig::API_OIS_V4_CHANNEL_SUMMARY':                     '/ois/api/v4/channel/summary/',
  'FaConfig::API_OIS_V5_CHANNEL_SUMMARY':                     '/ois/api/v5/channel/summary/',
  'FaConfig::API_PAYMENT_RETAIL_CONFIG':                      '/ois/api/v2/subscribe/payment/retail/config/',
  'FaConfig::API_PORTO':                                      '/ois/api/v1/porto/',
  'FaConfig::API_PORTO_CART':                                 '/ois/api/v1/porto/cart/',
  'FaConfig::API_PORTO_CHANNEL_PRICE':                        '/ois/api/v1/porto/channel/price/',
  'FaConfig::API_PORTO_CONFIG':                               '/ois/api/v1/porto/config/',
  'FaConfig::API_PORTO_INCUBATION':                           '/ois/api/v1/porto/incubate/',
  'FaConfig::API_PORTO_LIST':                                 '/ois/api/v1/porto/search/',
  'FaConfig::API_PORTO_MERCHANT':                             '/ois/api/v1/porto/merchant/',
  'FaConfig::API_PORTO_PAYMENT':                              '/ois/api/v1/subscribe/payment/',
  'FaConfig::API_PORTO_SUBSCRIPTION_LIST':                    '/ois/api/v1/my/porto/subscriptions/',
  'FaConfig::API_PORTO_UPDATE':                               '/ois/api/v1/porto/update/',
  'FaConfig::API_PORTO_WISHLIST':                             '/ois/api/v1/porto/wishlist/',
  'FaConfig::API_RECENT_SIGNAL_3':                            '/ois/api/v3/signal/recent/',
  'FaConfig::API_REMOVE_WISHLIST':                            '/ois/api/v1/porto/wishlist/delete/',
  'FaConfig::API_SIGNAL':                                     '/ois/api/v1/signal/',
  'FaConfig::API_SIGNAL_2':                                   '/ois/api/v2/channel/signal/',
  'FaConfig::API_SIGNAL_3':                                   '/ois/api/v3/signal/',
  'FaConfig::API_SIGNAL_GET_TRADE':                           '/ois/api/v1/signal/trade/byme/',
  'FaConfig::API_SIGNAL_INCUBATION_LIST':                     '/ois/api/v1/porto/incubate/signals/',
  'FaConfig::API_SIGNAL_PORTO_COPIED':                        '/ois/api/v1/porto/signals/{porto_signal_id}/copied/',
  'FaConfig::API_SIGNAL_PORTO_COPY_LIST':                     '/ois/api/v1/porto/signals/copy/list/',
  'FaConfig::API_SIGNAL_PORTO_LIST':                          '/ois/api/v1/porto/signals/',
  'FaConfig::API_SIGNAL_RETAIL_BULK':                         '/ois/api/v1/channel/signal/retail/bulk/',
  'FaConfig::API_SIGNAL_SUBSCRIBED_LIST':                     '/ois/api/v1/porto/signals/subscribed/',
  'FaConfig::API_SUBSCRIBE':                                  '/ois/api/v1/subscribe/',
  'FaConfig::API_SUBSCRIBE_EXTEND_BULK':                      '/ois/api/v1/porto/subscribe/bulk/extend/',
  'FaConfig::API_SUBSCRIBE_NEW':                              '/ois/api/v2/subscribe/',
  'FaConfig::API_SUBSCRIBE_PAYMENT_FEE':                      '/ois/api/v1/subscribe/payment/fee/',
  'FaConfig::API_SUBSCRIBE_PAYMENT_PRICE':                    '/ois/api/v1/subscribe/payment/price/',
  'FaConfig::API_SYMBOL':                                     '/ois/api/v2/symbol/',
  'FaConfig::API_SYMBOL_3':                                   '/ois/api/v3/symbol/',
  'FaConfig::API_SYMBOL_MANUAL':                              '/ois/api/v3/symbol/recommend/manual/',
  'FaConfig::API_SYMBOL_SUBSCRIBED_LIST':                     '/ois/api/v1/porto/symbol/subscribed/',
  'FaConfig::API_TRADERS':                                    '/traders/api/v1/',
  'FaConfig::API_UPDATE_CART_PRESET':                         '/ois/api/v1/porto/cart/preset/edit/',
  'FaConfig::API_USERS':                                      '/traders/api/v1/user/',
  'FaConfig::API_USER_DATA':                                  '/traders/api/v1/user/mydata/',
  'FaConfig::API_USER_SUB':                                   '/ois/api/v1/my/',
  'FaConfig::API_WISHLIST_LIST':                              '/ois/api/v1/porto/wishlist/',
};

function extractMethod(line: string): HttpClientMethod {
  const m = line.match(/\.(get|post|put|patch|delete)\(/i);
  if (!m) return 'unknown';
  return m[1]!.toUpperCase() as HttpClientMethod;
}

function normalizeUrl(raw: string): string {
  // Strip template literal expressions, keep static parts
  return raw.replace(/\$\{[^}]+\}/g, '*').trim();
}

/** Look back up to 5 lines to resolve a bare variable to its assigned value */
function resolveVariable(varName: string, lines: string[], currentIndex: number): string | null {
  // matches: const url = 'literal', const url = process.env.FOO, or ternary with env vars
  const simpleAssign = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*(['"\`]([^'"\`]+)['"\`]|process\\.env\\.\\w+)`);
  const ternaryAssign = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=.*?(process\\.env\\.\\w+)`);
  for (let j = currentIndex - 1; j >= Math.max(0, currentIndex - 5); j--) {
    const line = lines[j]!;
    const m = simpleAssign.exec(line) ?? ternaryAssign.exec(line);
    if (m) return m[1]!;
  }
  return null;
}

function isIgnoredFile(sourcePath: string): boolean {
  const lower = sourcePath.toLowerCase();
  return lower.endsWith('.json') || lower.endsWith('.md') || lower.includes('node_modules');
}

/**
 * Extracts outbound HTTP client calls from Node/JS/TS and PHP source files.
 * Captures cross-service calls like ims-tf (PHP) → ims-tf2 (Node) endpoints.
 */
export function extractHttpClients(content: string, sourcePath: string): HttpClientFact[] {
  if (isIgnoredFile(sourcePath)) return [];

  const facts: HttpClientFact[] = [];
  const lines = content.split('\n');
  const seen = new Set<string>();
  const isPhp = sourcePath.toLowerCase().endsWith('.php');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNumber = i + 1;

    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

    if (isPhp) {
      // curl_init($url) inline
      PHP_CURL_INLINE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = PHP_CURL_INLINE.exec(line)) !== null) {
        const urlHint = normalizeUrl(match[1]!);
        const key = `${urlHint}|curl|${lineNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({ method: 'unknown', urlHint, lib: 'curl', sourcePath, line: lineNumber, confidence: 'high' });
      }

      // curl_setopt($ch, CURLOPT_URL, $url)
      PHP_CURL_SETOPT_URL.lastIndex = 0;
      while ((match = PHP_CURL_SETOPT_URL.exec(line)) !== null) {
        const urlHint = normalizeUrl(match[1]!);
        const key = `${urlHint}|curl|${lineNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({ method: 'unknown', urlHint, lib: 'curl', sourcePath, line: lineNumber, confidence: 'high' });
      }

      // NodeAPI::method() — PHP→ims-tf2 bridge calls
      PHP_NODE_API.lastIndex = 0;
      while ((match = PHP_NODE_API.exec(line)) !== null) {
        const methodName = match[1]!;
        const mapped = NODE_API_ENDPOINT_MAP[methodName];
        const urlHint = mapped ? `APIURL${mapped.path}` : `APIURL/[${methodName}]`;
        const httpMethod = mapped?.method ?? 'POST';
        const key = `${urlHint}|curl|${lineNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({ method: httpMethod, urlHint, lib: 'curl', sourcePath, line: lineNumber, confidence: mapped ? 'high' : 'medium' });
      }

      // MMBConfig::CONST, MrgConfig::CONST, TradersConfig::CONST used as curl URLs
      PHP_CONFIG_CONST.lastIndex = 0;
      while ((match = PHP_CONFIG_CONST.exec(line)) !== null) {
        const className = match[1]!;
        const constName = match[2]!;
        const key2 = `${className}::${constName}`;
        const resolvedPath = CONFIG_CONST_MAP[key2];
        const urlHint = resolvedPath ? `APIURL${resolvedPath}` : `APIURL/[${key2}]`;
        const confidence = resolvedPath ? 'high' : 'medium';
        const dedupeKey = `${urlHint}|curl|${lineNumber}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        facts.push({ method: 'unknown', urlHint, lib: 'curl', sourcePath, line: lineNumber, confidence });
      }
    } else {
      for (const pattern of NODE_PATTERNS) {
        pattern.regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.regex.exec(line)) !== null) {
          let raw = match[pattern.urlGroup] ?? '';
          let confidence = pattern.confidence;
          // If captured value is a bare variable (no quotes/slash/dot), look back up to 5 lines
          if (raw && !raw.startsWith("'") && !raw.startsWith('"') && !raw.startsWith('`') && !raw.includes('/') && !raw.includes('.')) {
            const resolved = resolveVariable(raw, lines, i);
            if (resolved) { raw = resolved; confidence = 'medium'; }
          }
          const urlHint = normalizeUrl(raw);
          if (!urlHint) continue;
          const method = pattern.method === 'unknown' ? extractMethod(line) : pattern.method;
          const key = `${urlHint}|${pattern.lib}|${lineNumber}`;
          if (seen.has(key)) continue;
          seen.add(key);
          facts.push({ method, urlHint, lib: pattern.lib, sourcePath, line: lineNumber, confidence });
        }
      }
    }
  }

  return facts;
}
