'use strict';

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
    },
    tokenManagement: {
        name: 'Token Management',
        notificationEndpoint: 'WebhookNotification-tokenUpdate',
        products: [{ productId: 'tokenManagement', eventTypes: ['tms.networktoken.updated', 'tms.networktoken.provisioned'] }]
    }
};

function retrieveWebhooks(productId, callback) {
    var queryParams = { organizationId: merchantId, productId: productId };
    apiClient.instance.callApi('/notification-subscriptions/v2/webhooks', 'GET', {}, queryParams, {}, {}, null, [], ['application/json;charset=utf-8'], ['application/json;charset=utf-8'], {}, function(data, error, response) {
        if (error && response && response.statusCode === 404) {
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

function uploadAsymmetricKey(pubKey, callback) {
    if (!pubKey) {
        if (callback) callback({ status: 'SKIPPED' }, null);
        return;
    }
    var cleanPubKey = pubKey.replace(/\r\n/g, '\n').trim();
    var postBody = {
        clientRequestAction: 'CREATE',
        keyInformation: { 
            provider: 'nrtd', 
            tenant: merchantId, 
            keyType: 'RSA', 
            organizationId: merchantId,
            pub: cleanPubKey
        }
    };
    apiClient.instance.callApi('/kms/egress/v2/keys-asym', 'POST', {}, {}, {}, {}, postBody, [], ['application/json;charset=utf-8'], ['application/hal+json;charset=utf-8'], {}, callback);
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
            deactivateFlag: 'true',
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

function subscribeProduct(configId) {
    var config = WEBHOOK_CONFIGS[configId];
    var site = Site.getCurrent();
    
    var webhookBaseUrl = '';
    try {
        var globalObj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration');
        if (globalObj) webhookBaseUrl = globalObj.custom.BaseUrl;
    } catch (e) {}

    var webhookUrl = webhookBaseUrl ? (webhookBaseUrl.replace(/\/$/, '') + '/' + config.notificationEndpoint) : URLUtils.https(new URLAction(config.notificationEndpoint, site.ID)).toString();

    var existingObj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId);
    if (existingObj && existingObj.custom.WebhookId && existingObj.custom.WebhookUrl === webhookUrl) {
        activateSubscription(existingObj.custom.WebhookId, function() {});
        return { success: true, alreadyExists: true };
    }
    if (existingObj && existingObj.custom.WebhookId) deleteSubscription(existingObj.custom.WebhookId, function () {});

    var securityKey = '';
    createSecurityKey(function (data, error) { if (!error && data.status === 'SUCCESS') securityKey = data.keyInformation.key; });
    if (!securityKey) return { success: false, error: 'KEY_ERROR' };

    var webhookId = '';
    var specificError = null;
    
    apiClient.instance.callApi('/notification-subscriptions/v2/products/' + merchantId, 'GET', {}, {}, {}, {}, null, [], ['application/json;charset=utf-8'], ['application/json;charset=utf-8'], {}, function(prodData, prodError) {
        var productList = Array.isArray(prodData) ? prodData : (prodData && prodData.products ? prodData.products : null);
        if (!prodError && productList) {
            var found = false;
            if (configId === 'fraudManagement') {
                for (var i = 0; i < productList.length; i++) {
                    var availableProd = productList[i].productId;
                    if (availableProd === 'decisionManager' || availableProd === 'fraudManagementEssentials') {
                        for (var j = 0; j < config.products.length; j++) {
                            if (config.products[j].productId === availableProd) {
                                var originalProducts = config.products;
                                config.products = [config.products[j]];
                                createSubscription(config, webhookUrl, function (data, error) { if (!error && data.webhookId) webhookId = data.webhookId; });
                                config.products = originalProducts;
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
                        createSubscription(config, webhookUrl, function (data, error) { if (!error && data.webhookId) webhookId = data.webhookId; });
                        break;
                    }
                }
                if (!found) specificError = 'PRODUCT_NOT_ENABLED';
            }
        } else {
            specificError = 'API_ERROR';
        }
    });

    if (specificError) return { success: false, error: specificError };
    if (!webhookId) return { success: false, error: 'API_ERROR' };

    var activationSuccess = false;
    activateSubscription(webhookId, function(data, error) { if (!error) activationSuccess = true; });
    if (!activationSuccess) return { success: false, error: 'ACTIVATION_ERROR' };

    Transaction.wrap(function () {
        var obj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId) || CustomObjectMgr.createCustomObject(CUSTOM_OBJECT_TYPE, configId);
        obj.custom.WebhookId = webhookId;
        obj.custom.SecurityKey = securityKey;
        obj.custom.WebhookUrl = webhookUrl;
        obj.custom.Status = 'ACTIVE';
    });
    return { success: true, webhookId: webhookId };
}

function unsubscribeProduct(configId) {
    var obj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId);
    if (!obj || !obj.custom.WebhookId) return { success: true, alreadyRemoved: true };
    deleteSubscription(obj.custom.WebhookId, function () {});
    Transaction.wrap(function () { CustomObjectMgr.remove(obj); });
    return { success: true };
}

/**
 * Consolidates all data needed for the Webhook Manager view
 */
function getViewData() {
    var site = Site.getCurrent();
    var method = site.getCustomPreferenceValue('VisaAcceptance_Secure_Integration_Method');
    var methodValue = (method && method.value) ? method.value : (method || '');
    var dmEnabled = site.getCustomPreferenceValue('Cybersource_DecisionManager') || false;
    var ntEnabled = site.getCustomPreferenceValue('Cybersource_NetworkToken') || false;
    var egressMleAlias = site.getCustomPreferenceValue('Cybersource_EgressCertificateAlias') || 'Cybersource_MLE_Egress_Private_Key';
    
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
            ntEnabled: ntEnabled,
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

    var products = ['fraudManagement', 'unifiedCheckout', 'tokenManagement'];
    products.forEach(function (productId) {
        try {
            var obj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, productId);
            data.subscriptions[productId] = obj ? { webhookId: obj.custom.WebhookId, status: obj.custom.Status } : null;
        } catch (e) { data.subscriptions[productId] = null; }
    });

    try {
        products.forEach(function (productId) {
            retrieveWebhooks(productId === 'fraudManagement' ? 'decisionManager' : productId, function (apiData, error) {
                if (!error && apiData) {
                    apiData.forEach(function (webhook) {
                        var isInternal = false;
                        Object.keys(data.subscriptions).forEach(function (key) {
                            if (data.subscriptions[key] && data.subscriptions[key].webhookId === webhook.webhookId) isInternal = true;
                        });
                        if (!isInternal) data.external.push({ productId: productId, webhookId: webhook.webhookId, url: webhook.webhookUrl });
                    });
                }
            });
        });
    } catch (e) {}
    return data;
}

function syncWithPreferences() {
    var data = getViewData();
    var results = {};
    if (data.config.dmEnabled && !data.subscriptions.fraudManagement) {
        results.dm = subscribeProduct('fraudManagement');
    } else if (!data.config.dmEnabled && data.subscriptions.fraudManagement) {
        results.dm = unsubscribeProduct('fraudManagement');
    }
    if (data.config.secureIntegrationMethod === 'Unified_Checkout' && !data.subscriptions.unifiedCheckout) {
        results.uc = subscribeProduct('unifiedCheckout');
    } else if (data.config.secureIntegrationMethod !== 'Unified_Checkout' && data.subscriptions.unifiedCheckout) {
        results.uc = unsubscribeProduct('unifiedCheckout');
    }
    if (data.config.ntEnabled && !data.subscriptions.tokenManagement) {
        results.nt = subscribeProduct('tokenManagement');
    } else if (!data.config.ntEnabled && data.subscriptions.tokenManagement) {
        results.nt = unsubscribeProduct('tokenManagement');
    }
    return results;
}

function updateAdvanced(baseUrl, egressMleAlias, egressPublicKey) {
    var site = Site.getCurrent();
    Transaction.wrap(function () {
        try { site.setCustomPreferenceValue('Cybersource_EgressCertificateAlias', egressMleAlias || 'Cybersource_MLE_Egress_Private_Key'); } catch(e) {}
        try {
            var globalObj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration') || CustomObjectMgr.createCustomObject(CUSTOM_OBJECT_TYPE, 'globalConfiguration');
            globalObj.custom.BaseUrl = baseUrl || '';
            globalObj.custom.EgressPublicKey = egressPublicKey || '';
        } catch(e) {}
    });

    uploadAsymmetricKey(egressPublicKey, function(data, error) {
        if (error) Logger.error('Failed to upload Egress Public Key: ' + JSON.stringify(error));
    });

    return syncWithPreferences();
}

exports.retrieveWebhooks = retrieveWebhooks;
exports.subscribeFraudManagement = function() { return subscribeProduct('fraudManagement'); };
exports.unsubscribeFraudManagement = function() { return unsubscribeProduct('fraudManagement'); };
exports.subscribeUC = function() { return subscribeProduct('unifiedCheckout'); };
exports.unsubscribeUC = function() { return unsubscribeProduct('unifiedCheckout'); };
exports.subscribeNetworkTokens = function() { return subscribeProduct('tokenManagement'); };
exports.unsubscribeNetworkTokens = function() { return unsubscribeProduct('tokenManagement'); };
exports.getViewData = getViewData;
exports.syncWithPreferences = syncWithPreferences;
exports.updateAdvanced = updateAdvanced;
