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
var Logger = require('dw/system/Logger').getLogger('webhookSubscription');

var CUSTOM_OBJECT_TYPE = 'VisaAcceptanceWebhookSubscription';
var SECURITY_KEY_OBJECT_TYPE = 'VisaAcceptanceWebhookSecurityKey';

/**
 * Get (or create) the org-scoped globalConfiguration record that holds cross-product webhook state
 * (SecurityKey, SecurityKeyId, EgressPublicKey). Call inside a Transaction when writing.
 *
 * @returns {dw.object.CustomObject} the globalConfiguration custom object
 */
function getOrCreateGlobalConfig() {
    return CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration')
        || CustomObjectMgr.createCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration');
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
 * Persist a keyId -> key pair so WebhookNotification can fetch the exact signing key named in a
 * notification's v-c-signature header (keyId). The active keyId is recorded separately on
 * globalConfiguration by ensureSigningKey.
 *
 * @param {string} keyId KMS key id (matches the header's keyId)
 * @param {string} key base64 shared secret
 */
function storeSecurityKeyPair(keyId, key) {
    if (!keyId || !key) return;
    Transaction.wrap(function () {
        var obj = CustomObjectMgr.getCustomObject(SECURITY_KEY_OBJECT_TYPE, keyId)
            || CustomObjectMgr.createCustomObject(SECURITY_KEY_OBJECT_TYPE, keyId);
        obj.custom.Key = key;
    });
}

/**
 * Mint a fresh org signing key in KMS, store it as a keyId -> key pair in VisaAcceptanceWebhookSecurityKey,
 * and record the active keyId on globalConfiguration.SecurityKeyId. The key material itself lives only in
 * VisaAcceptanceWebhookSecurityKey (looked up by keyId at validation time). Prior keyId records are
 * retained so notifications still in Visa Acceptance's retry window keep validating.
 *
 * @returns {boolean} true when a fresh key was minted and stored
 */
function mintAndStoreSigningKey() {
    var keyResult = webhooks.createSecurityKey();
    if (keyResult.error) {
        Logger.error('createSecurityKey failed: ' + JSON.stringify(keyResult.error));
        return false;
    }
    var keyInfo = (keyResult.data && keyResult.data.status === 'SUCCESS') ? keyResult.data.keyInformation : null;
    var keyId = keyInfo ? keyInfo.keyId : '';
    var key = keyInfo ? keyInfo.key : '';
    if (!keyId || !key) {
        Logger.error('mintAndStoreSigningKey: createSecurityKey returned no keyId/key');
        return false;
    }
    storeSecurityKeyPair(keyId, key);
    Transaction.wrap(function () {
        var gc = getOrCreateGlobalConfig();
        gc.custom.SecurityKeyId = keyId;
    });
    return true;
}

/**
 * Ensure a usable signing key exists: reuse the active key when globalConfiguration.SecurityKeyId
 * points to an existing VisaAcceptanceWebhookSecurityKey record, otherwise mint a fresh one.
 * syncWithPreferences always re-keys via mintAndStoreSigningKey; this covers standalone subscribe
 * entry points (exported wrappers) so they avoid an unnecessary KMS call when a valid key exists.
 *
 * @returns {boolean} true when a usable signing key is available
 */
function ensureSigningKey() {
    var globalConfig = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration');
    if (globalConfig && globalConfig.custom.SecurityKeyId
            && CustomObjectMgr.getCustomObject(SECURITY_KEY_OBJECT_TYPE, globalConfig.custom.SecurityKeyId)) {
        return true;
    }
    return mintAndStoreSigningKey();
}

/**
 * Ensure the UC egress public key is registered with KMS. UC webhooks use Response MLE, so Visa
 * Acceptance needs the egress public key to encrypt them. Reuses the stored key; otherwise derives it
 * from the .p12 alias and registers it, persisting only when KMS accepts it.
 *
 * @returns {boolean} true when an egress public key is available/registered
 */
function ensureEgressPublicKey() {
    var egressPublicKey = '';
    try {
        var globalObj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration');
        if (globalObj) egressPublicKey = globalObj.custom.EgressPublicKey || '';
    } catch (e) {}
    if (egressPublicKey) return true;

    var egressAlias = Site.getCurrent().getCustomPreferenceValue('VisaAcceptance_EgressCertificateAlias');
    var derivedEgressKey = webhookHelper.deriveEgressCertificateB64(egressAlias);
    var derivedUploadOk = false;
    if (derivedEgressKey) {
        var derivedUpload = webhooks.uploadAsymmetricKey(derivedEgressKey);
        if (derivedUpload.error) Logger.error('ensureEgressPublicKey: failed to upload derived egress public key: ' + JSON.stringify(derivedUpload.error));
        else derivedUploadOk = true;
    }
    if (!derivedUploadOk) {
        Logger.error('ensureEgressPublicKey: subscribe blocked — could not derive/register an egress public key from alias "' + egressAlias + '". Verify the RSA .p12 is imported under Private Keys and Certificates.');
        return false;
    }
    Transaction.wrap(function () {
        getOrCreateGlobalConfig().custom.EgressPublicKey = derivedEgressKey;
    });
    return true;
}

/**
 * Resolve the fraud product (decisionManager / fraudManagementEssentials) to subscribe. The stored
 * Product on the custom object is the source of truth — when set, it is used as-is and the products
 * endpoint is NOT called. Only the first time (nothing stored) is the products endpoint queried once to
 * pick whichever fraud product the MID has.
 *
 * @param {Object} config the fraudManagement WEBHOOK_CONFIGS entry
 * @param {string} storedProduct product id previously persisted on the custom object ('' if none)
 * @returns {Object} { product: (Object|null), error: (string|null) } — product is a config.products entry
 */
function resolveFraudProduct(config, storedProduct) {
    if (storedProduct) {
        for (var s = 0; s < config.products.length; s++) {
            if (config.products[s].productId === storedProduct) return { product: config.products[s], error: null };
        }
    }
    // First-time determination: ask Visa Acceptance which fraud product the MID has.
    var avail = getAvailableProducts();
    if (avail.error) {
        Logger.error('resolveFraudProduct: product lookup failed: ' + JSON.stringify(avail.error));
        return { product: null, error: 'API_ERROR' };
    }
    var availableIds = toProductIds(avail.products);
    for (var c = 0; c < config.products.length; c++) {
        if (availableIds.indexOf(config.products[c].productId) !== -1) return { product: config.products[c], error: null };
    }
    Logger.error('resolveFraudProduct: NO_FRAUD_PRODUCT — neither decisionManager nor fraudManagementEssentials is available for the MID [' + availableIds.join(', ') + '].');
    return { product: null, error: 'NO_FRAUD_PRODUCT' };
}

/**
 * Delete the subscription occupying each of THESE product slots at Visa Acceptance, so the recreate that
 * follows can succeed. Scope is strictly the products we are about to (re)create for — a fraud subscribe
 * clears only the fraud product, a UC subscribe clears only unifiedCheckout + alternativePaymentMethods;
 * webhooks for any OTHER product are never touched. Visa allows a single subscription per product per
 * Merchant ID, so whatever sits in the target slot (our stale id, or an untracked one) has to go first or
 * the create returns 400 already-exists.
 *
 * @param {Array} products subscription products ({ productId, eventTypes }) whose slots to clear
 * @param {string} trackedWebhookId locally stored webhook id to also delete ('' if none)
 */
function deleteExistingSubscriptions(products, trackedWebhookId) {
    var idsToDelete = [];
    if (trackedWebhookId) idsToDelete.push(trackedWebhookId);
    for (var p = 0; p < products.length; p++) {
        var listResult = webhooks.retrieveWebhooks(products[p].productId);
        if (!listResult.error && Array.isArray(listResult.data)) {
            for (var i = 0; i < listResult.data.length; i++) {
                var wh = listResult.data[i];
                if (wh && wh.webhookId && idsToDelete.indexOf(wh.webhookId) === -1) {
                    idsToDelete.push(wh.webhookId);
                }
            }
        }
    }
    for (var d = 0; d < idsToDelete.length; d++) {
        var delResult = webhooks.deleteSubscription(idsToDelete[d]);
        // 404 = already gone; anything else is logged but does not block the recreate.
        if (delResult.error && parseInt(delResult.error, 10) !== 404) {
            Logger.error('deleteExistingSubscriptions: delete of webhook ' + idsToDelete[d] + ' failed: ' + JSON.stringify(delResult.error));
        }
    }
}

/**
 * Create the subscription, recovering from a 400 "Record already exists". The target-slot cleanup runs
 * before this; if the create still conflicts, a subscription reappeared in the product slot between our
 * list and create (a race). Clears the target slot again and retries the create exactly once. Never recurses.
 *
 * @param {Object} subConfig per-call subscription config (name, description, products)
 * @param {string} webhookUrl target webhook URL
 * @returns {Object} the create result { data, error } (from the retry when a conflict was recovered)
 */
function createSubscriptionWithConflictRetry(subConfig, webhookUrl) {
    var createResult = webhooks.createSubscription(subConfig, webhookUrl);
    if (createResult.error && parseInt(createResult.error, 10) === 400) {
        var body = (typeof createResult.data === 'string') ? createResult.data : JSON.stringify(createResult.data || '');
        if (/already\s*exist/i.test(body)) {
            Logger.warn('createSubscriptionWithConflictRetry: create returned 400 already-exists; clearing this product slot and retrying once.');
            deleteExistingSubscriptions(subConfig.products, '');
            createResult = webhooks.createSubscription(subConfig, webhookUrl);
        }
    }
    return createResult;
}

/**
 * Whether the given webhook id is still present at Visa Acceptance for any of the products. Used to skip
 * a delete/recreate when the tracked subscription already exists in EBC.
 *
 * @param {Array} products subscription products ({ productId, eventTypes })
 * @param {string} webhookId the tracked webhook id to look for
 * @returns {boolean} true when a webhook with that id is returned for one of the products
 */
function subscriptionPresent(products, webhookId) {
    for (var p = 0; p < products.length; p++) {
        var listResult = webhooks.retrieveWebhooks(products[p].productId);
        if (!listResult.error && Array.isArray(listResult.data)) {
            for (var i = 0; i < listResult.data.length; i++) {
                if (listResult.data[i] && listResult.data[i].webhookId === webhookId) return true;
            }
        }
    }
    return false;
}

/**
 * Subscribe a BM-managed product. If our tracked webhook id is still present at Visa Acceptance the
 * product is already subscribed, so we skip (no delete, no recreate). Otherwise: delete any existing
 * subscription(s), (re)use the org signing key, create a fresh subscription, persist
 * { WebhookId, WebhookUrl, Status, Product }, then force it ACTIVE.
 *
 * @param {string} configId WEBHOOK_CONFIGS key ('fraudManagement' | 'unifiedCheckout')
 * @param {boolean} [keyReady] true when the caller already minted/verified the signing key for this
 *   flow (syncWithPreferences does this once before both products); skips the per-product key check so
 *   only a single /kms/egress/v2/keys-sym call is made per Sync. Standalone callers omit it.
 * @returns {Object} subscribe result { success, error, webhookId, status, product }
 */
function subscribeProduct(configId, keyReady) {
    var config = WEBHOOK_CONFIGS[configId];
    var site = Site.getCurrent();

    var existingObj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId);
    var existingWebhookId = (existingObj && existingObj.custom.WebhookId) ? existingObj.custom.WebhookId : '';
    var storedProduct = (existingObj && existingObj.custom.Product) ? existingObj.custom.Product : '';

    // UC needs its egress public key registered before Visa Acceptance can encrypt the notifications.
    if (configId === 'unifiedCheckout' && !ensureEgressPublicKey()) {
        return { success: false, error: 'EGRESS_KEY_REQUIRED' };
    }

    // Resolve the product(s) to subscribe. fraudManagement is one product (from the stored value or a
    // one-time lookup); UC is a fixed bundle (unifiedCheckout + alternativePaymentMethods).
    var targetProduct = '';
    var subConfig;
    if (configId === 'fraudManagement') {
        var resolved = resolveFraudProduct(config, storedProduct);
        if (resolved.error) return { success: false, error: resolved.error };
        targetProduct = resolved.product.productId;
        subConfig = { name: config.name, description: config.description, products: [resolved.product] };
    } else {
        subConfig = { name: config.name, description: config.description, products: config.products };
    }

    var webhookUrl = URLUtils.https(new URLAction(config.notificationEndpoint, site.ID)).toString();

    // If our tracked webhook id is still present at Visa Acceptance, the product is already subscribed —
    // skip. We do NOT delete and recreate a webhook that already exists in EBC.
    if (existingWebhookId && subscriptionPresent(subConfig.products, existingWebhookId)) {
        Logger.info('subscribeProduct: ' + configId + ' webhook ' + existingWebhookId + ' already present at Visa Acceptance; skipping.');
        return { success: true, webhookId: existingWebhookId, status: (existingObj.custom.Status || ''), product: storedProduct, alreadyExists: true };
    }

    // Not present in EBC (deleted there, or a MID change): clear only THIS subscription's product slot(s)
    // at Visa Acceptance — the fraud product for a fraud subscribe, unifiedCheckout + alternativePaymentMethods
    // for a UC subscribe — then clear the stale local id, so the create below starts from a clean slot.
    // Webhooks for other products are left untouched.
    deleteExistingSubscriptions(subConfig.products, existingWebhookId);
    if (existingWebhookId) {
        Transaction.wrap(function () {
            var obj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId);
            if (obj) { obj.custom.WebhookId = ''; obj.custom.Status = ''; }
        });
    }

    // Ensure the org signing key exists and is stored as a keyId -> key pair before creating the webhook.
    // syncWithPreferences mints it once before both products (keyReady), so skip the per-product check to
    // avoid a redundant second /kms/egress/v2/keys-sym call; standalone callers still ensure it here.
    if (!keyReady && !ensureSigningKey()) return { success: false, error: 'KEY_ERROR' };

    // Create the subscription (recovering once from a 400 already-exists if delete-first missed one).
    var createResult = createSubscriptionWithConflictRetry(subConfig, webhookUrl);
    if (createResult.error || !createResult.data || !createResult.data.webhookId) {
        var msg = (typeof createResult.data === 'string') ? createResult.data : JSON.stringify(createResult.data || createResult.error);
        Logger.error('subscribeProduct: createSubscription failed for ' + configId + ' (' + targetProduct + '): ' + msg);
        return { success: false, error: 'API_ERROR' };
    }
    var webhookId = createResult.data.webhookId;
    var createdStatus = createResult.data.status || '';

    // Save the new subscription state, including the product it was created for.
    Transaction.wrap(function () {
        var obj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId) || CustomObjectMgr.createCustomObject(CUSTOM_OBJECT_TYPE, configId);
        obj.custom.WebhookId = webhookId;
        obj.custom.WebhookUrl = webhookUrl;
        obj.custom.Status = createdStatus || '';
        obj.custom.Product = targetProduct;
    });

    // Promote the freshly-created webhook to ACTIVE. Its id came back from createSubscription above, so it
    // is the webhook we just created. PENDING_REVIEW / RESEND / BLOCKED are gateway-owned states Visa
    // Acceptance transitions on its own (and rejects a manual update for), so we only PUT status=ACTIVE for
    // a state we can change (INACTIVE / SUSPENDED / unknown); a PUT failure is non-fatal.
    var GATEWAY_MANAGED_STATUSES = ['PENDING_REVIEW', 'RESEND', 'BLOCKED'];
    var finalStatus = createdStatus || '';
    if (finalStatus !== 'ACTIVE' && GATEWAY_MANAGED_STATUSES.indexOf(finalStatus) === -1) {
        var activation = webhooks.activateSubscription(webhookId);
        if (activation.error) {
            Logger.warn('subscribeProduct: could not force ACTIVE for ' + configId + ' (' + webhookId + '); keeping status "' + finalStatus + '". Detail: ' + JSON.stringify(activation.error));
        } else {
            finalStatus = (activation.data && activation.data.status) ? activation.data.status : 'ACTIVE';
            Transaction.wrap(function () {
                var obj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId);
                if (obj) obj.custom.Status = finalStatus;
            });
        }
    }
    if (!finalStatus) finalStatus = 'PENDING_REVIEW';

    return { success: true, webhookId: webhookId, status: finalStatus, product: targetProduct, pendingReview: finalStatus !== 'ACTIVE' };
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
    if (!deleteResult.error || parseInt(deleteResult.error, 10) === 404) {
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
 * different org after a MID change, where we can neither activate nor delete it). The SecurityKey and
 * Product are left intact until the recreate overwrites them.
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
        subscriptions: {}
    };

    ['fraudManagement', 'unifiedCheckout'].forEach(function (productId) {
        try {
            var obj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, productId);
            // A record with no WebhookId isn't a real subscription — treat as not subscribed.
            data.subscriptions[productId] = (obj && obj.custom.WebhookId)
                ? { webhookId: obj.custom.WebhookId, status: obj.custom.Status, product: obj.custom.Product || '' }
                : null;
        } catch (e) { data.subscriptions[productId] = null; }
    });

    // Ask Visa Acceptance which webhooks exist per product to reconcile our local record: null it if the
    // stored id is gone, else refresh its status. Any untracked webhook is left for the next Sync to delete
    // and recreate (see deleteExistingSubscriptions), so it is not surfaced here. Fraud may be under DM or
    // FME; for a tracked fraud subscription query only its stored product, else probe both.
    var fraudRecord = data.subscriptions.fraudManagement;
    var fraudQueryProducts = (fraudRecord && fraudRecord.product)
        ? [fraudRecord.product]
        : ['decisionManager', 'fraudManagementEssentials'];
    // UC is a two-product bundle (unifiedCheckout + alternativePaymentMethods), so query BOTH: the tracked
    // webhook must be present under each. Checking only unifiedCheckout would miss an APM-side problem and
    // could wrongly abandon a subscription whose id is returned under alternativePaymentMethods.
    var discovery = [
        { key: 'fraudManagement', queryProducts: fraudQueryProducts },
        { key: 'unifiedCheckout', queryProducts: ['unifiedCheckout', 'alternativePaymentMethods'] }
    ];

    try {
        discovery.forEach(function (entry) {
            var entryEnabled = (entry.key === 'fraudManagement')
                ? !!data.config.dmEnabled
                : (data.config.secureIntegrationMethod === 'Unified_Checkout');
            if (!entryEnabled) return;

            var trackedId = (data.subscriptions[entry.key] && data.subscriptions[entry.key].webhookId)
                ? data.subscriptions[entry.key].webhookId : '';
            var liveWebhooks = {};
            var trackedProductIds = {};
            var gotDefinitiveResponse = false;
            entry.queryProducts.forEach(function (queryProductId) {
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
                        // Record which products our tracked subscription actually covers, from both signals:
                        // the product this query was for, plus any productIds the webhook itself reports.
                        if (trackedId && webhook.webhookId === trackedId) {
                            trackedProductIds[queryProductId] = true;
                            if (Array.isArray(webhook.products)) {
                                webhook.products.forEach(function (prod) {
                                    if (prod && prod.productId) trackedProductIds[prod.productId] = true;
                                });
                            }
                        }
                    });
                } catch (qe) {
                    // One product's lookup failing must not abort discovery for the rest.
                    Logger.error('getViewData: discovery query threw for ' + entry.key + ' (' + queryProductId + '): ' + (qe && qe.message ? qe.message : qe));
                }
            });

            // Reconcile the BM-managed record against live state, only on an authoritative response.
            if (gotDefinitiveResponse && trackedId) {
                var liveMatch = liveWebhooks[trackedId];
                if (!liveMatch) {
                    Logger.warn('Local ' + entry.key + ' webhook ' + trackedId + ' not found at Visa Acceptance for the active merchant; abandoning the stored id so the next sync creates a fresh subscription.');
                    abandonStoredWebhook(entry.key);
                    data.subscriptions[entry.key] = null;
                } else if (entry.key === 'unifiedCheckout'
                        && !(trackedProductIds.unifiedCheckout && trackedProductIds.alternativePaymentMethods)) {
                    // UC is a bundle: it must cover BOTH unifiedCheckout AND alternativePaymentMethods. A
                    // subscription missing one is incomplete (the UC order results or the APM
                    // payments.payments.updated notifications would not be delivered), so abandon it and let
                    // the next sync recreate the full bundle.
                    Logger.warn('UC webhook ' + trackedId + ' does not cover both bundle products (covers: [' + Object.keys(trackedProductIds).join(', ') + ']); abandoning so the next sync recreates the full unifiedCheckout + alternativePaymentMethods subscription.');
                    abandonStoredWebhook(entry.key);
                    data.subscriptions[entry.key] = null;
                } else if (liveMatch.status) {
                    // Sync displayed status so PENDING_REVIEW flips to ACTIVE once approved.
                    data.subscriptions[entry.key].status = liveMatch.status;
                }
            }
        });
    } catch (e) { Logger.error('getViewData discovery failed: ' + (e && e.message ? e.message : e)); }
    return data;
}

