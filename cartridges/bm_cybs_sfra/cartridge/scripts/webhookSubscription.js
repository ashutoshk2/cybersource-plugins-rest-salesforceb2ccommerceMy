'use strict';

// NOTE: This module relies on the SFCC LocalServiceRegistry-backed apiClient.callApi
// invoking its callback synchronously (inline, before callApi returns). All control
// flow here — checking webhookId/securityKey/error variables after a callApi call —
// depends on that contract. If the underlying transport ever becomes truly async,
// every subscribe/activate/delete sequence below must be reworked into continuations.

var configObject = require('int_cybs_sfra_base/cartridge/configuration/index');
var apiClient = require('int_cybs_sfra_base/cartridge/apiClient/ApiClient');
var MerchantConfig = require('int_cybs_sfra_base/cartridge/apiClient/merchantConfig');
var Transaction = require('dw/system/Transaction');
var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var URLUtils = require('dw/web/URLUtils');
var URLAction = require('dw/web/URLAction');
var Site = require('dw/system/Site');
var Logger = require('dw/system/Logger').getLogger('cybs_webhooks', 'webhookSubscription');

var merchantId = new MerchantConfig(configObject).getMerchantID();
apiClient.instance.setConfiguration(configObject);

var CUSTOM_OBJECT_TYPE = 'CyberSource Webhook Subscription';

var WEBHOOK_CONFIGS = {
    fraudManagement: {
        name: 'Fraud Management',
        notificationEndpoint: 'WebhookNotification-dmNotification',
        products: [
            {
                productId: 'decisionManager',
                eventTypes: ['risk.casemanagement.decision.accept', 'risk.casemanagement.decision.reject']
            },
            {
                productId: 'fraudManagementEssentials',
                eventTypes: ['risk.profile.decision.review', 'risk.casemanagement.decision.accept', 'risk.casemanagement.decision.reject']
            }
        ]
    },
    unifiedCheckout: {
        name: 'UC Webhook Events',
        description: 'UC Events Simulation',
        notificationEndpoint: 'WebhookNotification-paymentNotification',
        products: [{ productId: 'unifiedCheckout', eventTypes: ['uc.orders.transactionresults'] }]
    }
};

function retrieveWebhooks(productId, callback) {
    var queryParams = { organizationId: merchantId, productId: productId };
    apiClient.instance.callApi('/notification-subscriptions/v2/webhooks', 'GET', {}, queryParams, {}, {}, null, [], ['application/json;charset=utf-8'], ['application/json;charset=utf-8'], {}, function(data, error, response) {
        // dw.svc.Result has NO `statusCode` property — accessing it throws a ReferenceError, even
        // on the success path. The HTTP status is delivered as the numeric `error` arg
        // (Result.error). A 404 means "no subscriptions for this product yet" — treat it as an
        // empty list, not an error.
        if (error === 404) {
            if (callback) callback([], null, response);
        } else {
            if (callback) callback(data, error, response);
        }
    });
}

function createSecurityKey(callback) {
    var postBody = {
        clientRequestAction: 'CREATE',
        keyInformation: { provider: 'nrtd', tenant: merchantId, keyType: 'sharedSecret', organizationId: merchantId }
    };
    apiClient.instance.callApi('/kms/egress/v2/keys-sym', 'POST', {}, {}, {}, {}, postBody, [], ['application/json;charset=utf-8'], ['application/hal+json;charset=utf-8'], {}, callback);
}


// Register the merchant's egress public CERTIFICATE with CyberSource KMS so it can encrypt
// Response-MLE webhooks. Per the authoritative "Unified Checkout Webhook implementation" wiki
// (CyPse/3489185269, Step 3), the /kms/egress/v2/keys-asym STORE payload is:
//   clientRequestAction: 'STORE', keyInformation: { provider: <merchantId>, tenant: 'nrtd',
//   keyType: 'publickey', organizationId: <merchantId>, pub: <base64-DER X.509 certificate> }
// NOTE: for the ASYM key provider=organizationId and tenant='nrtd' (the SYM signature key in
// createSecurityKey has them swapped — provider='nrtd', tenant=merchantId — which is correct
// per the same wiki and intentional). `pub` is the raw base64 of the DER certificate (the
// MID/leaf public cert), NOT a PEM block and NOT a SubjectPublicKeyInfo.
function uploadAsymmetricKey(pubCertB64, callback) {
    if (!pubCertB64) {
        if (callback) callback({ status: 'SKIPPED' }, null);
        return;
    }
    var cleanCert = String(pubCertB64).replace(/\s+/g, '');
    var postBody = {
        clientRequestAction: 'STORE',
        keyInformation: {
            provider: merchantId,
            tenant: 'nrtd',
            keyType: 'publickey',
            organizationId: merchantId,
            pub: cleanCert
        }
    };
    apiClient.instance.callApi('/kms/egress/v2/keys-asym', 'POST', {}, {}, {}, {}, postBody, [], ['application/json;charset=utf-8'], ['application/hal+json;charset=utf-8'], {}, callback);
}



