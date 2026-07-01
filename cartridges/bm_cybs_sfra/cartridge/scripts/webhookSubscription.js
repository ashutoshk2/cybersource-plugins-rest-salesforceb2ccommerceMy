'use strict';

// Relies on the http layer's callApi invoking its callback synchronously (so each webhooks.* call
// returns a populated { data, error } before it returns).

var webhooks = require('*/cartridge/scripts/http/webhookManagement');
var webhookHelper = require('*/cartridge/scripts/helpers/webhookHelper');
var WEBHOOK_CONFIGS = require('*/cartridge/scripts/config/webhookConfigs');
var Transaction = require('dw/system/Transaction');
var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var URLUtils = require('dw/web/URLUtils');
var URLAction = require('dw/web/URLAction');
var Site = require('dw/system/Site');
var Logger = require('dw/system/Logger').getLogger('cybs_webhooks', 'webhookSubscription');

var CUSTOM_OBJECT_TYPE = 'VisaAcceptanceWebhookSubscription';

/**
 * Create a subscription, recovering from the 400 "Record already exists" conflict (a subscription
 * exists at Visa Acceptance but is untracked locally). The HMAC secret is only returned at creation and
 * cannot be recovered, so matching webhook(s) are deleted and recreated rather than adopted.
 *
 * @param {Object} subConfig per-call subscription config (name, description, products)
 * @param {string} webhookUrl target webhook URL
 * @param {string} productId product id to reconcile against
 * @returns {Object} { webhookId, status, error }
 */
function createSubscriptionWithRecovery(subConfig, webhookUrl, productId) {
    var result = { webhookId: '', status: '', error: null };
    var conflict = false;

    var createResult = webhooks.createSubscription(subConfig, webhookUrl);
    if (!createResult.error && createResult.data && createResult.data.webhookId) {
        result.webhookId = createResult.data.webhookId;
        result.status = createResult.data.status || '';
    } else if (createResult.error) {
        // On error, data is the response body and error is the numeric HTTP status.
        var msg = (typeof createResult.data === 'string') ? createResult.data : JSON.stringify(createResult.data || createResult.error);
        // Recover only on a real 400 "already exists". error may be a number or numeric string.
        if (parseInt(createResult.error, 10) === 400 && /already\s*exist/i.test(msg)) {
            conflict = true;
        } else {
            Logger.error('createSubscription failed for ' + productId + ': ' + msg);
            result.error = 'API_ERROR';
        }
    }

    if (result.webhookId || result.error) return result;
    if (!conflict) { result.error = 'API_ERROR'; return result; }

    // The conflict can be on any bundled product (UC bundles unifiedCheckout + alternativePaymentMethods),
    // so reconcile across all of this config's products. Dedup ids since one webhook can cover several.
    Logger.warn('createSubscriptionWithRecovery: ' + productId + ' (or a bundled product) already exists at Visa Acceptance but is untracked locally; deleting matching subscription(s) and recreating to restore a known security key.');
    var idsToDelete = [];
    function collectConflicts(prod) {
        var targetEvents = prod.eventTypes || [];
        var listResult = webhooks.retrieveWebhooks(prod.productId);
        if (listResult.error) {
            Logger.error('createSubscriptionWithRecovery: retrieveWebhooks failed for ' + prod.productId + ': ' + JSON.stringify(listResult.error));
            return;
        }
        var listData = listResult.data;
        if (!Array.isArray(listData) || !listData.length) return;
        for (var i = 0; i < listData.length; i++) {
            var wh = listData[i];
            if (!wh || !wh.webhookId || idsToDelete.indexOf(wh.webhookId) !== -1) continue; // eslint-disable-line no-continue
            var whEvents = [];
            if (Array.isArray(wh.products)) {
                for (var p = 0; p < wh.products.length; p++) {
                    if (wh.products[p] && wh.products[p].productId === prod.productId && Array.isArray(wh.products[p].eventTypes)) {
                        whEvents = wh.products[p].eventTypes;
                        break;
                    }
                }
            }
            // Match on event types, or a lone product-scoped webhook whose event types the response omitted.
            if (webhookHelper.eventTypesMatch(whEvents, targetEvents) || listData.length === 1) idsToDelete.push(wh.webhookId);
        }
    }
    for (var pc = 0; pc < (subConfig.products || []).length; pc++) collectConflicts(subConfig.products[pc]);

    if (!idsToDelete.length) {
        Logger.error('createSubscriptionWithRecovery: could not unambiguously locate the conflicting webhook(s) for ' + productId + ' or its bundled products to delete; manual cleanup required in EBC.');
        result.error = 'ALREADY_EXISTS';
        return result;
    }

    var deletedAny = false;
    function deleteWebhook(existingId) {
        var delResult = webhooks.deleteSubscription(existingId);
        if (delResult.error) {
            Logger.error('createSubscriptionWithRecovery: delete of existing ' + productId + ' webhook ' + existingId + ' failed: ' + JSON.stringify(delResult.error));
            return false;
        }
        return true;
    }
    for (var d = 0; d < idsToDelete.length; d++) {
        if (deleteWebhook(idsToDelete[d])) deletedAny = true;
    }
    if (!deletedAny) { result.error = 'ALREADY_EXISTS'; return result; }

    var recreateResult = webhooks.createSubscription(subConfig, webhookUrl);
    if (!recreateResult.error && recreateResult.data && recreateResult.data.webhookId) {
        result.webhookId = recreateResult.data.webhookId;
        result.status = recreateResult.data.status || '';
    } else {
        // Delete succeeded but recreate failed: the product now has no webhook.
        Logger.warn('createSubscriptionWithRecovery: recreate after delete failed for ' + productId + ' — the product now has NO webhook; re-run subscribe to restore it. ' + JSON.stringify(recreateResult.error || recreateResult.data));
        result.error = 'RECREATE_FAILED_AFTER_DELETE';
    }
    return result;
}