/**
 * Sync every BM-managed webhook to the current site preferences: (re)create the subscription when its
 * feature is enabled, remove it when disabled. Each subscribe follows the delete-then-recreate flow.
 *
 * @returns {Object} per-product results keyed by 'dm' / 'uc'
 */
function syncWithPreferences() {
    var site = Site.getCurrent();
    var method = site.getCustomPreferenceValue('VisaAcceptance_Secure_Integration_Method');
    var methodValue = (method && method.value) ? method.value : (method || '');
    var dmEnabled = site.getCustomPreferenceValue('VisaAcceptance_DecisionManager') || false;
    var results = {};

    // Re-key ONCE per creation flow, before both products: the signing key is org/MID-scoped and signs
    // every webhook for the MID, so a single /kms/egress/v2/keys-sym call covers both DM and UC. Minting
    // here (rather than inside each subscribeProduct) is what keeps it to one call per Sync, and a fresh
    // mint per Sync also picks up a Merchant ID change automatically. keyReady is passed to each subscribe
    // so it skips its own key check.
    var keyReady = false;
    if (dmEnabled || methodValue === 'Unified_Checkout') {
        keyReady = mintAndStoreSigningKey();
    }

    if (dmEnabled) {
        results.dm = subscribeProduct('fraudManagement', keyReady);
    } else if (CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, 'fraudManagement')) {
        results.dm = unsubscribeProduct('fraudManagement');
    }

    if (methodValue === 'Unified_Checkout') {
        results.uc = subscribeProduct('unifiedCheckout', keyReady);
    } else if (CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, 'unifiedCheckout')) {
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
            // Persist the egress key only when KMS accepted it; otherwise keep the previous working value.
            if (egressUploadOk) {
                getOrCreateGlobalConfig().custom.EgressPublicKey = keyToUse;
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