/**
 * Derive the egress MLE public CERTIFICATE from the .p12 already imported in BM
 * "Private Keys and Certificates" under the given keystore alias — the SAME alias the
 * webhook decryption path uses (new KeyRef(alias) in WebhookNotification.js). Returns the
 * raw base64-encoded DER of the leaf X.509 certificate (NOT PEM-wrapped), which is exactly
 * the value the CyberSource /kms/egress/v2/keys-asym STORE `pub` field expects per the
 * "Unified Checkout Webhook implementation" wiki (Step 2: extract the public certificate,
 * Base-64 encoded; Step 3: STORE it). Returns '' on any failure so callers can fall back.
 *
 * Using getCertificate(KeyRef) (the cert bound to the private-key entry) guarantees the
 * registered public cert pairs with the private key WebhookNotification uses to decrypt —
 * the "No key mismatch errors" path the wiki recommends for EBC-generated P12s.
 *
 * NOTE: the egress .p12 MUST be an RSA keypair — webhook Response MLE is pinned to
 * RSA-OAEP-256 (WebhookNotification.decryptMLEPayload). dw.crypto exposes no subject-key
 * algorithm, so an EC .p12 cannot be detected here; the sandbox round-trip is the backstop.
 *
 * @param {string} alias keystore alias of the merchant .p12 (private key entry)
 * @returns {string} base64-DER X.509 certificate, or '' on failure
 */
function deriveEgressCertificateB64(alias) {
    if (!alias) {
        Logger.error('deriveEgressCertificateB64: no egress alias configured.');
        return '';
    }
    try {
        var CertificateUtils = require('dw/crypto/CertificateUtils');
        var KeyRef = require('dw/crypto/KeyRef');
        // getCertificate(KeyRef) returns the leaf X509Certificate bound to the .p12 private-key
        // entry, so the registered cert is by construction the pair of the decryption key.
        var cert = CertificateUtils.getCertificate(new KeyRef(alias));
        if (!cert) {
            Logger.error('deriveEgressCertificateB64: no certificate for alias "' + alias + '".');
            return '';
        }
        // base64-encoded DER of the X.509 certificate (the wiki `pub` value, e.g. "MIIC...").
        var b64 = CertificateUtils.getEncodedCertificate(cert);
        var clean = b64 ? String(b64).replace(/\s+/g, '') : '';
        if (!clean || !/^[A-Za-z0-9+/=]+$/.test(clean)) {
            Logger.error('deriveEgressCertificateB64: getEncodedCertificate returned empty/non-base64 for alias "' + alias + '".');
            return '';
        }
        // Log the leaf cert identity so an operator can confirm the expected .p12 is bound to the alias.
        try {
            Logger.info('deriveEgressCertificateB64: derived egress certificate from alias "' + alias + '" (subject=' + cert.getSubjectDN() + ', serial=' + cert.getSerialNumber() + ', b64len=' + clean.length + ').');
        } catch (logErr) { /* identity logging is best-effort */ }
        return clean;
    } catch (e) {
        Logger.error('deriveEgressCertificateB64 failed for alias "' + alias + '": ' + ((e && e.message) || e) + '. Verify the RSA .p12 is imported under Administration > Operations > Private Keys and Certificates with this exact alias.');
        return '';
    }
}


function createSubscription(config, webhookUrl, callback) {
    var postBody = {
        name: config.name,
        description: config.description || ('CyberSource Webhook for ' + config.name),
        organizationId: merchantId,
        webhookUrl: webhookUrl,
        healthCheckUrl: webhookUrl,
        notificationScope: 'SELF',
        products: config.products,
        retryPolicy: {
            algorithm: 'ARITHMETIC',
            firstRetry: 1,
            interval: 1,
            numberOfRetries: 3,
            deactivateFlag: true,
            repeatSequenceCount: 0,
            repeatSequenceWaitTime: 0
        },
        securityPolicy: {
            securityType: 'key',
            proxyType: 'external'
        }
    };
    apiClient.instance.callApi('/notification-subscriptions/v2/webhooks', 'POST', {}, {}, {}, {}, postBody, [], ['application/json;charset=utf-8'], ['application/json;charset=utf-8'], {}, callback);
}