/**
 * Fetch the merchant's available webhook products once, normalized to an array.
 *
 * @returns {Object} { products: Array|null, error: (boolean|number|string) }
 */
function getAvailableProducts() {
    var productsResult = webhooks.findProductsToSubscribe();
    if (productsResult.error) {
        return { products: null, error: productsResult.error };
    }
    var data = productsResult.data;
    var list = Array.isArray(data) ? data : (data && data.products ? data.products : null);
    return { products: list, error: null };
}

/**
 * Reduce a normalized product list to the set of product ids the merchant has enabled.
 *
 * @param {Array} products normalized product list from getAvailableProducts
 * @returns {Array} product id strings
 */
function toProductIds(products) {
    var ids = [];
    if (Array.isArray(products)) {
        for (var i = 0; i < products.length; i++) {
            if (products[i] && products[i].productId) ids.push(products[i].productId);
        }
    }
    return ids;
}

/**
 * Store the org signing secret on globalConfiguration for the webhook controller to validate against.
 * The key is org-scoped and newest-wins, so we keep only the latest.
 *
 * @param {string} secret base64 shared secret
 */
function storeSigningKey(secret) {
    if (!secret) return;
    Transaction.wrap(function () {
        var globalConfig = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration')
                || CustomObjectMgr.createCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration');
        globalConfig.custom.SecurityKey = secret;
    });
}

/**
 * Mint a fresh org signing key and return its secret.
 *
 * @returns {string} base64 shared secret ('' on failure)
 */
function createSigningKey() {
    var keyResult = webhooks.createSecurityKey();
    if (keyResult.error) {
        Logger.error('createSecurityKey failed: ' + JSON.stringify(keyResult.error));
        return '';
    }
    if (keyResult.data && keyResult.data.status === 'SUCCESS' && keyResult.data.keyInformation) {
        return keyResult.data.keyInformation.key || '';
    }
    return '';
}

/**
 * @param {string} configId WEBHOOK_CONFIGS key ('fraudManagement' | 'unifiedCheckout')
 * @param {boolean} forceRecreate skip the activate-existing shortcut and always recreate (host repoint)
 * @param {Array} [availableProducts] catalog from getAvailableProducts, reused to avoid re-listing it
 * @param {string} [signingKey] org signing secret minted once per cycle; self-created if omitted
 * @returns {Object} subscribe result
 */