function activateSubscription(webhookId, callback) {
    var postBody = { status: 'ACTIVE' };
    apiClient.instance.callApi('/notification-subscriptions/v2/webhooks/' + webhookId + '/status', 'PUT', {}, {}, {}, {}, postBody, [], ['application/json;charset=utf-8'], ['application/json;charset=utf-8'], {}, callback);
}

function deleteSubscription(webhookId, callback) {
    apiClient.instance.callApi('/notification-subscriptions/v2/webhooks/{webhookId}', 'DELETE', { webhookId: webhookId }, {}, {}, {}, null, [], ['application/json;charset=utf-8'], ['application/json;charset=utf-8'], {}, callback);
}

/**
 * Compare two event-type lists as unordered sets.
 *
 * @param {Array} a first event-type list
 * @param {Array} b second event-type list
 * @returns {boolean} true when both lists contain exactly the same event types
 */
function eventTypesMatch(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        return false;
    }
    for (var i = 0; i < a.length; i++) {
        var found = false;
        for (var j = 0; j < b.length; j++) {
            if (a[i] === b[j]) { found = true; break; }
        }
        if (!found) return false;
    }
    return true;
}

/**
 * Create a webhook subscription, recovering from the CyberSource 400 "Record already exists"
 * conflict. That 400 occurs when a subscription already exists at CyberSource for this
 * product/event but is no longer tracked locally (the local custom object was lost, or its
 * WebhookUrl changed so the activate-existing path in subscribeProduct was skipped). Because a
 * webhook's HMAC shared secret is only returned at creation time and cannot be recovered, the
 * orphaned remote subscription is NOT silently adopted (which would leave us unable to validate
 * inbound signatures) — every webhook matching the SAME product and event is deleted and a fresh
 * one is created with the security key the caller just generated. The caller maps the returned
 * webhookId via subscribeProduct's normal activate-and-persist path.
 *
 * Conflict detection uses the "already exists" response body together with the HTTP status. Per
 * ApiClient, the error callback is (errorMessageString, error, response) where `error` is the
 * dw.svc Result.error (the numeric HTTP status). Never read response.statusCode — dw.svc.Result
 * has no such property and accessing it throws a ReferenceError.
 *
 * @param {Object} subConfig per-call subscription config (name, description, products)
 * @param {string} webhookUrl target webhook URL
 * @param {string} productId CyberSource product id to reconcile against (e.g. 'unifiedCheckout', 'decisionManager')
 * @returns {Object} object of shape { webhookId: string, status: string, error: string }
 */
function createSubscriptionWithRecovery(subConfig, webhookUrl, productId) {
    var result = { webhookId: '', status: '', error: null };
    var conflict = false;

    createSubscription(subConfig, webhookUrl, function (data, error, response) {
        if (!error && data && data.webhookId) {
            result.webhookId = data.webhookId;
            result.status = data.status || '';
        } else if (error) {
            // On error, `data` is the response body text (Result.errorMessage) and `error` is the
            // numeric HTTP status (Result.error). Never read response.statusCode — dw.svc.Result
            // has no such property and accessing it throws a ReferenceError.
            var msg = (typeof data === 'string') ? data : JSON.stringify(data || error);
            // Require both the 400 status and the distinctive duplicate message so recovery only
            // runs on a real "already exists".
            if (error === 400 && /already\s*exist/i.test(msg)) {
                conflict = true;
            } else {
                Logger.error('createSubscription failed for ' + productId + ': ' + msg);
                result.error = 'API_ERROR';
            }
        }
    });

    if (result.webhookId || result.error) return result;
    if (!conflict) { result.error = 'API_ERROR'; return result; }

    // A subscription already exists remotely for this product+event but is untracked locally.
    // retrieveWebhooks is product-scoped (it queries by productId), so every returned entry is
    // already for this product; select the one(s) whose event types match what we are creating.
    Logger.warn('createSubscriptionWithRecovery: ' + productId + ' already exists at CyberSource but is untracked locally; deleting the matching product+event subscription and recreating to restore a known security key.');
    var targetEvents = (subConfig.products && subConfig.products[0] && subConfig.products[0].eventTypes) || [];
    var idsToDelete = [];
    retrieveWebhooks(productId, function (listData, listErr) {
        if (listErr) {
            Logger.error('createSubscriptionWithRecovery: retrieveWebhooks failed for ' + productId + ': ' + JSON.stringify(listErr));
            return;
        }
        if (!Array.isArray(listData) || !listData.length) return;
        for (var i = 0; i < listData.length; i++) {
            var wh = listData[i];
            if (!wh || !wh.webhookId) continue; // eslint-disable-line no-continue
            var whEvents = [];
            if (Array.isArray(wh.products)) {
                for (var p = 0; p < wh.products.length; p++) {
                    if (wh.products[p] && wh.products[p].productId === productId && Array.isArray(wh.products[p].eventTypes)) {
                        whEvents = wh.products[p].eventTypes;
                        break;
                    }
                }
            }
            if (eventTypesMatch(whEvents, targetEvents)) idsToDelete.push(wh.webhookId);
        }
        // The query is already product-scoped, so a single returned webhook is the conflict even
        // when the response omits per-product event types — fall back to deleting that one.
        if (!idsToDelete.length && listData.length === 1 && listData[0].webhookId) {
            idsToDelete.push(listData[0].webhookId);
        }
    });

    if (!idsToDelete.length) {
        Logger.error('createSubscriptionWithRecovery: could not unambiguously locate the conflicting ' + productId + ' webhook to delete; manual cleanup required in EBC.');
        result.error = 'ALREADY_EXISTS';
        return result;
    }

    // deleteSubscription invokes its callback synchronously (see the module-level contract note);
    // a named helper keeps the per-id delete out of the loop body (no closure over the loop var).
    var deletedAny = false;
    function deleteWebhook(existingId) {
        var ok = false;
        deleteSubscription(existingId, function (delData, delError) {
            if (delError) {
                Logger.error('createSubscriptionWithRecovery: delete of existing ' + productId + ' webhook ' + existingId + ' failed: ' + JSON.stringify(delError));
            } else {
                ok = true;
            }
        });
        return ok;
    }
    for (var d = 0; d < idsToDelete.length; d++) {
        if (deleteWebhook(idsToDelete[d])) deletedAny = true;
    }
    if (!deletedAny) { result.error = 'ALREADY_EXISTS'; return result; }

    createSubscription(subConfig, webhookUrl, function (data, error) {
        if (!error && data && data.webhookId) {
            result.webhookId = data.webhookId;
            result.status = data.status || '';
        } else {
            // Delete succeeded but recreate failed: the product currently has NO webhook. Surface a
            // distinct error and warn so the operator knows a re-run is required to restore it.
            Logger.warn('createSubscriptionWithRecovery: recreate after delete failed for ' + productId + ' — the product now has NO webhook; re-run subscribe to restore it. ' + JSON.stringify(error || data));
            result.error = 'RECREATE_FAILED_AFTER_DELETE';
        }
    });
    return result;
}

function subscribeProduct(configId, forceRecreate) {
    var config = WEBHOOK_CONFIGS[configId];
    var site = Site.getCurrent();

    var webhookBaseUrl = '';
    var egressPublicKey = '';
    try {
        var globalObj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration');
        if (globalObj) {
            webhookBaseUrl = globalObj.custom.BaseUrl;
            egressPublicKey = globalObj.custom.EgressPublicKey || '';
        }
    } catch (e) {}

    // UC webhook payload is delivered with Response MLE (Asymmetric encryption); CyberSource
    // must hold the egress public key to encrypt it, or the webhook is broken-on-arrival.
    
    // If no key is stored yet (fresh merchant, or never ran "Update Advanced Settings"), derive
    // it from the egress .p12 keystore alias and register it with KMS now. Only proceed if KMS
    // accepts it, so we never subscribe UC with a key that isn't actually in KMS.
    if (configId === 'unifiedCheckout' && !egressPublicKey) {
        // Read the alias from the committed site preference (not the module-cached configObject),
        // so an alias the merchant just changed in the same updateAdvanced request is honored.
        var egressAlias = site.getCustomPreferenceValue('VisaAcceptance_EgressCertificateAlias') || 'VisaAcceptance_MLE_Egress_Private_Key';
        var derivedEgressKey = deriveEgressCertificateB64(egressAlias);
        var derivedUploadOk = false;
        if (derivedEgressKey) {
            uploadAsymmetricKey(derivedEgressKey, function (data, error) {
                if (error) Logger.error('subscribeProduct: failed to upload derived egress public key: ' + JSON.stringify(error));
                else derivedUploadOk = true;
            });
        }
        if (derivedUploadOk) {
            egressPublicKey = derivedEgressKey;
            // Separate, sequential transaction from the subscription-record persistence below.
            Transaction.wrap(function () {
                var g = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration') || CustomObjectMgr.createCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration');
                g.custom.EgressPublicKey = egressPublicKey;
            });
        } else {
            Logger.error('subscribeProduct: UC subscribe blocked — could not derive/register an egress public key from alias "' + egressAlias + '". Verify the RSA .p12 is imported under Private Keys and Certificates.');
            return { success: false, error: 'EGRESS_KEY_REQUIRED' };
        }
    }
    

    var webhookUrl = webhookBaseUrl ? (webhookBaseUrl.replace(/\/$/, '') + '/' + config.notificationEndpoint) : URLUtils.https(new URLAction(config.notificationEndpoint, site.ID)).toString();

    var existingObj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId);
    
    // When the local record points at a webhook that was deleted directly in EBC, the
    // re-activation call comes back 404. In that case the record is stale: fall through
    // and create a fresh subscription rather than leaving the merchant unable to
    // re-subscribe from BM. A transient/non-404 failure still bails out so we never
    // create a duplicate of a subscription that may still exist.
    var staleWebhookDeleted = false;
    // forceRecreate (host/URL repoint) skips the activate-existing shortcut so we always go
    // through createSubscriptionWithRecovery, which deletes the same product+event webhook
    // (even one pointing at a different host) and recreates it for the current storefront.
    if (!forceRecreate && existingObj && existingObj.custom.WebhookId && existingObj.custom.WebhookUrl === webhookUrl) {
        var alreadyActive = false;
        var activationStatus = 0;
        activateSubscription(existingObj.custom.WebhookId, function (data, error) {
            // HTTP status arrives as the numeric `error` arg (dw.svc Result.error). Never read
            // response.statusCode — dw.svc.Result has no such property and accessing it throws.
            // A 404 here means the stored webhook was deleted in EBC, so the caller recreates.
            activationStatus = (typeof error === 'number') ? error : 0;
            if (error) Logger.error('activateSubscription failed for existing ' + configId + ' (' + existingObj.custom.WebhookId + '): ' + JSON.stringify(error));
            else alreadyActive = true;
        });
        if (alreadyActive) {
            return { success: true, alreadyExists: true, error: null };
        }
        if (activationStatus !== 404) {
            return { success: false, alreadyExists: true, error: 'ACTIVATION_ERROR' };
        }
        Logger.warn('Existing ' + configId + ' webhook ' + existingObj.custom.WebhookId + ' no longer exists at CyberSource (deleted in EBC); recreating subscription.');
        staleWebhookDeleted = true;
    }
    // Defer cleanup of any stale subscription until *after* the new one is active and persisted.
    // A webhook that 404s on re-activation is already gone, so there is nothing to clean up.
    var oldWebhookIdToCleanup = (!staleWebhookDeleted && existingObj && existingObj.custom.WebhookId) ? existingObj.custom.WebhookId : null;
    

    var securityKey = '';
    createSecurityKey(function (data, error) {
        if (error) Logger.error('createSecurityKey failed for ' + configId + ': ' + JSON.stringify(error));
        else if (data && data.status === 'SUCCESS') securityKey = data.keyInformation.key;
    });
    if (!securityKey) return { success: false, error: 'KEY_ERROR' };

    var webhookId = '';
    
    // Status reported by CyberSource on creation (e.g. ACTIVE or PENDING_REVIEW).
    var createdStatus = '';
    
    var specificError = null;

    apiClient.instance.callApi('/notification-subscriptions/v2/products/' + merchantId, 'GET', {}, {}, {}, {}, null, [], ['application/json;charset=utf-8'], ['application/json;charset=utf-8'], {}, function (prodData, prodError) {
        if (prodError) {
            Logger.error('Product list fetch failed for ' + configId + ': ' + JSON.stringify(prodError));
            specificError = 'API_ERROR';
            return;
        }
        var productList = Array.isArray(prodData) ? prodData : (prodData && prodData.products ? prodData.products : null);
        if (!productList) {
            specificError = 'API_ERROR';
            return;
        }
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
                            // Reconcile against any existing-but-untracked subscription (delete +
                            // recreate) instead of blindly creating, which CyberSource rejects
                            // with 400 "Record already exists".
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
                    // Reconcile against any existing-but-untracked subscription (delete + recreate)
                    // instead of blindly creating, which CyberSource rejects with 400 "Record
                    // already exists".
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
            if (!found) specificError = 'PRODUCT_NOT_ENABLED';
        }
    });

    if (specificError) return { success: false, error: specificError };
    if (!webhookId) return { success: false, error: 'API_ERROR' };

    
    // The subscription exists at CyberSource (we have a webhookId). ALWAYS attempt to activate it
    // (PUT status=ACTIVE) right after creation, then map it in BM so it is tracked and not
    // recreated as a duplicate on re-sync:
    //  - activation succeeds -> ACTIVE.
    //  - activation is rejected because it is awaiting CyberSource review -> record PENDING_REVIEW
    //    (it activates once approved and the merchant re-synchronizes).
    //  - any other activation failure -> bail out with ACTIVATION_ERROR.
    var finalStatus = createdStatus || '';
    if (finalStatus !== 'ACTIVE') {
        var activationSucceeded = false;
        activateSubscription(webhookId, function (data, error) {
            if (error) {
                Logger.error('activateSubscription failed for new ' + configId + ' (' + webhookId + '): ' + JSON.stringify(error));
            } else {
                activationSucceeded = true;
                finalStatus = (data && data.status) ? data.status : 'ACTIVE';
            }
        });
        if (!activationSucceeded && finalStatus !== 'PENDING_REVIEW') {
            return { success: false, error: 'ACTIVATION_ERROR' };
        }
    }
    if (!finalStatus) finalStatus = 'ACTIVE';

    Transaction.wrap(function () {
        var obj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId) || CustomObjectMgr.createCustomObject(CUSTOM_OBJECT_TYPE, configId);
        obj.custom.WebhookId = webhookId;
        obj.custom.SecurityKey = securityKey;
        obj.custom.WebhookUrl = webhookUrl;
        obj.custom.Status = finalStatus;
    });

    // New subscription is persisted — clean up the stale one only once the replacement is
    // ACTIVE, so a PENDING_REVIEW replacement doesn't leave the product with no live webhook.
    if (oldWebhookIdToCleanup && finalStatus === 'ACTIVE') {
        deleteSubscription(oldWebhookIdToCleanup, function (data, error) {
            if (error) Logger.error('Cleanup of stale webhook ' + oldWebhookIdToCleanup + ' for ' + configId + ' failed: ' + JSON.stringify(error));
        });
    }

    return { success: true, webhookId: webhookId, status: finalStatus, pendingReview: finalStatus === 'PENDING_REVIEW' };
    
}