function subscribeProduct(configId, forceRecreate, availableProducts, signingKey) {
    var config = WEBHOOK_CONFIGS[configId];
    var site = Site.getCurrent();

    var egressPublicKey = '';
    try {
        var globalObj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration');
        if (globalObj) {
            egressPublicKey = globalObj.custom.EgressPublicKey || '';
        }
    } catch (e) {}

    // UC webhooks use Response MLE; Visa Acceptance needs the egress public key to encrypt them. If none
    // is stored yet, derive it from the .p12 alias and register with KMS — only proceed if KMS accepts it.
    if (configId === 'unifiedCheckout' && !egressPublicKey) {
        var egressAlias = site.getCustomPreferenceValue('VisaAcceptance_EgressCertificateAlias');
        var derivedEgressKey = webhookHelper.deriveEgressCertificateB64(egressAlias);
        var derivedUploadOk = false;
        if (derivedEgressKey) {
            var derivedUpload = webhooks.uploadAsymmetricKey(derivedEgressKey);
            if (derivedUpload.error) Logger.error('subscribeProduct: failed to upload derived egress public key: ' + JSON.stringify(derivedUpload.error));
            else derivedUploadOk = true;
        }
        if (derivedUploadOk) {
            egressPublicKey = derivedEgressKey;
            Transaction.wrap(function () {
                var globalConfig = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration') || CustomObjectMgr.createCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration');
                globalConfig.custom.EgressPublicKey = egressPublicKey;
            });
        } else {
            Logger.error('subscribeProduct: ' + configId + ' subscribe blocked — could not derive/register an egress public key from alias "' + egressAlias + '". Verify the RSA .p12 is imported under Private Keys and Certificates.');
            return { success: false, error: 'EGRESS_KEY_REQUIRED' };
        }
    }

    // The webhook callback URL is derived entirely from the site: its ID (in the on-demandware path)
    // and its configured host, via URLUtils. There is no custom-endpoint override.
    var webhookUrl = URLUtils.https(new URLAction(config.notificationEndpoint, site.ID)).toString();

    var existingObj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId);

    // Re-activating the stored webhook returns 404 if it was deleted in EBC: treat the record as stale
    // and recreate. A non-404 failure bails out so we never duplicate a subscription that may still exist.
    // forceRecreate (host repoint) skips this shortcut and always goes through createSubscriptionWithRecovery.
    var staleWebhookDeleted = false;
    if (!forceRecreate && existingObj && existingObj.custom.WebhookId && existingObj.custom.WebhookUrl === webhookUrl) {
        var alreadyActive = false;
        var existingActivation = webhooks.activateSubscription(existingObj.custom.WebhookId);
        // error carries the HTTP status and may be a number or a numeric string, so normalize it
        // with parseInt before comparing. The stored webhook is unusable by the current credentials
        // when it was deleted (404) or belongs to a different org (401/403, e.g. after a MID change)
        // — in all of those we abandon it and create a fresh one. Any other failure is ambiguous
        // (the webhook may still exist), so we bail rather than risk a duplicate.
        var activationStatus = parseInt(existingActivation.error, 10);
        var existingUnusable = (activationStatus === 404 || activationStatus === 401 || activationStatus === 403);
        if (existingActivation.error) {
            // The unusable cases are handled below by recreating (logged as WARN) — only log a real
            // error for other failures.
            if (!existingUnusable) {
                Logger.error('activateSubscription failed for existing ' + configId + ' (' + existingObj.custom.WebhookId + '): ' + JSON.stringify(existingActivation.error));
            }
        } else {
            alreadyActive = true;
        }
        if (alreadyActive) {
            return { success: true, alreadyExists: true, error: null };
        }
        if (!existingUnusable) {
            return { success: false, alreadyExists: true, error: 'ACTIVATION_ERROR' };
        }
        Logger.warn('Existing ' + configId + ' webhook ' + existingObj.custom.WebhookId + ' is not usable by the current credentials (status ' + activationStatus + '); recreating subscription.');
        staleWebhookDeleted = true;
    }
    // Defer stale-subscription cleanup until the replacement is active and persisted.
    var oldWebhookIdToCleanup = (!staleWebhookDeleted && existingObj && existingObj.custom.WebhookId) ? existingObj.custom.WebhookId : null;

    // Use the cycle key if the caller minted one; else self-create (standalone subscribe entry points).
    var securityKey = signingKey || createSigningKey();
    if (!securityKey) return { success: false, error: 'KEY_ERROR' };
    storeSigningKey(securityKey);

    var webhookId = '';
    var createdStatus = '';
    var specificError = null;

    // Reuse the caller's catalog if given; else fetch it (standalone subscribe entry points).
    var productList = Array.isArray(availableProducts) ? availableProducts : null;
    if (!productList) {
        var productsResult = webhooks.findProductsToSubscribe();
        if (productsResult.error) {
            Logger.error('Product list fetch failed for ' + configId + ': ' + JSON.stringify(productsResult.error));
            specificError = 'API_ERROR';
        } else {
            productList = Array.isArray(productsResult.data) ? productsResult.data : (productsResult.data && productsResult.data.products ? productsResult.data.products : null);
            if (!productList) {
                specificError = 'API_ERROR';
            }
        }
    }

    if (productList) {
        // Log the products Visa Acceptance offers so a PRODUCT_NOT_ENABLED outcome is debuggable.
        var availableProductIds = [];
        for (var ap = 0; ap < productList.length; ap++) {
            availableProductIds.push(productList[ap].productId);
        }
        Logger.info('subscribeProduct: ' + configId + ' available webhook products from Visa Acceptance: [' + availableProductIds.join(', ') + ']');
        var found = false;
        if (configId === 'fraudManagement') {
            for (var i = 0; i < productList.length; i++) {
                var availableProd = productList[i].productId;
                if (availableProd === 'decisionManager' || availableProd === 'fraudManagementEssentials') {
                    for (var j = 0; j < config.products.length; j++) {
                        if (config.products[j].productId === availableProd) {
                            // Per-call config — never mutate the shared WEBHOOK_CONFIGS.
                            var subConfig = {
                                name: config.name,
                                description: config.description,
                                products: [config.products[j]]
                            };
                            var fraudCreated = createSubscriptionWithRecovery(subConfig, webhookUrl, availableProd);
                            if (fraudCreated.error) {
                                specificError = fraudCreated.error;
                            } else {
                                webhookId = fraudCreated.webhookId;
                                createdStatus = fraudCreated.status;
                            }
                            found = true;
                            break;
                        }
                    }
                }
                if (found) break;
            }
            if (!found) specificError = 'NO_FRAUD_PRODUCT';
        } else {
            for (var k = 0; k < productList.length; k++) {
                if (productList[k].productId === config.products[0].productId) {
                    found = true;
                    var ucCreated = createSubscriptionWithRecovery(config, webhookUrl, config.products[0].productId);
                    if (ucCreated.error) {
                        specificError = ucCreated.error;
                    } else {
                        webhookId = ucCreated.webhookId;
                        createdStatus = ucCreated.status;
                    }
                    break;
                }
            }
            if (!found) {
                Logger.error('subscribeProduct: ' + configId + ' PRODUCT_NOT_ENABLED — required product "' + config.products[0].productId + '" is not among the merchant\'s available webhook products [' + availableProductIds.join(', ') + ']. Ask Visa Acceptance to enable this product for the organization.');
                specificError = 'PRODUCT_NOT_ENABLED';
            }
        }
    }

    if (specificError) return { success: false, error: specificError };
    if (!webhookId) return { success: false, error: 'API_ERROR' };

    // Force the freshly-created webhook to ACTIVE. Visa Acceptance creates it as PENDING_REVIEW/INACTIVE;
    // a successful PUT status=ACTIVE promotes it so it can begin delivering.
    var finalStatus = createdStatus || '';
    if (finalStatus !== 'ACTIVE') {
        var activationSucceeded = false;
        var newActivation = webhooks.activateSubscription(webhookId);
        if (newActivation.error) {
            Logger.error('activateSubscription failed for new ' + configId + ' (' + webhookId + '): ' + JSON.stringify(newActivation.error));
        } else {
            activationSucceeded = true;
            finalStatus = (newActivation.data && newActivation.data.status) ? newActivation.data.status : 'ACTIVE';
        }
        if (!activationSucceeded && finalStatus !== 'PENDING_REVIEW') {
            return { success: false, error: 'ACTIVATION_ERROR' };
        }
    }
    if (!finalStatus) finalStatus = 'ACTIVE';

    Transaction.wrap(function () {
        var obj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId) || CustomObjectMgr.createCustomObject(CUSTOM_OBJECT_TYPE, configId);
        obj.custom.WebhookId = webhookId;
        obj.custom.WebhookUrl = webhookUrl;
        obj.custom.Status = finalStatus;
    });

    // Clean up the stale webhook only once the replacement is ACTIVE.
    if (oldWebhookIdToCleanup && finalStatus === 'ACTIVE') {
        var cleanupResult = webhooks.deleteSubscription(oldWebhookIdToCleanup);
        if (cleanupResult.error) Logger.error('Cleanup of stale webhook ' + oldWebhookIdToCleanup + ' for ' + configId + ' failed: ' + JSON.stringify(cleanupResult.error));
    }

    return { success: true, webhookId: webhookId, status: finalStatus, pendingReview: finalStatus === 'PENDING_REVIEW' };
}

/**
 * Unsubscribe a BM-managed product. The local record (holding the un-recoverable HMAC key) is removed
 * only when Visa Acceptance confirms the delete (error false or 404); any other outcome keeps it for retry.
 *
 * @param {string} configId WEBHOOK_CONFIGS key ('fraudManagement' | 'unifiedCheckout')
 * @returns {Object} { success, alreadyRemoved?, error? }
 */
function unsubscribeProduct(configId) {
    var obj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId);
    if (!obj || !obj.custom.WebhookId) return { success: true, alreadyRemoved: true };
    var deleteConfirmed = false;
    var deleteResult = webhooks.deleteSubscription(obj.custom.WebhookId);
    if (deleteResult.error === false || parseInt(deleteResult.error, 10) === 404) {
        deleteConfirmed = true;
    } else {
        Logger.error('deleteSubscription failed for ' + configId + ' (' + obj.custom.WebhookId + '): ' + JSON.stringify(deleteResult.error) + ' — keeping local BM record because the webhook was not confirmed deleted at Visa Acceptance.');
    }
    if (!deleteConfirmed) return { success: false, error: 'DELETE_FAILED' };
    Transaction.wrap(function () { CustomObjectMgr.remove(obj); });
    return { success: true };
}

/**
 * Abandon the locally stored subscription for a product — clears the tracked WebhookId/Status so the
 * next sync creates a fresh subscription in the current org and updates BM. Used when the stored
 * webhook is no longer present at Visa Acceptance for the active merchant (deleted in EBC, or owned by a
 * different org after a MID change, where we can neither activate nor delete it). The SecurityKey is
 * left intact until the recreate overwrites it.
 *
 * @param {string} configId WEBHOOK_CONFIGS key ('fraudManagement' | 'unifiedCheckout')
 */