function unsubscribeProduct(configId) {
    var obj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId);
    if (!obj || !obj.custom.WebhookId) return { success: true, alreadyRemoved: true };
    deleteSubscription(obj.custom.WebhookId, function (data, error) {
        if (error) Logger.error('deleteSubscription failed for ' + configId + ' (' + obj.custom.WebhookId + '): ' + JSON.stringify(error));
    });
    Transaction.wrap(function () { CustomObjectMgr.remove(obj); });
    return { success: true };
}

/**
 * Extract the lowercase hostname (no scheme, port, or path) from a URL string.
 *
 * @param {string} url full URL
 * @returns {string} hostname, or '' when not parseable
 */
function extractHost(url) {
    if (!url) return '';
    var s = String(url);
    var scheme = s.indexOf('://');
    if (scheme >= 0) s = s.substring(scheme + 3);
    var slash = s.indexOf('/');
    if (slash >= 0) s = s.substring(0, slash);
    var colon = s.indexOf(':');
    if (colon >= 0) s = s.substring(0, colon);
    return s.toLowerCase();
}

/**
 * Whether a reconciled subscription needs a sync action: it is missing, points at a different
 * host (sandbox moved), or exists but is not yet ACTIVE (e.g. INACTIVE) so it must be activated.
 * PENDING_REVIEW is excluded — only CyberSource can advance it (re-syncing after approval picks
 * it up via the not-ACTIVE check once it leaves review).
 *
 * @param {Object} sub reconciled subscription ({ webhookId, status, hostMismatch }) or null
 * @returns {boolean} true when subscribeProduct should run for this product
 */