function abandonStoredWebhook(configId) {
    try {
        Transaction.wrap(function () {
            var obj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId);
            if (obj && obj.custom.WebhookId) {
                obj.custom.WebhookId = '';
                obj.custom.Status = '';
            }
        });
    } catch (e) {
        Logger.error('abandonStoredWebhook failed for ' + configId + ': ' + (e && e.message ? e.message : e));
    }
}

/**
 * Consolidates all data needed for the Webhook Manager view
 */
function getViewData() {
    var site = Site.getCurrent();
    var method = site.getCustomPreferenceValue('VisaAcceptance_Secure_Integration_Method');
    var methodValue = (method && method.value) ? method.value : (method || '');
    var dmEnabled = site.getCustomPreferenceValue('VisaAcceptance_DecisionManager') || false;
    var egressMleAlias = site.getCustomPreferenceValue('VisaAcceptance_EgressCertificateAlias');

    var testAction = new URLAction('WebhookNotification-dmNotification', site.ID);
    var fullUrl = URLUtils.https(testAction).toString();
    var standardBaseUrl = fullUrl.substring(0, fullUrl.indexOf('WebhookNotification-dmNotification')).replace(/\/$/, '');

    var egressPublicKey = '';
    try {
        var globalObj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration');
        if (globalObj) {
            egressPublicKey = globalObj.custom.EgressPublicKey || '';
        }
    } catch (e) {}

    var data = {
        config: {
            dmEnabled: dmEnabled,
            secureIntegrationMethod: methodValue,
            egressMleAlias: egressMleAlias,
            egressPublicKey: egressPublicKey,
            standardBaseUrl: standardBaseUrl,
            activeBaseUrl: standardBaseUrl
        },
        subscriptions: {},
        external: [],
        availableProducts: null
    };

    // Fetch the product catalog once when a feature that uses it is enabled, so discovery can query
    // only the fraud product the org has (not probe both DM and FME) and subscribe can reuse it.
    var availableProductIds = null;
    if (data.config.dmEnabled || data.config.secureIntegrationMethod === 'Unified_Checkout') {
        var avail = getAvailableProducts();
        if (!avail.error) {
            data.availableProducts = avail.products;
            availableProductIds = toProductIds(avail.products);
        }
    }

    ['fraudManagement', 'unifiedCheckout'].forEach(function (productId) {
        try {
            var obj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, productId);
            // A record with no WebhookId isn't a real subscription — treat as not subscribed.
            data.subscriptions[productId] = (obj && obj.custom.WebhookId) ? { webhookId: obj.custom.WebhookId, status: obj.custom.Status } : null;
        } catch (e) { data.subscriptions[productId] = null; }
    });

    // Ask Visa Acceptance which webhooks exist per product to (a) reconcile our local record (null it if
    // the stored id is gone) and (b) surface non-managed webhooks as external. Fraud may be under DM or FME.
    var discovery = [
        { key: 'fraudManagement', queryProducts: ['decisionManager', 'fraudManagementEssentials'] },
        { key: 'unifiedCheckout', queryProducts: ['unifiedCheckout'] }
    ];

    try {
        discovery.forEach(function (entry) {
            var entryEnabled = (entry.key === 'fraudManagement')
                ? !!data.config.dmEnabled
                : (data.config.secureIntegrationMethod === 'Unified_Checkout');
            if (!entryEnabled) return;

            var liveWebhooks = {};
            var gotDefinitiveResponse = false;
            entry.queryProducts.forEach(function (queryProductId) {
                // Skip products the org doesn't have — it can't have a subscription for one, so the
                // query is wasted. If the catalog lookup failed (null), probe every configured product.
                if (availableProductIds && availableProductIds.indexOf(queryProductId) === -1) return;
                try {
                    var listResult = webhooks.retrieveWebhooks(queryProductId);
                    if (listResult.error) {
                        Logger.error('External webhook discovery failed for ' + entry.key + ' (' + queryProductId + '): ' + JSON.stringify(listResult.error));
                        return;
                    }
                    if (!Array.isArray(listResult.data)) return;
                    // A successful response (incl. empty list / 404) is authoritative.
                    gotDefinitiveResponse = true;
                    listResult.data.forEach(function (webhook) {
                        liveWebhooks[webhook.webhookId] = webhook;
                    });
                } catch (qe) {
                    // One product's lookup failing must not abort discovery for the rest.
                    Logger.error('getViewData: discovery query threw for ' + entry.key + ' (' + queryProductId + '): ' + (qe && qe.message ? qe.message : qe));
                }
            });

            // (a) Reconcile the BM-managed record against live state, only on an authoritative response.
            if ((entry.key === 'fraudManagement' || entry.key === 'unifiedCheckout') &&
                gotDefinitiveResponse &&
                data.subscriptions[entry.key] && data.subscriptions[entry.key].webhookId) {
                var liveMatch = liveWebhooks[data.subscriptions[entry.key].webhookId];
                if (!liveMatch) {
                    Logger.warn('Local ' + entry.key + ' webhook ' + data.subscriptions[entry.key].webhookId + ' not found at Visa Acceptance for the active merchant; abandoning the stored id so the next sync creates a fresh subscription.');
                    abandonStoredWebhook(entry.key);
                    data.subscriptions[entry.key] = null;
                } else {
                    if (liveMatch.status) {
                        // Sync displayed status so PENDING_REVIEW flips to ACTIVE once approved.
                        data.subscriptions[entry.key].status = liveMatch.status;
                    }
                    // Host changed (sandbox moved): flag for repoint on next sync.
                    var currentHost = webhookHelper.extractHost(data.config.activeBaseUrl);
                    var liveHost = webhookHelper.extractHost(liveMatch.webhookUrl);
                    if (currentHost && liveHost && currentHost !== liveHost) {
                        data.subscriptions[entry.key].hostMismatch = true;
                        data.subscriptions[entry.key].liveUrl = liveMatch.webhookUrl;
                        Logger.warn(entry.key + ' webhook points to host ' + liveHost + ' but storefront host is ' + currentHost + '; will repoint on next sync.');
                    }
                }
            }

            // (b) Surface non-managed webhooks as external.
            Object.keys(liveWebhooks).forEach(function (webhookId) {
                var webhook = liveWebhooks[webhookId];
                var isInternal = false;
                Object.keys(data.subscriptions).forEach(function (key) {
                    if (data.subscriptions[key] && data.subscriptions[key].webhookId === webhookId) isInternal = true;
                });
                if (!isInternal) data.external.push({ productId: entry.key, webhookId: webhookId, url: webhook.webhookUrl });
            });
        });
    } catch (e) { Logger.error('getViewData discovery failed: ' + (e && e.message ? e.message : e)); }
    return data;
}

function syncWithPreferences() {
    var data = getViewData();
    // Reuse the catalog getViewData already fetched so subscribe doesn't re-list it per product.
    var availableProducts = data.availableProducts;
    var results = {};
    var fraud = data.subscriptions.fraudManagement;
    var uc = data.subscriptions.unifiedCheckout;

    var dmWillSubscribe = data.config.dmEnabled && webhookHelper.subscriptionNeedsAction(fraud);
    var ucWillSubscribe = data.config.secureIntegrationMethod === 'Unified_Checkout' && webhookHelper.subscriptionNeedsAction(uc);

    // The signing key is org-scoped, so mint it once per cycle (not per product) and share it.
    var signingKey = (dmWillSubscribe || ucWillSubscribe) ? createSigningKey() : '';

    // Subscribe/repoint/activate when enabled and the subscription needs action; unsubscribe when disabled.
    if (dmWillSubscribe) {
        results.dm = subscribeProduct('fraudManagement', !!(fraud && fraud.hostMismatch), availableProducts, signingKey);
    } else if (!data.config.dmEnabled && fraud) {
        results.dm = unsubscribeProduct('fraudManagement');
    }
    if (ucWillSubscribe) {
        results.uc = subscribeProduct('unifiedCheckout', !!(uc && uc.hostMismatch), availableProducts, signingKey);
    } else if (data.config.secureIntegrationMethod !== 'Unified_Checkout' && uc) {
        results.uc = unsubscribeProduct('unifiedCheckout');
    }
    return results;
}