function subscriptionNeedsAction(sub) {
    if (!sub) return true;
    if (sub.hostMismatch) return true;
    return !!(sub.status && sub.status !== 'ACTIVE' && sub.status !== 'PENDING_REVIEW');
}

/**
 * Consolidates all data needed for the Webhook Manager view
 */
function getViewData() {
    var site = Site.getCurrent();
    var method = site.getCustomPreferenceValue('VisaAcceptance_Secure_Integration_Method');
    var methodValue = (method && method.value) ? method.value : (method || '');
    var dmEnabled = site.getCustomPreferenceValue('VisaAcceptance_DecisionManager') || false;
    var egressMleAlias = site.getCustomPreferenceValue('VisaAcceptance_EgressCertificateAlias') || 'VisaAcceptance_MLE_Egress_Private_Key';

    var testAction = new URLAction('WebhookNotification-dmNotification', site.ID);
    var fullUrl = URLUtils.https(testAction).toString();
    var standardBaseUrl = fullUrl.substring(0, fullUrl.indexOf('WebhookNotification-dmNotification')).replace(/\/$/, '');

    var webhookBaseUrl = '';
    var egressPublicKey = '';
    try {
        var globalObj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration');
        if (globalObj) {
            webhookBaseUrl = globalObj.custom.BaseUrl || '';
            egressPublicKey = globalObj.custom.EgressPublicKey || '';
        }
    } catch (e) {}

    var data = {
        config: {
            dmEnabled: dmEnabled,
            secureIntegrationMethod: methodValue,
            webhookBaseUrl: webhookBaseUrl,
            egressMleAlias: egressMleAlias,
            egressPublicKey: egressPublicKey,
            standardBaseUrl: standardBaseUrl,
            activeBaseUrl: webhookBaseUrl || standardBaseUrl
        },
        subscriptions: {},
        external: []
    };

    // BM-managed products
    ['fraudManagement', 'unifiedCheckout'].forEach(function (productId) {
        try {
            var obj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, productId);
            
            // A record with no WebhookId is not a real subscription (e.g. left over from a
            // failed/partial attempt) — treat it as not subscribed so it renders inactive
            // and syncWithPreferences will re-create it instead of skipping it.
            data.subscriptions[productId] = (obj && obj.custom.WebhookId) ? { webhookId: obj.custom.WebhookId, status: obj.custom.Status } : null;
            
        } catch (e) { data.subscriptions[productId] = null; }
    });
    
    // Ask CyberSource which webhooks actually exist for each product, then:
    //  (a) reconcile our local record — if the stored webhookId is no longer present
    //      (e.g. the subscription was deleted directly in EBC) show the product as
    //      inactive/null so the merchant can re-subscribe from BM; and
    //  (b) surface any webhook that exists at CyberSource but isn't BM-managed as "external".
    // Fraud can be provisioned under either Decision Manager or Fraud Management Essentials,
    // so both product ids are queried to avoid a false "deleted" reconciliation.
    var discovery = [
        { key: 'fraudManagement', queryProducts: ['decisionManager', 'fraudManagementEssentials'] },
        { key: 'unifiedCheckout', queryProducts: ['unifiedCheckout'] }
    ];

    try {
        discovery.forEach(function (entry) {
            var liveWebhooks = {};
            var gotDefinitiveResponse = false;
            entry.queryProducts.forEach(function (queryProductId) {
                try {
                    retrieveWebhooks(queryProductId, function (apiData, error) {
                        if (error) {
                            Logger.error('External webhook discovery failed for ' + entry.key + ' (' + queryProductId + '): ' + JSON.stringify(error));
                            return;
                        }
                        if (!Array.isArray(apiData)) return;
                        // A successful response (including an empty list / 404) is authoritative.
                        gotDefinitiveResponse = true;
                        apiData.forEach(function (webhook) {
                            liveWebhooks[webhook.webhookId] = webhook;
                        });
                    });
                } catch (qe) {
                    // One product's lookup failing (e.g. not provisioned) must not abort discovery
                    // for the remaining products — otherwise reconciliation never runs.
                    Logger.error('getViewData: discovery query threw for ' + entry.key + ' (' + queryProductId + '): ' + (qe && qe.message ? qe.message : qe));
                }
            });

            // (a) Reconcile the BM-managed local record against live state. Only act on an
            //     authoritative response so a transient API failure can't wipe the view.
            if ((entry.key === 'fraudManagement' || entry.key === 'unifiedCheckout') &&
                gotDefinitiveResponse &&
                data.subscriptions[entry.key] && data.subscriptions[entry.key].webhookId) {
                var liveMatch = liveWebhooks[data.subscriptions[entry.key].webhookId];
                if (!liveMatch) {
                    Logger.warn('Local ' + entry.key + ' webhook ' + data.subscriptions[entry.key].webhookId + ' not found at CyberSource (deleted in EBC); showing as inactive.');
                    data.subscriptions[entry.key] = null;
                } else {
                    if (liveMatch.status) {
                        // Keep the displayed status in sync with CyberSource so a PENDING_REVIEW
                        // subscription flips to ACTIVE here once it has been approved.
                        data.subscriptions[entry.key].status = liveMatch.status;
                    }
                    // Detect a host change (e.g. the sandbox moved): the live webhook points at a
                    // different host than the current storefront. Flag it so syncWithPreferences
                    // repoints (delete + recreate) the subscription to this storefront's URL.
                    var currentHost = extractHost(data.config.activeBaseUrl);
                    var liveHost = extractHost(liveMatch.webhookUrl);
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
    var results = {};
    var fraud = data.subscriptions.fraudManagement;
    var uc = data.subscriptions.unifiedCheckout;

    // Subscribe/repoint/activate when the product is enabled and the subscription is missing,
    // points at a different host (sandbox moved -> delete+recreate), or is not yet ACTIVE
    // (e.g. INACTIVE -> activate the existing webhook).
    if (data.config.dmEnabled && subscriptionNeedsAction(fraud)) {
        results.dm = subscribeProduct('fraudManagement', !!(fraud && fraud.hostMismatch));
    } else if (!data.config.dmEnabled && fraud) {
        results.dm = unsubscribeProduct('fraudManagement');
    }
    if (data.config.secureIntegrationMethod === 'Unified_Checkout' && subscriptionNeedsAction(uc)) {
        results.uc = subscribeProduct('unifiedCheckout', !!(uc && uc.hostMismatch));
    } else if (data.config.secureIntegrationMethod !== 'Unified_Checkout' && uc) {
        results.uc = unsubscribeProduct('unifiedCheckout');
    }
    return results;
}

function updateAdvanced(baseUrl, egressMleAlias, egressPublicKey) {
    var site = Site.getCurrent();

    // Capture the previous BaseUrl *before* overwriting, so we can detect a rotation.
    // syncWithPreferences only acts on enable/disable deltas, so without this an
    // already-subscribed product would keep pointing at the old webhookUrl forever.
    var oldBaseUrl = '';
    try {
        var existingGlobal = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration');
        if (existingGlobal) oldBaseUrl = existingGlobal.custom.BaseUrl || '';
    } catch (e) {}
    var newBaseUrl = baseUrl || '';
    var baseUrlChanged = (oldBaseUrl !== newBaseUrl);

    
    // Derive the egress MLE public key from the .p12 keystore entry the merchant is saving,
    // rather than from a pasted string. Fall back to the incoming/previously-stored value so a
    // merchant whose key already works is never regressed if derivation fails.
    var effectiveAlias = egressMleAlias || 'VisaAcceptance_MLE_Egress_Private_Key';
    var derivedKey = deriveEgressCertificateB64(effectiveAlias);
    var keyToUse = derivedKey || egressPublicKey || '';

    // Register the public key with CyberSource KMS BEFORE persisting/subscribing, and capture
    // whether KMS accepted it (callApi fires its callback synchronously). We only treat the key
    // as usable when the upload succeeds, so the UC subscribe guard cannot pass with a key that
    // never reached KMS (which would make Response-MLE webhooks undecryptable).
    var egressUploadOk = false;
    if (keyToUse) {
        uploadAsymmetricKey(keyToUse, function (data, error) {
            if (error) Logger.error('Failed to upload Egress Public Key: ' + JSON.stringify(error));
            else egressUploadOk = true;
        });
    }

    Transaction.wrap(function () {
        try { site.setCustomPreferenceValue('VisaAcceptance_EgressCertificateAlias', effectiveAlias); } catch(e) { /* pref write is best-effort */ }
        try {
            var globalObj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration') || CustomObjectMgr.createCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration');
            globalObj.custom.BaseUrl = newBaseUrl;
            // Only persist the egress key when KMS accepted it; on failure leave any previously
            // working stored key untouched rather than clobbering it with an unusable value.
            if (egressUploadOk) {
                globalObj.custom.EgressPublicKey = keyToUse;
            }
        } catch(e) { /* custom-object access is best-effort */ }
    });

    // EgressPublicKey is now persisted (the transaction above has committed), so the UC subscribe
    // inside syncWithPreferences re-reads globalConfiguration and sees the freshly stored key.
    var results = syncWithPreferences();

    // Surface a KMS upload failure ONLY when we derived a fresh key from the .p12 and KMS rejected
    // it (a real misconfiguration). Re-uploading the fallback/previously-stored value is not worth
    // alarming on. The controller's generic failure handler turns this into an error banner.
    if (derivedKey && !egressUploadOk) {
        results.egressKey = { success: false, error: 'EGRESS_KEY_UPLOAD_FAILED' };
    }
    

    // BaseUrl rotation: subscribeProduct compares its newly-computed webhookUrl to the
    // persisted WebhookUrl and creates a fresh subscription (then cleans up the old
    // one) when they differ. Only invoke for products already subscribed — new
    // subscriptions were already handled by syncWithPreferences above.
    if (baseUrlChanged) {
        ['fraudManagement', 'unifiedCheckout'].forEach(function (configId) {
            try {
                var existing = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId);
                if (existing && existing.custom.WebhookId) {
                    results[configId + 'Rotation'] = subscribeProduct(configId);
                }
            } catch (e) {
                Logger.error('BaseUrl rotation failed for ' + configId + ': ' + e.message);
            }
        });
    }

    return results;
}

exports.retrieveWebhooks = retrieveWebhooks;
exports.subscribeFraudManagement = function() { return subscribeProduct('fraudManagement'); };
exports.unsubscribeFraudManagement = function() { return unsubscribeProduct('fraudManagement'); };
exports.subscribeUC = function() { return subscribeProduct('unifiedCheckout'); };
exports.unsubscribeUC = function() { return unsubscribeProduct('unifiedCheckout'); };
exports.getViewData = getViewData;
exports.syncWithPreferences = syncWithPreferences;
exports.updateAdvanced = updateAdvanced;