function updateAdvanced(egressMleAlias, egressPublicKey) {
    var site = Site.getCurrent();

    // Derive the egress key from the .p12 alias being saved; an empty form falls back to the stored alias.
    var effectiveAlias = egressMleAlias || site.getCustomPreferenceValue('VisaAcceptance_EgressCertificateAlias');
    var derivedKey = webhookHelper.deriveEgressCertificateB64(effectiveAlias);
    var keyToUse = derivedKey || egressPublicKey || '';

    // Register the key with KMS before subscribing; only treat it usable if KMS accepts it.
    var egressUploadOk = false;
    if (keyToUse) {
        var egressUpload = webhooks.uploadAsymmetricKey(keyToUse);
        if (egressUpload.error) Logger.error('Failed to upload Egress Public Key: ' + JSON.stringify(egressUpload.error));
        else egressUploadOk = true;
    }

    Transaction.wrap(function () {
        try { site.setCustomPreferenceValue('VisaAcceptance_EgressCertificateAlias', effectiveAlias); } catch(e) { /* pref write is best-effort */ }
        try {
            var globalObj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration') || CustomObjectMgr.createCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration');
            // Persist the egress key only when KMS accepted it; otherwise keep the previous working value.
            if (egressUploadOk) {
                globalObj.custom.EgressPublicKey = keyToUse;
            }
        } catch(e) { /* custom-object access is best-effort */ }
    });

    var results = syncWithPreferences();

    // Surface a KMS upload failure only when a freshly derived key was rejected (a real misconfiguration).
    if (derivedKey && !egressUploadOk) {
        results.egressKey = { success: false, error: 'EGRESS_KEY_UPLOAD_FAILED' };
    }

    return results;
}

exports.retrieveWebhooks = webhooks.retrieveWebhooks;
exports.subscribeFraudManagement = function() { return subscribeProduct('fraudManagement'); };
exports.unsubscribeFraudManagement = function() { return unsubscribeProduct('fraudManagement'); };
exports.subscribeUC = function() { return subscribeProduct('unifiedCheckout'); };
exports.unsubscribeUC = function() { return unsubscribeProduct('unifiedCheckout'); };
exports.getViewData = getViewData;
exports.syncWithPreferences = syncWithPreferences;
exports.updateAdvanced = updateAdvanced;
